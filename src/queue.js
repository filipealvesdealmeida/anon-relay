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
 * Token bucket por sender, com fila de espera ordenada por prioridade.
 *
 * O limite pertence ao NÚMERO, não ao fluxo. Disparo e resposta automática
 * saem pelo mesmo número e disputam o mesmo balde — é assim que tem que ser:
 * a Meta conta as duas coisas juntas, e estourar o limite prejudica a
 * reputação do número independentemente de qual fluxo causou.
 *
 * A prioridade existe porque as duas coisas não são igualmente urgentes:
 * resposta a alguém que acabou de escrever é conversa em andamento; mensagem
 * de disparo pode esperar dois segundos. Sem isso, uma pessoa que respondeu
 * ficaria na fila atrás de 5.000 mensagens frias.
 */
class TokenBucket {
  constructor(ratePerSecond) {
    this.rate = ratePerSecond;
    this.tokens = ratePerSecond;
    this.last = Date.now();
    this.waiters = []; // { prioridade, seq, resolve }
    this.seq = 0;
    this.timer = null;
  }

  _refill() {
    const agora = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((agora - this.last) / 1000) * this.rate);
    this.last = agora;
  }

  _serve() {
    this._refill();
    // Maior prioridade primeiro; empate resolve por ordem de chegada.
    this.waiters.sort((a, b) => b.prioridade - a.prioridade || a.seq - b.seq);
    while (this.tokens >= 1 && this.waiters.length) {
      this.tokens -= 1;
      this.waiters.shift().resolve();
    }
    if (this.waiters.length && !this.timer) {
      const esperaMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      // Sem unref() de propósito: enquanto houver envio esperando permissão, o
      // processo precisa continuar vivo. O timer só existe quando há fila e
      // morre sozinho quando ela esvazia.
      this.timer = setTimeout(() => {
        this.timer = null;
        this._serve();
      }, esperaMs);
    }
  }

  /**
   * Espera permissão para mais um envio.
   * @param {number} prioridade 0 = disparo, 1 = resposta em conversa aberta
   */
  take(prioridade = 0) {
    this._refill();
    if (this.tokens >= 1 && !this.waiters.length) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ prioridade, seq: this.seq++, resolve });
      this._serve();
    });
  }
}

/**
 * Um balde por número, compartilhado por todo o processo. É o que garante que
 * disparo e automação não somem esforços para estourar o limite do mesmo
 * número.
 */
const baldes = new Map(); // senderId -> TokenBucket

function senderBucket(senderId, ratePerSecond) {
  let b = baldes.get(senderId);
  if (!b) {
    b = new TokenBucket(ratePerSecond);
    baldes.set(senderId, b);
  } else if (ratePerSecond && b.rate !== ratePerSecond) {
    // O disparo pode pedir um ritmo diferente; o balde acompanha.
    b.rate = ratePerSecond;
  }
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Executa UM envio com as mesmas garantias da fila: espera o balde do número,
 * repete erro transitório com backoff exponencial e jitter, desiste de erro de
 * validação.
 *
 * É este o caminho comum entre o disparo e a resposta automática. Antes só o
 * disparo tinha essas garantias, e uma enxurrada de respostas simultâneas saía
 * sem controle nenhum pelo mesmo número.
 *
 * @param {Function} fn async () => { ok, status?, code?, retryable? }
 */
async function sendWithRetry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts || 5);
  const backoffMs = opts.backoffMs || 2000;
  const bucket = opts.bucket || null;
  const prioridade = opts.prioridade || 0;
  const shouldStop = opts.shouldStop || (() => false);

  let resultado = null;
  let retries = 0;

  for (let tentativa = 1; tentativa <= attempts; tentativa++) {
    if (shouldStop()) break;
    if (bucket) await bucket.take(prioridade);

    try {
      resultado = await fn();
    } catch (err) {
      resultado = { ok: false, status: null, code: null, errorMessage: err.message };
    }

    if (resultado.ok) break;

    const podeRepetir =
      resultado.retryable !== undefined ? resultado.retryable : isRetryable(resultado);
    if (!podeRepetir || tentativa === attempts) break;

    retries++;
    // Jitter: sem ele, tudo que tomou 429 junto volta junto e toma 429 de novo.
    const base = backoffMs * 2 ** (tentativa - 1);
    await sleep(Math.round(base * (0.75 + Math.random() * 0.5)));
  }

  return { resultado, retries };
}

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
  // Balde do número, compartilhado com a resposta automática do mesmo número.
  const bucket = opts.senderId
    ? senderBucket(opts.senderId, Math.max(1, opts.ratePerSecond || 12))
    : new TokenBucket(Math.max(1, opts.ratePerSecond || 12));
  const onResult = opts.onResult || (() => {});
  const shouldStop = opts.shouldStop || (() => false);

  const stats = { processed: 0, ok: 0, failed: 0, retries: 0 };
  let cursor = 0;

  async function executor() {
    for (;;) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;

      const item = items[i];
      items[i] = null; // some da fila antes do primeiro await
      if (!item) continue;

      // Disparo entra com prioridade 0: cede a vez para conversa em andamento.
      const { resultado, retries } = await sendWithRetry(() => handler(item), {
        attempts,
        backoffMs,
        bucket,
        prioridade: 0,
        shouldStop,
      });
      stats.retries += retries;

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

module.exports = {
  runQueue,
  sendWithRetry,
  senderBucket,
  isRetryable,
  TokenBucket,
  RETRY_CODES,
  baldes,
};
