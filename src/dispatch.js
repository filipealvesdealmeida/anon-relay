'use strict';

/**
 * Despachante — envia o lote e esquece cada numero imediatamente.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * O CICLO DE VIDA DE UM NUMERO NESTE SERVICO
 * ────────────────────────────────────────────────────────────────────────────
 *   1. chega como texto no corpo do request  (memoria do processo)
 *   2. e normalizado e conferido contra a supressao  (memoria)
 *   3. entra na fila do disparo  (memoria)
 *   4. e enviado pra Meta  (unica saida legitima)
 *   5. a posicao dele na fila e sobrescrita por null  (some do heap)
 *   6. do envio sobra HMAC(wamid) -> jobId  (irreversivel)
 *
 * Em nenhum ponto ele toca disco, banco, log ou resposta HTTP.
 *
 * CONSEQUENCIA ASSUMIDA: se o processo reiniciar no meio de um disparo, o que
 * faltava enviar se perde — nao existe fila persistente pra retomar, porque
 * uma fila persistente seria exatamente a copia dos numeros que prometemos nao
 * manter. O painel avisa isso antes de comecar.
 */

const store = require('./store');
const meta = require('./meta');
const log = require('./logging');
const csvLib = require('./csv');
const { runQueue } = require('./queue');
const { wamidKey, phoneKey, optOutKey } = require('./hashing');
const config = require('./config');

/** Jobs vivos neste processo. Nunca contem telefone apos o envio da posicao. */
const active = new Map();

function jobState(jobId) {
  const s = active.get(jobId);
  if (!s) return null;
  return {
    jobId,
    total: s.total,
    processed: s.processed,
    sent: s.sent,
    failed: s.failed,
    cancelled: s.cancelled,
    running: s.running,
  };
}

function cancel(jobId) {
  const s = active.get(jobId);
  if (!s) return false;
  s.cancelled = true;
  return true;
}

/**
 * Dispara o lote. Nao e await-ado pelo handler HTTP: a resposta sai na hora
 * com o jobId e o progresso e consultado pelo relatorio.
 *
 * @param {string} jobId
 * @param {Object} sender  { id, label, token }
 * @param {Array}  queue   [{ phone, variables }] — CONSUMIDO E DESTRUIDO
 * @param {Object} spec    { templateName, language, headerType, headerMediaUrl, buttonUrlParam, ratePerSecond }
 */
async function run(jobId, sender, queue, spec) {
  const rate = Math.max(1, Math.min(spec.ratePerSecond || config.dispatch.ratePerSecond, 80));
  const state = {
    total: queue.length,
    processed: 0,
    sent: 0,
    failed: 0,
    cancelled: false,
    running: true,
    startedAt: Date.now(),
  };
  active.set(jobId, state);

  await store.setJobStatus(jobId, 'sending', { startedAt: String(state.startedAt) });
  log.info('disparo iniciado', {
    jobId,
    sender: sender.id,
    total: state.total,
    rate,
    concorrencia: config.dispatch.concurrency,
    tentativas: config.dispatch.attempts,
  });

  // Escritas no Redis são agregadas: um HINCRBY a cada lote, não um por
  // mensagem. Mesma ideia do applyMetaStatusBatch do sistema principal.
  let pendingLinks = [];
  let pendingSent = 0;
  let pendingFailed = 0;

  async function flush() {
    const links = pendingLinks;
    const s = pendingSent;
    const f = pendingFailed;
    pendingLinks = [];
    pendingSent = 0;
    pendingFailed = 0;
    const tarefas = [];
    if (links.length) tarefas.push(store.linkMessageBatch(links));
    if (s) tarefas.push(store.incrJob(jobId, 'sent', s));
    if (f) tarefas.push(store.incrJob(jobId, 'failed', f));
    if (tarefas.length) await Promise.all(tarefas);
  }

  const flushTimer = setInterval(() => {
    flush().catch((err) => log.error('flush falhou', { jobId, message: err.message }));
  }, 1000);
  flushTimer.unref();

  const stats = await runQueue(
    queue,
    // Handler de uma mensagem. O retorno diz à fila se vale repetir.
    async (item) => {
      const r = await meta.sendTemplate(sender, {
        to: item.phone,
        templateName: spec.templateName,
        language: spec.language,
        variables: item.variables,
        headerType: spec.headerType,
        headerMediaUrl: spec.headerMediaUrl,
        buttonUrlParam: spec.buttonUrlParam,
      });
      // A referência ao wamid precisa sobreviver ao handler; o telefone, não.
      return r.ok ? { ok: true, wamid: r.wamid } : { ...r, phone: item.phone };
    },
    {
      concurrency: config.dispatch.concurrency,
      // O balde é do número, não deste disparo: a resposta automática que sair
      // por ele durante o envio disputa o mesmo limite (com prioridade maior).
      senderId: sender.id,
      ratePerSecond: rate,
      attempts: config.dispatch.attempts,
      backoffMs: config.dispatch.backoffMs,
      shouldStop: () => state.cancelled,
      onResult: async (result) => {
        state.processed++;
        if (result?.ok) {
          state.sent++;
          pendingSent++;
          pendingLinks.push([wamidKey(result.wamid), jobId]);
        } else {
          state.failed++;
          pendingFailed++;
          await store.recordError(jobId, result?.errorCode);
          // Número que a Meta declara incapaz de receber entra na supressão —
          // em forma de hash, como todo o resto.
          if (result?.phone && ['131026', '131052', '470'].includes(String(result.errorCode))) {
            await store.suppress(optOutKey(result.phone));
          }
          if (result) result.phone = null;
        }
      },
    }
  );

  clearInterval(flushTimer);
  await flush();
  state.running = false;
  if (stats.retries) log.info('tentativas repetidas', { jobId, retries: stats.retries });

  const status = state.cancelled ? 'cancelled' : 'sent';
  await store.setJobStatus(jobId, status, {
    finishedAt: String(Date.now()),
    sent: String(state.sent),
    failed: String(state.failed),
  });

  log.info('disparo concluido', {
    jobId,
    status,
    sent: state.sent,
    failed: state.failed,
    durationSec: Math.round((Date.now() - state.startedAt) / 1000),
  });

  // Libera a fila inteira e o estado local.
  queue.length = 0;
  setTimeout(() => active.delete(jobId), 60_000);
}

/**
 * Prepara o lote: normaliza, remove duplicado/invalido, aplica supressao.
 * Recebe e devolve dados em memoria; nada aqui persiste destinatario.
 */
async function prepare(rows, mapping) {
  const hashes = rows.map((r) => optOutKey(r.phone));
  const suppressed = await store.filterSuppressed(hashes);

  const queue = [];
  let skippedSuppressed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (suppressed.has(hashes[i])) {
      skippedSuppressed++;
      continue;
    }
    queue.push({
      phone: rows[i].phone,
      variables: csvLib.resolveVariables(mapping, rows[i]),
    });
  }
  return { queue, skippedSuppressed };
}

/** Registra uma resposta. Recebe o telefone so pra derivar o hash e descarta. */
async function registerResponder(jobId, phone) {
  await store.recordResponder(jobId, phoneKey(phone));
}

async function registerOptOut(jobId, phone) {
  await store.suppress(optOutKey(phone));
  await store.incrJob(jobId, 'optout', 1);
}

module.exports = { run, prepare, cancel, jobState, active, registerResponder, registerOptOut };
