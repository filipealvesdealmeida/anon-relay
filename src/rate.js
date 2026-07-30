'use strict';

/**
 * Teto de segurança por número.
 *
 * O controle de vazão principal é de quem enfileira (o limiter por sender do
 * BullMQ, no sistema que opera os disparos). Este balde aqui é a última
 * barreira, e existe por um motivo específico: este processo é o único ponto
 * que enxerga TODO o tráfego de um número — disparo em massa e resposta
 * automática de conversa, que saem de filas diferentes e não se enxergam.
 *
 * A Meta conta as duas coisas juntas. Estourar o limite prejudica a reputação
 * do número independentemente de qual fluxo causou.
 *
 * A prioridade existe porque as duas não são igualmente urgentes: resposta a
 * quem acabou de escrever é conversa em andamento; mensagem de disparo pode
 * esperar dois segundos.
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
      // processo precisa continuar vivo.
      this.timer = setTimeout(() => {
        this.timer = null;
        this._serve();
      }, esperaMs);
    }
  }

  /** @param {number} prioridade 0 = disparo, 1 = resposta em conversa aberta */
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

const baldes = new Map(); // senderId -> TokenBucket

function senderBucket(senderId, ratePerSecond) {
  let b = baldes.get(senderId);
  if (!b) {
    b = new TokenBucket(ratePerSecond);
    baldes.set(senderId, b);
  }
  return b;
}

module.exports = { TokenBucket, senderBucket, baldes };
