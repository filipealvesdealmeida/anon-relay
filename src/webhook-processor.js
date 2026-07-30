'use strict';

/**
 * Processamento dos eventos da Meta — o trecho mais importante do repositorio.
 *
 * Esta funcao e pura em relacao ao transporte: recebe o payload ja parseado e
 * nao sabe nada de HTTP. Ela existe separada do handler exatamente pra poder
 * ser lida e testada isolada — test/no-retention.test.js roda os eventos reais
 * por aqui e depois varre o armazenamento inteiro.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * O payload da Meta CONTEM telefone em texto puro:
 *
 *   statuses[].recipient_id  -> numero de quem recebeu
 *   messages[].from          -> numero de quem respondeu
 *
 * O que este codigo faz com cada um:
 *
 *   recipient_id  ->  NAO E LIDO. Nem uma vez. O disparo e identificado pelo
 *                     HMAC do wamid, indexado no momento do envio.
 *   from          ->  vira hash e entra num HyperLogLog (conta quantos
 *                     responderam, sem registrar quem); se for pedido de
 *                     descadastro, vira hash na lista de supressao.
 *
 * A variavel com o numero morre no fim da iteracao. Nao ha store.set com ela,
 * nao ha log dela, nao ha retorno contendo ela.
 * ────────────────────────────────────────────────────────────────────────────
 */

const store = require('./store');
const dispatch = require('./dispatch');
const automation = require('./automation');
const meta = require('./meta');
const log = require('./logging');
const { wamidKey } = require('./hashing');
const { isOptOut } = require('./optout');

async function processWebhookPayload(body) {
  const counts = { statuses: 0, respostas: 0, descadastros: 0, automacoes: 0, ignorados: 0 };
  if (body?.object !== 'whatsapp_business_account') return counts;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const senderId = value.metadata?.phone_number_id;

      // ── Status: entregue / lida / falhou ────────────────────────────────
      for (const st of value.statuses || []) {
        const jobId = await store.resolveMessage(wamidKey(st.id || ''));
        if (!jobId) {
          counts.ignorados++;
          continue;
        }
        const status = String(st.status || '').toLowerCase();
        if (status === 'delivered') await store.incrJob(jobId, 'delivered', 1);
        else if (status === 'read') await store.incrJob(jobId, 'read', 1);
        else if (status === 'failed') {
          await store.incrJob(jobId, 'failed', 1);
          await store.recordError(jobId, st.errors?.[0]?.code);
        } else continue;
        counts.statuses++;
      }

      // ── Inbound: alguem respondeu ───────────────────────────────────────
      for (const m of value.messages || []) {
        const from = m.from; // telefone — usado so pra derivar hash, abaixo
        if (!from) continue;

        // Preferencia 1: a resposta cita a mensagem original (botao ou reply).
        // Resolve o disparo sem consulta alguma por numero.
        let jobId = m.context?.id ? await store.resolveMessage(wamidKey(m.context.id)) : null;
        // Preferencia 2: o numero remetente esta reservado a um disparo.
        if (!jobId && senderId) jobId = await store.resolveSenderJob(senderId);
        if (!jobId) {
          counts.ignorados++;
          continue;
        }

        await dispatch.registerResponder(jobId, from);
        counts.respostas++;

        const isButton = !!(m.button || m.interactive?.button_reply);
        const text =
          m.text?.body ||
          m.button?.text ||
          m.interactive?.button_reply?.title ||
          m.interactive?.list_reply?.title ||
          '';

        if (isOptOut(text)) {
          await dispatch.registerOptOut(jobId, from);
          counts.descadastros++;
          // Quem pediu para sair não recebe resposta automática. O silêncio é a
          // resposta correta.
          continue;
        }

        // ── Resposta automática ─────────────────────────────────────────────
        // A automação pertence ao disparo. `from` entra no fluxo pelo closure e
        // morre com ele — nada é gravado para isto funcionar.
        const job = await store.getJob(jobId);
        const config = store.parseAutomation(job);
        if (config && automation.matches(config, { text, isButton })) {
          const sender = meta.senderById(senderId);
          if (sender) {
            counts.automacoes++;
            // Solto de propósito: o handler já respondeu 200 e os passos podem
            // ter atraso entre si.
            automation
              .run(jobId, sender, from, config)
              .catch((err) => log.error('automacao falhou', { jobId, message: err.message }));
          }
        }
      }
    }
  }

  if (counts.statuses || counts.respostas) {
    log.info('webhook processado', counts);
  }
  return counts;
}

module.exports = { processWebhookPayload };
