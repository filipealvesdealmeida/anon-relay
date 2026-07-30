'use strict';

/**
 * Ambiente de teste. Carregado antes de qualquer modulo do servico pra que
 * config.js encontre as variaveis obrigatorias sem tocar no .env real.
 */

process.env.NODE_ENV = 'test';
process.env.ANON_PEPPER = process.env.ANON_PEPPER || 'pepper-de-teste-nao-usar-em-producao';
process.env.ANON_TICKET_SECRET = process.env.ANON_TICKET_SECRET || 'ticket-de-teste-nao-usar-em-producao';
process.env.REDIS_PREFIX = process.env.REDIS_PREFIX || 'anontest:';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.ANON_SENDERS =
  process.env.ANON_SENDERS ||
  JSON.stringify([{ id: '999888777', label: 'Numero de teste', wabaId: 'waba-teste', token: 'token-falso' }]);

module.exports = {};
