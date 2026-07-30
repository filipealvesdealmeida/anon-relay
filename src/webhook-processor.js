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
      // Em lote, como o applyMetaStatusBatch do sistema principal: a Meta
      // agrupa centenas de statuses por webhook, e resolver + incrementar um a
      // um seriam centenas de idas ao Redis. Aqui é uma resolução em pipeline
      // e um incremento por (disparo, campo).
      const statuses = value.statuses || [];
      if (statuses.length) {
        const resolvidos = await store.resolveMessages(statuses.map((st) => wamidKey(st.id || '')));
        const porJob = new Map(); // jobId -> { delivered, read, failed, erros: [] }

        statuses.forEach((st, i) => {
          const jobId = resolvidos[i];
          if (!jobId) {
            counts.ignorados++;
            return;
          }
          const status = String(st.status || '').toLowerCase();
          if (!['delivered', 'read', 'failed'].includes(status)) return;

          if (!porJob.has(jobId)) porJob.set(jobId, { delivered: 0, read: 0, failed: 0, erros: [] });
          const acc = porJob.get(jobId);
          acc[status]++;
          if (status === 'failed') acc.erros.push(st.errors?.[0]?.code);
          counts.statuses++;
        });

        for (const [jobId, acc] of porJob) {
          await store.incrJobFields(jobId, {
            delivered: acc.delivered,
            read: acc.read,
            failed: acc.failed,
          });
          for (const code of acc.erros) await store.recordError(jobId, code);
        }
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
