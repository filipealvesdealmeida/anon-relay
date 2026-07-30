'use strict';

/**
 * anon-relay — disparo de WhatsApp com retencao zero de numeros.
 *
 * Servico deliberadamente pequeno. Tres dependencias, nenhum banco de dados,
 * nenhuma escrita em disco, nenhum endpoint capaz de devolver um destinatario.
 * O objetivo e que uma pessoa tecnica leia o repositorio inteiro numa tarde e
 * consiga afirmar, por conta propria, que a promessa e verdadeira.
 *
 * Mapa das rotas:
 *   GET  /health                 saude
 *   GET  /version                commit + digest da imagem em execucao
 *   GET  /privacy/manifest       o que este servico grava (declarado pela maquina)
 *   GET  /privacy/scan           varredura ao vivo do armazenamento
 *   GET  /webhook                verificacao da Meta (hub.challenge)
 *   POST /webhook                eventos da Meta (nada e persistido em claro)
 *   GET  /api/senders            numeros disponiveis            [ticket]
 *   GET  /api/templates          templates aprovados            [ticket]
 *   POST /api/preview            contagem previa da planilha    [ticket]
 *   POST /api/jobs               inicia disparo                 [ticket]
 *   POST /api/jobs/:id/cancel    cancela disparo                [ticket]
 *   GET  /api/jobs               lista disparos                 [ticket]
 *   GET  /api/jobs/:id/report    relatorio                      [ticket]
 */

const express = require('express');
const config = require('./config');
const log = require('./logging');
const store = require('./store');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ── CORS ───────────────────────────────────────────────────────────────────
// O painel /privado e servido pelo sistema principal, em outra origem. Nao
// usamos cookie em lugar nenhum (a autorizacao e o ticket no header), entao
// nao ha credential a compartilhar.
app.use((req, res, next) => {
  const origin = req.get('origin');
  const permitido =
    config.allowedOrigins.length === 0 || (origin && config.allowedOrigins.includes(origin));
  if (origin && permitido) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Ticket');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Cabecalhos de seguranca basicos (sem dependencia).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Corpo JSON. `verify` guarda o buffer cru apenas pro webhook conferir a
// assinatura da Meta — e descartado com o request.
app.use(
  express.json({
    limit: config.dispatch.maxBodyBytes,
    verify: (req, res, buf) => {
      if (req.path === '/webhook') req.rawBody = buf;
    },
  })
);

// Log de acesso sem query string: nao ha telefone em URL neste servico, e
// manter assim e regra — se um dia alguem adicionar, o log nao ajuda a vazar.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    log.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

app.use('/', require('./routes/version'));
app.use('/webhook', require('./routes/webhook'));
app.use('/api', require('./routes/jobs'));
app.use('/api', require('./routes/report'));

app.use((req, res) => res.status(404).json({ ok: false, error: 'rota inexistente' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'planilha maior que o limite configurado' });
  }
  log.error('erro nao tratado', { message: err?.message });
  res.status(500).json({ ok: false, error: 'erro interno' });
});

const server = app.listen(config.port, config.host, () => {
  log.info('anon-relay no ar', {
    host: config.host,
    port: config.port,
    env: config.env,
    commit: config.build.commit,
    digest: config.build.imageDigest,
    senders: config.senders.length,
    verificacaoDeAssinatura: !!config.meta.appSecret,
  });
  if (!config.senders.length) {
    log.warn('nenhum numero configurado em ANON_SENDERS — o servico sobe, mas nao dispara');
  }
});

async function shutdown(signal) {
  log.info('encerrando', { signal });
  server.close();
  try {
    await store.close();
  } catch (_) {
    /* ignora */
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
