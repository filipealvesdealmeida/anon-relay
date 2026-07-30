'use strict';

/**
 * anon-relay — cofre de envio de WhatsApp.
 *
 * Um serviço pequeno com uma responsabilidade só: ser o único processo que
 * consegue abrir um número de telefone, e não ter onde guardá-lo.
 *
 * O sistema que opera os disparos (páginas, filas, workers, automações) guarda
 * cada telefone CIFRADO com a chave pública deste serviço. Ele consegue cifrar
 * e não consegue abrir. Quando chega a hora de enviar, chama aqui: decifra em
 * memória, entrega à Meta, devolve um hash e esquece.
 *
 * Três dependências, nenhum banco, nenhuma fila, disco somente leitura. Dá
 * para ler o repositório inteiro numa tarde e verificar por conta própria.
 *
 *   GET  /health              saúde
 *   GET  /version             commit + digest da imagem em execução
 *   GET  /privacy/manifest    o que este serviço guarda (resposta: nada)
 *   POST /send                decifra, envia, devolve HMAC(wamid)   [ticket]
 *   GET  /templates           templates aprovados                   [ticket]
 *   GET  /senders             números disponíveis                   [ticket]
 */

const express = require('express');
const config = require('./config');
const log = require('./logging');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS: quem chama é servidor-a-servidor (sem navegador, sem cookie). A lista
// só existe para o caso de uma página de status consultar /version.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Ticket');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Corpo pequeno: cada chamada carrega UM telefone cifrado, não uma lista.
app.use(express.json({ limit: config.send.maxBodyBytes }));

// Log de acesso sem query string nem corpo.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    log.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
  });
  next();
});

app.use('/', require('./routes/version'));
app.use('/', require('./routes/send'));

app.use((req, res) => res.status(404).json({ ok: false, error: 'rota inexistente' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('erro nao tratado', { message: err?.message });
  res.status(500).json({ ok: false, error: 'erro interno' });
});

// Só sobe o listener quando executado como programa. Importado (teste,
// ferramenta de inspeção), exporta o app e não abre porta.
const server = require.main !== module ? null : app.listen(config.port, config.host, () => {
  log.info('anon-relay no ar', {
    host: config.host,
    port: config.port,
    env: config.env,
    commit: config.build.commit,
    digest: config.build.imageDigest,
    senders: config.senders.length,
  });
  if (!config.senders.length) {
    log.warn('nenhum numero configurado em ANON_SENDERS — o servico sobe, mas nao envia');
  }
});

if (server) {
  const shutdown = (signal) => {
    log.info('encerrando', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
