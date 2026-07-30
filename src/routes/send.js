'use strict';

/**
 * POST /send — o cofre em ação.
 *
 * É a única rota que faz trabalho neste serviço, e cabe numa tela:
 *
 *   1. recebe o telefone CIFRADO (quem chama não consegue abrir o que mandou);
 *   2. decifra numa variável local;
 *   3. entrega à Meta — a saída legítima, o destino da operação;
 *   4. devolve HMAC(wamid), nunca o wamid, que embutiria o telefone de volta;
 *   5. a variável sai de escopo e não sobrou nada, porque não há onde sobrar:
 *      este processo não tem banco, não tem fila e roda com o disco somente
 *      leitura.
 *
 * O que NÃO existe aqui, de propósito: nenhuma rota que liste, busque ou
 * devolva destinatário. Não há como responder "quem recebeu?" porque não há
 * onde procurar.
 */

const express = require('express');
const config = require('../config');
const meta = require('../meta');
const log = require('../logging');
const { decryptPhone, wamidKey, maskPhone } = require('../hashing');
const { senderBucket } = require('../rate');
const { requireTicket } = require('../ticket');

const router = express.Router();
router.use(requireTicket);

router.post('/send', async (req, res) => {
  const { senderId, phoneEnc, kind, templateName, language, variables, text, headerType, headerMediaUrl, buttonUrlParam } =
    req.body || {};

  if (!req.allowedSenders.includes(String(senderId))) {
    return res.status(403).json({ ok: false, error: 'numero nao autorizado neste ticket' });
  }
  const sender = meta.senderById(senderId);
  if (!sender) return res.status(404).json({ ok: false, error: 'numero nao configurado' });
  if (!phoneEnc) return res.status(400).json({ ok: false, error: 'phoneEnc obrigatorio' });

  let phone = null;
  try {
    phone = decryptPhone(phoneEnc);
  } catch (err) {
    log.warn('cofre recusou o conteudo', { message: err.message });
    return res.status(400).json({ ok: false, error: 'phoneEnc invalido', retryable: false });
  }

  try {
    // Conversa em andamento passa na frente do disparo em massa.
    const prioridade = kind === 'text' ? 1 : 0;
    await senderBucket(sender.id, config.send.ratePerSecond).take(prioridade);

    const r =
      kind === 'text'
        ? await meta.sendText(sender, phone, text)
        : await meta.sendTemplate(sender, {
            to: phone,
            templateName,
            language,
            variables,
            headerType,
            headerMediaUrl,
            buttonUrlParam,
          });

    if (r.ok) {
      // HMAC do wamid, nunca o wamid: ele embute o telefone em base64.
      return res.json({ ok: true, wamidHash: wamidKey(r.wamid) });
    }

    return res.status(200).json({
      ok: false,
      status: r.status,
      code: r.code,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      // Quem enfileirou decide o retry (é ele que tem a fila persistida);
      // aqui só informamos se vale a pena.
      retryable: r.retryable,
    });
  } catch (err) {
    log.error('falha no envio', { message: err.message, to: maskPhone(phone) });
    return res.status(200).json({ ok: false, errorMessage: err.message, retryable: true });
  } finally {
    // Última referência ao número em claro.
    phone = null;
  }
});

/** Templates aprovados do número. Metadado de conta — não há dado pessoal aqui. */
router.get('/templates', async (req, res) => {
  const senderId = String(req.query.senderId || '');
  if (!req.allowedSenders.includes(senderId)) {
    return res.status(403).json({ ok: false, error: 'numero nao autorizado neste ticket' });
  }
  const sender = meta.senderById(senderId);
  if (!sender) return res.status(404).json({ ok: false, error: 'numero nao configurado' });
  try {
    const result = await meta.listTemplates(sender);
    res.json({ ok: result.ok, templates: result.templates, error: result.error || null });
  } catch (err) {
    log.error('falha ao listar templates', { message: err.message });
    res.status(502).json({ ok: false, error: 'falha ao consultar a Meta' });
  }
});

/** Números disponíveis ao portador do ticket. */
router.get('/senders', (req, res) => {
  const allowed = new Set(req.allowedSenders || []);
  res.json({
    ok: true,
    senders: config.senders
      .filter((s) => allowed.has(s.id))
      .map((s) => ({ id: s.id, label: s.label, hasWaba: !!s.wabaId })),
  });
});

module.exports = router;
