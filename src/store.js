'use strict';

/**
 * Camada de persistencia — e a lista completa do que este servico grava.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * INVENTARIO DE DADOS (auditavel linha a linha)
 * ────────────────────────────────────────────────────────────────────────────
 *  anon:job:<jobId>              HASH   contadores + metadados do disparo
 *                                       (nenhum campo pessoal: template, rotulo
 *                                       do numero remetente, totais, timestamps)
 *  anon:job:<jobId>:resp         HLL    cardinalidade de quem respondeu.
 *                                       HyperLogLog nao armazena os elementos —
 *                                       so registradores probabilisticos. Da o
 *                                       "quantos" sem qualquer "quem".
 *  anon:job:<jobId>:err          HASH   contagem por codigo de erro da Meta
 *  anon:tenant:<tenantKey>:jobs  ZSET   jobIds do tenant, score = criado em
 *  anon:w:<wamidKey>             STR    HMAC(wamid) -> jobId, TTL curto
 *  anon:sender:<senderId>:active STR    ultimo job do numero (atribui inbound)
 *  anon:sup:<optOutKey>          STR    HMAC(telefone) de quem pediu pra sair
 *
 * NAO existe chave, campo ou valor contendo telefone, nome, wamid cru ou
 * qualquer identificador do destinatario. O teste test/no-retention.test.js
 * roda um disparo completo e varre TODAS as chaves atras de qualquer coisa que
 * pareca telefone — se um dia alguem adicionar, o CI quebra.
 */

const Redis = require('ioredis');
const config = require('./config');
const log = require('./logging');
const { derive } = require('./hashing');

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  keyPrefix: config.redis.prefix,
});

redis.on('error', (err) => log.error('redis error', { message: err.message }));

const REPORT_TTL = config.redis.reportTtlDays * 24 * 3600;
const WAMID_TTL = config.redis.wamidTtlHours * 3600;
// Supressao (opt-out) e o unico dado com retencao longa. 5 anos: ninguem que
// pediu pra sair deve voltar a receber porque o registro expirou.
const SUPPRESSION_TTL = 5 * 365 * 24 * 3600;

const k = {
  job: (id) => `job:${id}`,
  jobResponders: (id) => `job:${id}:resp`,
  jobErrors: (id) => `job:${id}:err`,
  tenantJobs: (tenant) => `tenant:${tenant}:jobs`,
  tenantDay: (tenant, day) => `tenant:${tenant}:day:${day}`,
  wamid: (h) => `w:${h}`,
  // O identificador do NOSSO numero (phone_number_id da Meta) tambem entra
  // derivado. Ele nao e telefone de ninguem, mas manter o armazenamento sem
  // nenhuma sequencia longa de digitos deixa a varredura sem excecao: ou o
  // resultado e zero, ou aconteceu alguma coisa.
  senderActive: (senderId) => `sender:${derive('sender', senderId)}:active`,
  suppression: (h) => `sup:${h}`,
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function createJob(jobId, meta) {
  const now = Date.now();
  const doc = {
    id: jobId,
    tenant: meta.tenant,
    // Guardamos o ROTULO do numero, nao o identificador. O rotulo e o que o
    // painel mostra; o identificador nao precisa sobreviver ao request.
    senderLabel: meta.senderLabel,
    templateName: meta.templateName,
    label: meta.label || '',
    createdAt: String(now),
    status: 'queued',
    total: String(meta.total || 0),
    sent: '0',
    failed: '0',
    delivered: '0',
    read: '0',
    optout: '0',
    autoReplies: '0',
    skippedSuppressed: String(meta.skippedSuppressed || 0),
    skippedInvalid: String(meta.skippedInvalid || 0),
    skippedDuplicate: String(meta.skippedDuplicate || 0),
  };
  // Automacao do disparo: texto das mensagens e gatilho. E configuracao do
  // cliente, nao dado de contato — por isso pode ficar guardada. Fica no proprio
  // job porque e ele que o retorno da Meta identifica.
  if (meta.automation) doc.automation = JSON.stringify(meta.automation);
  const pipe = redis.pipeline();
  pipe.hset(k.job(jobId), doc);
  pipe.expire(k.job(jobId), REPORT_TTL);
  pipe.zadd(k.tenantJobs(meta.tenant), now, jobId);
  pipe.expire(k.tenantJobs(meta.tenant), REPORT_TTL);
  // O numero remetente fica reservado a este disparo pela janela de relatorio:
  // e o que permite atribuir uma resposta livre ao disparo certo sem saber de
  // quem ela veio.
  pipe.set(k.senderActive(meta.senderId), jobId, 'EX', WAMID_TTL);
  await pipe.exec();
  return doc;
}

async function setJobStatus(jobId, status, extra = {}) {
  const fields = { status, ...extra };
  await redis.hset(k.job(jobId), fields);
}

async function incrJob(jobId, field, by = 1) {
  await redis.hincrby(k.job(jobId), field, by);
}

/** Le a automacao gravada no job. Retorna null quando o disparo nao tem uma. */
function parseAutomation(job) {
  if (!job?.automation) return null;
  try {
    const a = JSON.parse(job.automation);
    return a?.enabled ? a : null;
  } catch (_) {
    return null;
  }
}

async function getJob(jobId) {
  const doc = await redis.hgetall(k.job(jobId));
  if (!doc || !doc.id) return null;
  return doc;
}

async function listJobs(tenant, limit = 50) {
  const ids = await redis.zrevrange(k.tenantJobs(tenant), 0, limit - 1);
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(k.job(id)));
  ids.forEach((id) => pipe.pfcount(k.jobResponders(id)));
  const res = await pipe.exec();
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const doc = res[i]?.[1];
    if (!doc || !doc.id) continue;
    doc.responded = String(res[ids.length + i]?.[1] ?? 0);
    out.push(doc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cota diaria por cliente
// ---------------------------------------------------------------------------

/**
 * Dia corrente no fuso de Brasilia — o cliente conta o dia dele, nao o do UTC.
 * Formato com hifen (2026-07-30) de proposito: "20260730" seria uma sequencia
 * de 8 digitos e a varredura de retencao a marcaria como suspeita. Preferimos
 * ajustar a chave a abrir excecao na varredura — excecao e onde dado pessoal
 * costuma se esconder.
 */
function currentDay() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Quantas mensagens este cliente ja preparou hoje. Contador puro, sem identidade. */
async function dayCount(tenant) {
  const v = await redis.get(k.tenantDay(tenant, currentDay()));
  return parseInt(v, 10) || 0;
}

async function addToDayCount(tenant, n) {
  const key = k.tenantDay(tenant, currentDay());
  const pipe = redis.pipeline();
  pipe.incrby(key, n);
  pipe.expire(key, 3 * 24 * 3600);
  await pipe.exec();
}

// ---------------------------------------------------------------------------
// Indice de status (HMAC do wamid -> job)
// ---------------------------------------------------------------------------

/** Grava o vinculo mensagem->disparo em forma irreversivel. */
async function linkMessage(wamidHash, jobId) {
  await redis.set(k.wamid(wamidHash), jobId, 'EX', WAMID_TTL);
}

async function linkMessageBatch(pairs) {
  if (!pairs.length) return;
  const pipe = redis.pipeline();
  for (const [hash, jobId] of pairs) {
    pipe.set(k.wamid(hash), jobId, 'EX', WAMID_TTL);
  }
  await pipe.exec();
}

async function resolveMessage(wamidHash) {
  return redis.get(k.wamid(wamidHash));
}

async function resolveSenderJob(senderId) {
  return redis.get(k.senderActive(senderId));
}

// ---------------------------------------------------------------------------
// Respostas (cardinalidade sem identidade)
// ---------------------------------------------------------------------------

async function recordResponder(jobId, phoneHash) {
  const pipe = redis.pipeline();
  pipe.pfadd(k.jobResponders(jobId), phoneHash);
  pipe.expire(k.jobResponders(jobId), REPORT_TTL);
  await pipe.exec();
}

async function countResponders(jobId) {
  return redis.pfcount(k.jobResponders(jobId));
}

// ---------------------------------------------------------------------------
// Erros agregados
// ---------------------------------------------------------------------------

async function recordError(jobId, code) {
  const pipe = redis.pipeline();
  pipe.hincrby(k.jobErrors(jobId), String(code || 'unknown'), 1);
  pipe.expire(k.jobErrors(jobId), REPORT_TTL);
  await pipe.exec();
}

async function getErrors(jobId) {
  return redis.hgetall(k.jobErrors(jobId));
}

// ---------------------------------------------------------------------------
// Supressao / opt-out
// ---------------------------------------------------------------------------

async function suppress(optHash) {
  await redis.set(k.suppression(optHash), '1', 'EX', SUPPRESSION_TTL);
}

/**
 * Filtra uma lista de hashes retornando o conjunto que esta suprimido.
 * Trabalha em lotes pra nao criar um pipeline de 50k comandos de uma vez.
 */
async function filterSuppressed(hashes) {
  const suppressed = new Set();
  const CHUNK = 2000;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const pipe = redis.pipeline();
    chunk.forEach((h) => pipe.exists(k.suppression(h)));
    const res = await pipe.exec();
    res.forEach((r, idx) => {
      if (r?.[1] === 1) suppressed.add(chunk[idx]);
    });
  }
  return suppressed;
}

async function countSuppressed() {
  // SCAN em vez de KEYS: nao bloqueia o Redis compartilhado.
  let cursor = '0';
  let count = 0;
  const match = `${config.redis.prefix}sup:*`;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 1000);
    cursor = next;
    count += keys.length;
  } while (cursor !== '0');
  return count;
}

async function ping() {
  return redis.ping();
}

async function close() {
  await redis.quit();
}

module.exports = {
  redis,
  keys: k,
  ttl: { report: REPORT_TTL, wamid: WAMID_TTL, suppression: SUPPRESSION_TTL },
  createJob,
  setJobStatus,
  parseAutomation,
  dayCount,
  addToDayCount,
  currentDay,
  incrJob,
  getJob,
  listJobs,
  linkMessage,
  linkMessageBatch,
  resolveMessage,
  resolveSenderJob,
  recordResponder,
  countResponders,
  recordError,
  getErrors,
  suppress,
  filterSuppressed,
  countSuppressed,
  ping,
  close,
};
