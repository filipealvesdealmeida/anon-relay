'use strict';

/**
 * Configuracao do relay. Tudo vem de variaveis de ambiente — nada e lido de
 * banco de dados, porque este servico nao tem banco de dados.
 *
 * Regra de ouro deste projeto: nenhum numero de telefone pode sobreviver ao
 * request que o trouxe. Toda escolha aqui existe pra sustentar isso.
 */

require('dotenv').config();

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`[config] variavel obrigatoria ausente: ${key}`);
    process.exit(1);
  }
  return v;
}

function int(key, fallback) {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * ANON_SENDERS: JSON com os numeros dedicados ao modo anonimo.
 * [{ "id": "<phoneNumberId>", "label": "Comercial 01", "wabaId": "...", "token": "EAAG..." }]
 *
 * Os tokens vivem SO aqui (env do container). O banco do sistema principal nao
 * participa deste fluxo em nenhum momento.
 */
function parseSenders() {
  const raw = process.env.ANON_SENDERS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[config] ANON_SENDERS nao e um JSON valido:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error('[config] ANON_SENDERS precisa ser um array');
    process.exit(1);
  }
  return parsed
    .filter((s) => s && s.id && s.token)
    .map((s) => ({
      id: String(s.id),
      label: String(s.label || s.id),
      wabaId: s.wabaId ? String(s.wabaId) : null,
      token: String(s.token),
    }));
}

const config = {
  port: int('PORT', 3020),
  // Bind explicito. Sem isto o Node sobe so em IPv6 (::) em alguns ambientes e
  // o mapeamento de porta do Docker, que fala IPv4, nao encontra o servico.
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',

  // Redis guarda EXCLUSIVAMENTE contadores agregados e chaves derivadas por HMAC.
  // Nenhum valor gravado aqui permite reconstruir um numero de telefone.
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    prefix: process.env.REDIS_PREFIX || 'anon:',
    // Retencao dos contadores agregados (o dado pessoal ja nao existe;
    // isto define por quanto tempo o relatorio continua disponivel).
    reportTtlDays: int('REPORT_TTL_DAYS', 30),
    // Janela em que um wamid ainda recebe callbacks de status.
    wamidTtlHours: int('WAMID_TTL_HOURS', 72),
  },

  // Segredos de derivacao. Rotacionar invalida os indices existentes (por design:
  // o dado antigo vira ruido irreversivel na hora).
  secrets: {
    // Deriva chaves de indice a partir do wamid/telefone. 32 bytes hex.
    pepper: required('ANON_PEPPER'),
    // Valida os tickets emitidos pelo sistema principal.
    ticket: required('ANON_TICKET_SECRET'),
  },

  meta: {
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    // App secret do App Meta dono dos numeros anonimos. Quando presente, a
    // assinatura X-Hub-Signature-256 do webhook e verificada.
    appSecret: process.env.META_APP_SECRET || '',
  },

  senders: parseSenders(),

  dispatch: {
    // Mensagens por segundo por numero. A Meta aceita mais; o teto conservador
    // existe pra nao queimar reputacao do numero.
    ratePerSecond: int('DISPATCH_RATE_PER_SECOND', 12),
    // Envios simultaneos. O rate limit e quem controla a vazao; a concorrencia
    // existe pra manter a taxa quando a Meta responde devagar.
    concurrency: int('DISPATCH_CONCURRENCY', 20),
    // Mesma politica do BullMQ no sistema principal: 5 tentativas, backoff
    // exponencial a partir de 2s (2s, 4s, 8s, 16s) com jitter.
    attempts: int('DISPATCH_ATTEMPTS', 5),
    backoffMs: int('DISPATCH_BACKOFF_MS', 2000),
    maxRecipientsPerJob: int('MAX_RECIPIENTS_PER_JOB', 50000),
    // Tamanho maximo do corpo do request (a lista chega como texto JSON).
    maxBodyBytes: int('MAX_BODY_BYTES', 12 * 1024 * 1024),
  },

  // CORS: origem do painel /privado servido pelo sistema principal.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Procedencia da imagem em execucao (injetados pelo workflow de deploy).
  build: {
    commit: process.env.BUILD_COMMIT || 'dev',
    imageDigest: process.env.IMAGE_DIGEST || 'dev',
    deployedAt: process.env.DEPLOYED_AT || null,
    sourceRepo: process.env.SOURCE_REPO || 'https://github.com/OWNER/anon-relay',
    releaseTag: process.env.RELEASE_TAG || null,
  },
};

module.exports = config;
