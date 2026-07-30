'use strict';

/**
 * A rota /send: decifra, envia, devolve hash — e nada mais.
 *
 * O teste confere o contrato inteiro, inclusive o que a resposta NÃO pode
 * conter: o wamid cru (que embute o telefone) ou o número em qualquer forma.
 */

const { encryptPhone } = require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const meta = require('../src/meta');
const { wamidKey } = require('../src/hashing');
const ticket = require('../src/ticket');
const { TokenBucket } = require('../src/rate');

const SENDER_ID = '999888777';
const TELEFONE = '5562992287319';

/** Chama o handler da rota direto, sem socket (o sandbox de teste não abre porta). */
function chamar(rota, body, headers = {}) {
  const app = require('../src/server');
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: rota,
      path: rota,
      body,
      query: {},
      headers,
      get: (h) => headers[h.toLowerCase()],
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() {}, sendStatus(c) { resolve({ status: c, body: null }); }, on() {},
    };
    // Encontra a camada da rota no router do express e executa.
    const layer = app._router.stack.find(
      (l) => l.handle && l.handle.stack && l.handle.stack.some((s) => s.route && s.route.path === rota)
    );
    const sub = layer.handle.stack.find((s) => s.route && s.route.path === rota);
    const middlewares = layer.handle.stack.filter((s) => !s.route).map((s) => s.handle);
    let i = 0;
    const next = () => {
      if (i < middlewares.length) return middlewares[i++](req, res, next);
      return sub.route.stack[0].handle(req, res, next);
    };
    next();
  });
}

function tokenValido() {
  return { authorization: 'Bearer ' + ticket.issue({ tenant: 't1', senders: [SENDER_ID] }) };
}

/** Meta simulada; devolve wamid no formato real (com o telefone em base64). */
function mockMeta(resposta) {
  const chamadas = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (!href.includes('graph.facebook.com')) return original(url, options);
    const body = JSON.parse(options.body);
    chamadas.push(body);
    if (resposta) return new Response(JSON.stringify(resposta.corpo), { status: resposta.status, headers: { 'content-type': 'application/json' } });
    const wamid = 'wamid.HBgN' + Buffer.from(String(body.to)).toString('base64') + 'FQIAERgSABC';
    return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { chamadas, restore: () => { global.fetch = original; } };
}

test('sem ticket, nao envia', async () => {
  const r = await chamar('/send', { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE) }, {});
  assert.equal(r.status, 401);
});

test('ticket que nao autoriza o numero e recusado', async () => {
  const t = { authorization: 'Bearer ' + ticket.issue({ tenant: 't1', senders: ['outro'] }) };
  const r = await chamar('/send', { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE) }, t);
  assert.equal(r.status, 403);
});

test('decifra, envia template e devolve so o hash', async () => {
  const m = mockMeta();
  const r = await chamar(
    '/send',
    { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE), templateName: 'aviso', language: 'pt_BR', variables: ['Maria'] },
    tokenValido()
  );
  m.restore();

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Chegou o número certo na Meta.
  assert.equal(m.chamadas[0].to, TELEFONE);
  assert.equal(m.chamadas[0].template.name, 'aviso');

  // E a resposta não devolve nada que reconstrua o número.
  const resposta = JSON.stringify(r.body);
  assert.ok(!resposta.includes(TELEFONE), 'a resposta nao pode conter o telefone');
  assert.ok(!resposta.includes('wamid.'), 'a resposta nao pode conter o wamid cru');
  assert.ok(!/\d{8,}/.test(resposta), 'nem sequencia com formato de telefone');
  assert.equal(r.body.wamidHash.length, 22);
});

test('o hash devolvido casa com o hash do wamid real', async () => {
  const m = mockMeta();
  const r = await chamar(
    '/send',
    { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE), templateName: 'aviso', language: 'pt_BR' },
    tokenValido()
  );
  m.restore();
  const wamidReal = 'wamid.HBgN' + Buffer.from(TELEFONE).toString('base64') + 'FQIAERgSABC';
  assert.equal(r.body.wamidHash, wamidKey(wamidReal), 'e o mesmo hash que o callback vai produzir');
});

test('envia texto de sessao quando kind=text', async () => {
  const m = mockMeta();
  await chamar(
    '/send',
    { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE), kind: 'text', text: 'Oi! Recebi sua mensagem.' },
    tokenValido()
  );
  m.restore();
  assert.equal(m.chamadas[0].type, 'text');
  assert.equal(m.chamadas[0].text.body, 'Oi! Recebi sua mensagem.');
  assert.equal(m.chamadas[0].to, TELEFONE);
});

test('erro da Meta volta classificado, pra quem tem a fila decidir o retry', async () => {
  const m = mockMeta({ status: 400, corpo: { error: { code: 131026, message: 'Message undeliverable' } } });
  const r = await chamar(
    '/send',
    { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE), templateName: 'aviso', language: 'pt_BR' },
    tokenValido()
  );
  m.restore();
  assert.equal(r.body.ok, false);
  assert.equal(r.body.errorCode, '131026');
  assert.equal(r.body.retryable, false, 'numero invalido nao adianta repetir');
  assert.ok(!JSON.stringify(r.body).includes(TELEFONE));
});

test('rate limit da Meta volta como repetivel', async () => {
  const m = mockMeta({ status: 429, corpo: { error: { code: 130429, message: 'rate limit' } } });
  const r = await chamar(
    '/send',
    { senderId: SENDER_ID, phoneEnc: encryptPhone(TELEFONE), templateName: 'aviso', language: 'pt_BR' },
    tokenValido()
  );
  m.restore();
  assert.equal(r.body.retryable, true);
});

test('cofre recusa conteudo cifrado invalido sem tentar enviar', async () => {
  const m = mockMeta();
  const r = await chamar('/send', { senderId: SENDER_ID, phoneEnc: 'bWFsdWNv' }, tokenValido());
  m.restore();
  assert.equal(r.status, 400);
  assert.equal(m.chamadas.length, 0, 'nao chegou a chamar a Meta');
});

// ── Teto de segurança por número ───────────────────────────────────────────

test('conversa em andamento passa na frente do disparo', async () => {
  const bucket = new TokenBucket(5);
  const ordem = [];
  for (let i = 0; i < 5; i++) await bucket.take(0); // esgota

  const disparos = Array.from({ length: 8 }, (_, i) => bucket.take(0).then(() => ordem.push('disparo' + i)));
  await new Promise((r) => setTimeout(r, 10));
  const resposta = bucket.take(1).then(() => ordem.push('resposta'));

  await Promise.all([resposta, ...disparos]);
  assert.ok(ordem.indexOf('resposta') <= 1, `resposta saiu em ${ordem.indexOf('resposta')}`);
});

test('o balde e por numero', () => {
  const { senderBucket, baldes } = require('../src/rate');
  baldes.clear();
  assert.equal(senderBucket('A', 10), senderBucket('A', 10));
  assert.notEqual(senderBucket('A', 10), senderBucket('B', 10));
  baldes.clear();
});
