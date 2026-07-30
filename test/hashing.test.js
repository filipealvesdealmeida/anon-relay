'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/hashing');
const ticket = require('../src/ticket');
const log = require('../src/logging');

const WAMID = 'wamid.HBgNNTU2Mjk5MjI4NzMxORUCABEYEjczQzk5MkFCQ0RFRjEyMzQ1Ng==';
const PHONE = '5562992287319';

test('hash e deterministico e nao contem o valor de entrada', () => {
  const a = h.wamidKey(WAMID);
  const b = h.wamidKey(WAMID);
  assert.equal(a, b);
  assert.ok(!a.includes('5562'), 'hash nao pode conter digito do telefone');
  assert.ok(!/\d{8,}/.test(a), 'hash nao pode ter sequencia com formato de telefone');
  assert.equal(a.length, 22);
});

test('dominios diferentes produzem hashes diferentes pro mesmo valor', () => {
  assert.notEqual(h.phoneKey(PHONE), h.optOutKey(PHONE));
  assert.notEqual(h.phoneKey(PHONE), h.tenantKey(PHONE));
});

test('mascara de telefone nao permite reconstrucao', () => {
  const m = h.maskPhone(PHONE);
  assert.equal(m, '55 62 ********* (9)');
  assert.ok(!m.includes('9228'));
});

test('logger apaga digitos longos e wamid', () => {
  const redacted = log.redact({ to: PHONE, id: WAMID, texto: `ligar para ${PHONE}`, contador: 42 });
  assert.ok(!JSON.stringify(redacted).includes('5562992287319'));
  assert.ok(!JSON.stringify(redacted).includes('HBgNNTU2'));
  assert.equal(redacted.contador, 42, 'numero pequeno permanece legivel');
});

test('logger redige dentro de estrutura aninhada', () => {
  const out = log.redact({ entry: [{ changes: [{ value: { statuses: [{ recipient_id: PHONE }] } }] }] });
  assert.ok(!JSON.stringify(out).includes(PHONE));
});

test('ticket valido e aceito e carrega tenant e senders', () => {
  const t = ticket.issue({ tenant: 'abc123', senders: ['999888777'] });
  const r = ticket.verify(t);
  assert.equal(r.ok, true);
  assert.equal(r.claims.t, 'abc123');
  assert.deepEqual(r.claims.s, ['999888777']);
});

test('ticket adulterado e recusado', () => {
  const t = ticket.issue({ tenant: 'abc123', senders: [] });
  const [v, body, sig] = t.split('.');
  const forjado = `${v}.${Buffer.from(JSON.stringify({ t: 'outro', exp: 9e9 })).toString('base64url')}.${sig}`;
  assert.equal(ticket.verify(forjado).ok, false);
});

test('ticket expirado e recusado', () => {
  const t = ticket.issue({ tenant: 'abc123', senders: [], ttlSec: -10 });
  const r = ticket.verify(t);
  assert.equal(r.ok, false);
  assert.match(r.error, /expirado/);
});
