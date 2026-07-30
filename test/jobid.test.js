'use strict';

/**
 * O identificador do disparo não pode parecer telefone.
 *
 * Este teste existe por causa de um falso positivo real: o hex aleatório do
 * jobId gerou "15036087" — oito dígitos seguidos — e a varredura de retenção
 * apontou o próprio identificador como suspeito. Na tela que existe para provar
 * ao cliente que não há telefone guardado, um alarme desses é pior do que
 * inútil.
 *
 * A correção é estrutural (grupos de 4 caracteres), e este teste roda muitas
 * amostras porque o problema original só aparecia de vez em quando.
 */

process.env.REDIS_PREFIX = (process.env.REDIS_PREFIX || 'anontest:').replace(/:$/, '') + '-jobid:';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Mesma geração de src/routes/jobs.js.
function newJobId() {
  const raw = Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
  return raw.match(/.{1,4}/g).join('-');
}

const PHONE_LIKE = /\d{8,}/;

test('nenhum jobId em 50 mil amostras parece telefone', () => {
  const ruins = [];
  for (let i = 0; i < 50000; i++) {
    const id = newJobId();
    if (PHONE_LIKE.test(id)) ruins.push(id);
  }
  assert.deepEqual(ruins.slice(0, 5), [], `ids que a varredura marcaria: ${ruins.length}`);
});

test('a geracao antiga falharia neste mesmo teste', () => {
  // Documenta o motivo da mudança: sem os grupos, o problema reaparece.
  const antiga = () => `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  let encontrados = 0;
  for (let i = 0; i < 50000; i++) if (PHONE_LIKE.test(antiga())) encontrados++;
  assert.ok(encontrados > 0, 'a geracao antiga produzia ids com 8+ digitos seguidos');
});

test('o id continua unico e legivel', () => {
  const vistos = new Set();
  for (let i = 0; i < 5000; i++) vistos.add(newJobId());
  assert.ok(vistos.size > 4990, 'praticamente sem colisao');
  const amostra = newJobId();
  assert.match(amostra, /^[a-z0-9]{1,4}(-[a-z0-9]{1,4})+$/);
});
