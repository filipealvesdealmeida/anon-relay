'use strict';

/**
 * Transporte do webhook da Meta. Toda a logica de o que fazer com o evento
 * (e, principalmente, o que NAO fazer com os telefones que ele carrega) vive
 * em src/webhook-processor.js, separada e testada isolada.
 */

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const log = require('../logging');
const { safeEqual } = require('../hashing');
const { processWebhookPayload } = require('../webhook-processor');

const router = express.Router();

// Verificacao da URL (a Meta faz um GET com hub.challenge).
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && config.meta.verifyToken && token === config.meta.verifyToken) {
    log.info('webhook verificado pela Meta');
    return res.status(200).send(challenge);
  }
  log.warn('webhook verify rejeitado');
  return res.sendStatus(403);
});

/**
 * Duas origens legitimas para um evento:
 *
 *  1. A propria Meta, quando os numeros anonimos tem App/webhook proprio.
 *     Confere X-Hub-Signature-256 com o app secret.
 *
 *  2. O sistema principal, quando os numeros dividem o App com ele. Nesse caso
 *     a Meta entrega la, o sistema separa os eventos anonimos e repassa pra ca
 *     sem persistir nada. Como o corpo muda no filtro, a assinatura da Meta nao
 *     sobrevive — o repasse vem assinado com o segredo compartilhado.
 */
function signatureValid(req) {
  const body = req.rawBody || Buffer.alloc(0);

  const forward = req.get('x-anon-forward-signature');
  if (forward) {
    const expected = crypto.createHmac('sha256', config.secrets.ticket).update(body).digest('hex');
    return safeEqual(forward, expected);
  }

  if (!config.meta.appSecret) return true; // sem app secret configurado, nao ha o que conferir
  const header = req.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(body)
    .digest('hex');
  return safeEqual(header.slice(7), expected);
}

router.post('/', async (req, res) => {
  // 200 imediato: a Meta reentrega agressivamente em qualquer 5xx.
  res.status(200).json({ received: true });

  if (!signatureValid(req)) {
    log.warn('webhook com assinatura invalida — descartado');
    return;
  }

  try {
    await processWebhookPayload(req.body);
  } catch (err) {
    log.error('falha ao processar webhook', { message: err.message });
  }
});

module.exports = router;
