'use strict';

/**
 * A fila em memória precisa dar as mesmas garantias que o BullMQ dá no sistema
 * principal — menos a persistência, que é justamente o que não pode existir
 * aqui. Este teste cobre uma a uma.
 */

process.env.REDIS_PREFIX = (process.env.REDIS_PREFIX || 'anontest:').replace(/:$/, '') + '-queue:';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { runQueue, isRetryable, TokenBucket } = require('../src/queue');

// ── Política de retry (mesma tabela do lib/sender.js do scale) ─────────────

test('classifica erro repetivel igual ao sistema principal', () => {
  assert.equal(isRetryable({ status: 500 }), true, '5xx repete');
  assert.equal(isRetryable({ status: 429 }), true, 'rate limit repete');
  assert.equal(isRetryable({ status: null }), true, 'sem resposta = rede, repete');
  assert.equal(isRetryable({ status: 400, code: 130429 }), true, 'rate limit da Meta repete');
  assert.equal(isRetryable({ status: 400, code: 131048 }), true, 'spam rate limit repete');

  assert.equal(isRetryable({ status: 400, code: 131026 }), false, 'numero invalido nao repete');
  assert.equal(isRetryable({ status: 400, code: 132000 }), false, 'template invalido nao repete');
  assert.equal(isRetryable({ status: 403 }), false);
});

// ── Retry com backoff ──────────────────────────────────────────────────────

test('repete erro transitorio e desiste do permanente', async () => {
  const tentativasPorItem = new Map();

  const items = [
    { id: 'transitorio' }, // falha 2x, passa na 3a
    { id: 'permanente' }, // 4xx de validação: uma tentativa só
    { id: 'sempre-falha' }, // 5xx sempre: esgota as tentativas
  ];

  const stats = await runQueue(
    items,
    async (item) => {
      const n = (tentativasPorItem.get(item.id) || 0) + 1;
      tentativasPorItem.set(item.id, n);
      if (item.id === 'transitorio') return n < 3 ? { ok: false, status: 500 } : { ok: true };
      if (item.id === 'permanente') return { ok: false, status: 400, code: 131026 };
      return { ok: false, status: 503 };
    },
    { concurrency: 3, ratePerSecond: 1000, attempts: 3, backoffMs: 5 }
  );

  assert.equal(tentativasPorItem.get('transitorio'), 3, 'repetiu ate dar certo');
  assert.equal(tentativasPorItem.get('permanente'), 1, 'erro de validacao nao repete');
  assert.equal(tentativasPorItem.get('sempre-falha'), 3, 'parou no teto de tentativas');

  assert.equal(stats.processed, 3);
  assert.equal(stats.ok, 1);
  assert.equal(stats.failed, 2);
  assert.equal(stats.retries, 4, '2 do transitorio + 2 do sempre-falha');
});

test('excecao no handler tambem repete', async () => {
  let n = 0;
  const stats = await runQueue(
    [{ id: 1 }],
    async () => {
      n++;
      if (n < 2) throw new Error('conexao caiu');
      return { ok: true };
    },
    { concurrency: 1, ratePerSecond: 1000, attempts: 3, backoffMs: 5 }
  );
  assert.equal(n, 2);
  assert.equal(stats.ok, 1);
});

// ── Rate limit ─────────────────────────────────────────────────────────────

test('respeita a taxa por segundo', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i }));
  const t0 = Date.now();
  await runQueue(items, async () => ({ ok: true }), {
    concurrency: 12,
    ratePerSecond: 10,
    attempts: 1,
  });
  const decorrido = Date.now() - t0;
  // 12 envios a 10/s: o bucket começa cheio (10), os 2 últimos esperam ~200ms.
  assert.ok(decorrido >= 150, `esperava ao menos 150ms de espera, levou ${decorrido}ms`);
  assert.ok(decorrido < 2500, `nao deveria demorar tanto: ${decorrido}ms`);
});

test('token bucket mantem a taxa mesmo com handler lento', async () => {
  // O ponto: com "dispare N e espere o segundo fechar", um handler de 300ms
  // derrubaria a vazão. Com bucket + concorrência, não.
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  const t0 = Date.now();
  await runQueue(
    items,
    async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true };
    },
    { concurrency: 10, ratePerSecond: 20, attempts: 1 }
  );
  const decorrido = Date.now() - t0;
  // Serial seriam 2400ms. Com concorrência 10, fica perto de 300ms.
  assert.ok(decorrido < 1200, `concorrencia nao esta funcionando: ${decorrido}ms`);
});

test('bucket nao libera mais que a taxa configurada', async () => {
  const bucket = new TokenBucket(5);
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) await bucket.take();
  const decorrido = Date.now() - t0;
  assert.ok(decorrido >= 400, `8 tokens a 5/s exigem espera; levou ${decorrido}ms`);
});

// ── Concorrência e cancelamento ────────────────────────────────────────────

test('nao passa da concorrencia configurada', async () => {
  let simultaneos = 0;
  let pico = 0;
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i }));

  await runQueue(
    items,
    async () => {
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 20));
      simultaneos--;
      return { ok: true };
    },
    { concurrency: 4, ratePerSecond: 1000, attempts: 1 }
  );

  assert.ok(pico <= 4, `pico de ${pico} passou da concorrencia 4`);
  assert.ok(pico >= 2, 'deveria ter havido paralelismo');
});

test('cancelamento interrompe o restante da fila', async () => {
  let processados = 0;
  let cancelado = false;
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));

  const stats = await runQueue(
    items,
    async () => {
      processados++;
      if (processados >= 10) cancelado = true;
      return { ok: true };
    },
    { concurrency: 2, ratePerSecond: 1000, attempts: 1, shouldStop: () => cancelado }
  );

  assert.ok(stats.processed < 100, 'a fila parou antes do fim');
  assert.ok(stats.processed >= 10);
});

// ── Zero retenção: a fila é destruída ao terminar ──────────────────────────

test('a fila e os itens sao destruidos no fim', async () => {
  const items = [
    { phone: '5562990000001', variables: ['Maria'] },
    { phone: '5562990000002', variables: ['Joao'] },
  ];
  const referencia = items[0]; // guardamos a referência de propósito

  await runQueue(items, async () => ({ ok: true }), {
    concurrency: 2,
    ratePerSecond: 1000,
    attempts: 1,
  });

  assert.equal(items.length, 0, 'o array da fila fica vazio');
  assert.equal(referencia.phone, null, 'o telefone do item foi apagado');
  assert.equal(referencia.variables, null);
});
