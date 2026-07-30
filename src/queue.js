'use strict';

/**
 * Fila de envio — mesmas políticas do BullMQ, sem a persistência.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POR QUE NÃO USAR BULLMQ AQUI
 * ────────────────────────────────────────────────────────────────────────────
 * O sistema principal usa BullMQ e está certo em usar: retry com backoff,
 * rate limit por número, concorrência alta, jobs que sobrevivem a restart.
 *
 * Só que BullMQ é uma fila PERSISTIDA. Cada job vira uma chave no Redis com o
 * payload inteiro dentro — e o payload de um envio contém o telefone do
 * destinatário. No sistema principal isso é irrelevante (o telefone já está no
 * Mongo). Aqui seria o fim da promessa: a lista completa ficaria gravada em
 * `bull:bulk-send:*` por dias, e /privacy/scan acusaria na primeira varredura.
 *
 * Então a fila mora na memória. O que este arquivo faz é trazer, uma a uma, as
 * garantias que a fila persistida dava:
 *
 *   BullMQ (scale)                     aqui
 *   ─────────────────────────────      ─────────────────────────────────────
 *   attempts: 5                        mesmo padrão, configurável
 *   backoff exponencial 2s→32s         mesmo, com jitter
 *   limiter por groupKey: 'sender'     token bucket por sender
 *   concurrency: 50 por worker         pool de N executores
 *   isRetryableError()                 mesma política de códigos
 *   sobrevive a restart                NÃO — e é de propósito
 *
 * A última linha é a única diferença que não dá para eliminar. Ela é a própria
 * definição do produto: fila que sobrevive a restart é fila gravada em disco.
 */

const log = require('./logging');

/** Mesma política do sistema principal (lib/sender.js isRetryableError). */
const RETRY_CODES = [130429, 131048, 368, 1, 2, 4];

function isRetryable({ status, code }) {
  if (status == null) return true; // sem resposta = problema de rede
  if (status >= 500 || status === 429) return true;
  if (code != null && RETRY_CODES.includes(Number(code))) return true;
  return false; // 4xx de validação: template inválido, número inválido, opt-out
}

/**
 * Token bucket por sender. Mantém a taxa mesmo quando a latência da Meta varia —
 * diferente de "dispare N e espere o segundo acabar", que perde vazão sempre que
 * uma requisição demora.
 */
class TokenBucket {
  constructor(ratePerSecond) {
    this.rate = ratePerSecond;
    this.tokens = ratePerSecond;
    this.last = Date.now();
  }

  /** Espera até ter permissão para mais um envio. */
  async take() {
    for (;;) {
      const agora = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((agora - this.last) / 1000) * this.rate);
      this.last = agora;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const esperaMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      await new Promise((r) => setTimeout(r, Math.max(5, esperaMs)));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Executa uma lista de itens com concorrência, rate limit e retry.
 *
 * O array `items` é CONSUMIDO: cada posição é zerada assim que sai da fila, e o
 * item é apagado quando termina. Nenhuma referência sobra depois do envio.
 *
 * @param {Array}    items    itens a processar (serão destruídos)
 * @param {Function} handler  async (item) => { ok, retryable?, status?, code? }
 * @param {Object}   opts     { concurrency, ratePerSecond, attempts, backoffMs, onResult, shouldStop }
 * @returns {Promise<{processed, ok, failed, retries}>}
 */
async function runQueue(items, handler, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 20);
  const attempts = Math.max(1, opts.attempts || 5);
  const backoffMs = opts.backoffMs || 2000;
  const bucket = new TokenBucket(Math.max(1, opts.ratePerSecond || 12));
  const onResult = opts.onResult || (() => {});
  const shouldStop = opts.shouldStop || (() => false);

  const stats = { processed: 0, ok: 0, failed: 0, retries: 0 };
  let cursor = 0;

  /**
   * Backoff exponencial com jitter. O jitter existe porque sem ele todas as
   * mensagens que tomaram 429 juntas voltam juntas — e tomam 429 de novo.
   */
  function esperaDaTentativa(tentativa) {
    const base = backoffMs * 2 ** (tentativa - 1);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  async function executor() {
    for (;;) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;

      const item = items[i];
      items[i] = null; // some da fila antes do primeiro await
      if (!item) continue;

      let resultado = null;
      for (let tentativa = 1; tentativa <= attempts; tentativa++) {
        if (shouldStop()) return;
        await bucket.take();

        try {
          resultado = await handler(item);
        } catch (err) {
          resultado = { ok: false, status: null, code: null, errorMessage: err.message };
        }

        if (resultado.ok) break;

        const podeRepetir =
          resultado.retryable !== undefined ? resultado.retryable : isRetryable(resultado);
        if (!podeRepetir || tentativa === attempts) break;

        stats.retries++;
        await sleep(esperaDaTentativa(tentativa));
      }

      stats.processed++;
      if (resultado?.ok) stats.ok++;
      else stats.failed++;

      try {
        await onResult(resultado, item);
      } catch (err) {
        log.error('falha ao registrar resultado', { message: err.message });
      }

      // Última referência ao conteúdo do item.
      for (const k of Object.keys(item)) item[k] = null;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, executor));
  items.length = 0;
  return stats;
}

module.exports = { runQueue, isRetryable, TokenBucket, RETRY_CODES };
