'use strict';

/**
 * Configuração do relay. Tudo vem de variáveis de ambiente — nada é lido de
 * banco de dados, porque este serviço não tem banco de dados. Nem disco.
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
 * ANON_SENDERS: JSON com os números dedicados ao modo anônimo.
 * [{ "id": "<phoneNumberId>", "label": "Comercial 01", "wabaId": "...", "token": "EAAG..." }]
 *
 * Os tokens da Meta vivem SÓ aqui. O sistema que opera os disparos não os tem —
 * ele não consegue enviar sozinho, nem abrir os números que guarda cifrados.
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
  // Bind explícito. Sem isto o Node sobe só em IPv6 em alguns ambientes e o
  // mapeamento de porta do Docker, que fala IPv4, não encontra o serviço.
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',

  secrets: {
    // Única cópia da chave privada. É o que separa este processo de todos os
    // outros: só ele abre os números que o sistema guarda cifrados.
    privateKey: required('ANON_PRIVATE_KEY'),
    // Deriva a chave de casamento do callback (HMAC do wamid).
    pepper: required('ANON_PEPPER'),
    // Autentica as chamadas vindas do sistema que opera os disparos.
    ticket: required('ANON_TICKET_SECRET'),
  },

  meta: {
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
  },

  senders: parseSenders(),

  send: {
    // Teto de segurança por número. O rate limit principal é do lado de quem
    // enfileira; este aqui é a última barreira, e vale porque é o único ponto
    // que enxerga TODO o tráfego do número (disparo + resposta de automação).
    ratePerSecond: int('SEND_RATE_PER_SECOND', 60),
    maxBodyBytes: int('MAX_BODY_BYTES', 256 * 1024),
  },

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Procedência da imagem em execução (injetados pelo workflow de deploy).
  build: {
    commit: process.env.BUILD_COMMIT || 'dev',
    imageDigest: process.env.IMAGE_DIGEST || 'dev',
    deployedAt: process.env.DEPLOYED_AT || null,
    sourceRepo: process.env.SOURCE_REPO || 'https://github.com/OWNER/anon-relay',
    releaseTag: process.env.RELEASE_TAG || null,
  },
};

module.exports = config;
