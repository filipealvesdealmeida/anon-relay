'use strict';

/**
 * O cofre: abre o que só ele pode abrir, e não devolve nada que reconstrua o
 * número.
 */

const { encryptPhone } = require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const h = require('../src/hashing');
const ticket = require('../src/ticket');
const log = require('../src/logging');

const TELEFONE = '5562992287319';
const WAMID = 'wamid.HBgNNTU2Mjk5MjI4NzMxORUCABEYEjczQzk5MkFCQ0RFRjEyMzQ1Ng==';

// ── Cofre ──────────────────────────────────────────────────────────────────

test('decifra o telefone que o sistema chamador cifrou', () => {
  assert.equal(h.decryptPhone(encryptPhone(TELEFONE)), TELEFONE);
});

test('o cifrado nao revela nada por si so', () => {
  const enc = encryptPhone(TELEFONE);
  assert.ok(!enc.includes(TELEFONE));
  assert.ok(!/\d{8,}/.test(enc), 'nao tem sequencia com formato de telefone');
  assert.notEqual(enc, encryptPhone(TELEFONE), 'cifragem e aleatorizada');
});

test('recusa conteudo que nao seja telefone', () => {
  const lixo = crypto
    .publicEncrypt(
      { key: crypto.createPublicKey(require('./setup').publicKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from('rm -rf /', 'utf8')
    )
    .toString('base64');
  assert.throws(() => h.decryptPhone(lixo), /nao e um telefone/);
});

test('recusa cifrado de outra chave', () => {
  const outra = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const enc = crypto
    .publicEncrypt(
      { key: crypto.createPublicKey(outra.publicKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(TELEFONE, 'utf8')
    )
    .toString('base64');
  assert.throws(() => h.decryptPhone(enc));
});

// ── O que sai do serviço ───────────────────────────────────────────────────

test('o hash do wamid nao contem o telefone que o wamid embute', () => {
  const chave = h.wamidKey(WAMID);
  assert.equal(chave, h.wamidKey(WAMID), 'deterministico');
  assert.ok(!chave.includes('5562'));
  assert.ok(!/\d{8,}/.test(chave));
  assert.equal(chave.length, 22);
});

test('mascara de log nao permite reconstrucao', () => {
  assert.equal(h.maskPhone(TELEFONE), '55 62 ********* (9)');
});

test('logger apaga digitos longos e wamid', () => {
  const redigido = log.redact({ to: TELEFONE, id: WAMID, texto: `ligar para ${TELEFONE}`, contador: 42 });
  const s = JSON.stringify(redigido);
  assert.ok(!s.includes(TELEFONE));
  assert.ok(!s.includes('HBgNNTU2'));
  assert.equal(redigido.contador, 42);
});

// ── Ticket ─────────────────────────────────────────────────────────────────

test('ticket valido carrega tenant e numeros permitidos', () => {
  const t = ticket.issue({ tenant: 'abc123', senders: ['999888777'] });
  const r = ticket.verify(t);
  assert.equal(r.ok, true);
  assert.equal(r.claims.t, 'abc123');
  assert.deepEqual(r.claims.s, ['999888777']);
});

test('ticket adulterado e recusado', () => {
  const t = ticket.issue({ tenant: 'abc123', senders: [] });
  const [v, , sig] = t.split('.');
  const forjado = `${v}.${Buffer.from(JSON.stringify({ t: 'outro', exp: 9e9 })).toString('base64url')}.${sig}`;
  assert.equal(ticket.verify(forjado).ok, false);
});

test('ticket expirado e recusado', () => {
  const r = ticket.verify(ticket.issue({ tenant: 'abc', senders: [], ttlSec: -10 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /expirado/);
});
