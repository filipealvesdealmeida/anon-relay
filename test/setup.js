'use strict';

/**
 * Ambiente de teste. Carregado antes de qualquer módulo do serviço, para que
 * config.js encontre as variáveis obrigatórias sem tocar no .env real.
 *
 * O par de chaves é gerado na hora: nenhum segredo de teste fica versionado, e
 * o teste exercita o caminho real de cifra/decifra.
 */

const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env.NODE_ENV = 'test';
process.env.ANON_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
process.env.ANON_PEPPER = process.env.ANON_PEPPER || 'pepper-de-teste-nao-usar-em-producao';
process.env.ANON_TICKET_SECRET = process.env.ANON_TICKET_SECRET || 'ticket-de-teste-nao-usar-em-producao';
process.env.ANON_SENDERS =
  process.env.ANON_SENDERS ||
  JSON.stringify([{ id: '999888777', label: 'Numero de teste', wabaId: 'waba-teste', token: 'token-falso' }]);

/** Cifra como o sistema chamador faria (com a chave pública). */
function encryptPhone(phone) {
  return crypto
    .publicEncrypt(
      { key: crypto.createPublicKey(publicKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(String(phone), 'utf8')
    )
    .toString('base64');
}

module.exports = { encryptPhone, publicKey, privateKey };
