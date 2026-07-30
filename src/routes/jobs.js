'use strict';

/**
 * Rotas do disparo. Todas exigem ticket valido (ver src/ticket.js).
 *
 * Repare no que NENHUMA resposta desta rota devolve: lista de destinatarios,
 * amostra da planilha, telefone de exemplo, "ultimos enviados". Nao ha endpoint
 * capaz de responder "quem estava na lista" porque nao ha onde buscar.
 */

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const csvLib = require('../csv');
const dispatch = require('../dispatch');
const meta = require('../meta');
const automation = require('../automation');
const log = require('../logging');
const { requireTicket } = require('../ticket');
const { optOutKey } = require('../hashing');

const router = express.Router();
router.use(requireTicket);

function newJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function sendersFor(req) {
  const allowed = new Set(req.allowedSenders || []);
  return config.senders
    .filter((s) => allowed.size === 0 || allowed.has(s.id))
    .map((s) => ({ id: s.id, label: s.label, hasWaba: !!s.wabaId }));
}

// ── Numeros disponiveis ao tenant ─────────────────────────────────────────
router.get('/senders', (req, res) => {
  res.json({ ok: true, senders: sendersFor(req) });
});

// ── Templates aprovados de um numero ──────────────────────────────────────
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

// ── Pre-analise da planilha (sem enviar nada, sem guardar nada) ────────────
// Serve pro painel mostrar "1.482 contatos validos, 37 duplicados" antes do
// disparo. A resposta e composta so de contagens.
router.post('/preview', async (req, res) => {
  const text = req.body?.csv;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'csv vazio' });
  }
  try {
    const parsed = csvLib.parse(text, { maxRows: config.dispatch.maxRecipientsPerJob });
    const hashes = parsed.rows.map((r) => optOutKey(r.phone));
    const suppressed = await store.filterSuppressed(hashes);
    const usadoHoje = await store.dayCount(req.tenant);
    res.json({
      ok: true,
      columns: parsed.headers,
      phoneColumn: parsed.phoneColumn,
      counts: {
        linhas: parsed.stats.total,
        validos: parsed.rows.length - suppressed.size,
        invalidos: parsed.stats.invalid,
        duplicados: parsed.stats.duplicate,
        suprimidos: suppressed.size,
      },
      cota: req.dailyLimit
        ? { limite: req.dailyLimit, usadoHoje, restante: Math.max(0, req.dailyLimit - usadoHoje) }
        : null,
      // Corte silencioso seria pior que erro: o painel precisa dizer que a lista
      // nao coube inteira.
      truncado: parsed.stats.truncated
        ? `a planilha passou de ${config.dispatch.maxRecipientsPerJob} contatos e foi cortada`
        : null,
    });
  } catch (err) {
    log.error('falha no preview', { message: err.message });
    res.status(400).json({ ok: false, error: 'nao consegui ler a planilha' });
  } finally {
    // O texto do CSV sai de escopo aqui. Nenhuma copia foi feita.
  }
});

// ── Criar e iniciar disparo ───────────────────────────────────────────────
router.post('/jobs', async (req, res) => {
  const {
    senderId,
    templateName,
    language,
    csv: text,
    mapping,
    label,
    headerType,
    headerMediaUrl,
    buttonUrlParam,
    ratePerSecond,
    automation: automationInput,
  } = req.body || {};

  if (!req.allowedSenders.includes(String(senderId))) {
    return res.status(403).json({ ok: false, error: 'numero nao autorizado neste ticket' });
  }
  const sender = meta.senderById(senderId);
  if (!sender) return res.status(404).json({ ok: false, error: 'numero nao configurado' });
  if (!templateName) return res.status(400).json({ ok: false, error: 'templateName obrigatorio' });
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'csv vazio' });
  }

  // Automacao invalida recusa o disparo inteiro: melhor errar aqui do que o
  // cliente descobrir depois que ninguem recebeu resposta.
  const auto = automation.validate(automationInput);
  if (!auto.ok) return res.status(400).json({ ok: false, error: `resposta automatica: ${auto.error}` });

  try {
    const parsed = csvLib.parse(text, { maxRows: config.dispatch.maxRecipientsPerJob });
    if (!parsed.rows.length) {
      return res.status(400).json({ ok: false, error: 'nenhum contato valido na planilha' });
    }

    const { queue, skippedSuppressed } = await dispatch.prepare(parsed.rows, mapping || {});
    // parsed.rows ainda tem os telefones — descarta explicitamente antes de
    // qualquer await longo.
    parsed.rows.length = 0;

    if (!queue.length) {
      return res.status(400).json({ ok: false, error: 'todos os contatos estao na lista de descadastro' });
    }

    // Teto diario do cliente (vem assinado no ticket). Recusa antes de enviar
    // qualquer mensagem — nao corta um disparo pela metade.
    if (req.dailyLimit) {
      const usadoHoje = await store.dayCount(req.tenant);
      if (usadoHoje + queue.length > req.dailyLimit) {
        queue.length = 0;
        return res.status(429).json({
          ok: false,
          error: `teto diario de ${req.dailyLimit} mensagens: ${usadoHoje} ja usadas hoje, sobram ${Math.max(0, req.dailyLimit - usadoHoje)}`,
        });
      }
      await store.addToDayCount(req.tenant, queue.length);
    }

    const jobId = newJobId();
    await store.createJob(jobId, {
      tenant: req.tenant,
      senderId: sender.id,
      senderLabel: sender.label,
      templateName,
      label: String(label || '').slice(0, 60),
      total: queue.length,
      automation: auto.automation,
      skippedSuppressed,
      skippedInvalid: parsed.stats.invalid,
      skippedDuplicate: parsed.stats.duplicate,
    });

    // Nao aguarda: o disparo roda em background e o painel acompanha pelo relatorio.
    dispatch
      .run(jobId, sender, queue, {
        templateName,
        language,
        headerType,
        headerMediaUrl,
        buttonUrlParam,
        ratePerSecond,
      })
      .catch((err) => log.error('disparo interrompido', { jobId, message: err.message }));

    res.json({
      ok: true,
      jobId,
      total: queue.length,
      automacao: auto.automation
        ? { gatilho: auto.automation.trigger, mensagens: auto.automation.steps.length }
        : null,
      skipped: {
        suprimidos: skippedSuppressed,
        invalidos: parsed.stats.invalid,
        duplicados: parsed.stats.duplicate,
      },
    });
  } catch (err) {
    log.error('falha ao criar disparo', { message: err.message });
    res.status(500).json({ ok: false, error: 'falha ao iniciar o disparo' });
  }
});

// ── Cancelar ──────────────────────────────────────────────────────────────
router.post('/jobs/:id/cancel', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job || job.tenant !== req.tenant) return res.status(404).json({ ok: false, error: 'disparo nao encontrado' });
  const cancelled = dispatch.cancel(req.params.id);
  if (!cancelled) await store.setJobStatus(req.params.id, 'cancelled');
  res.json({ ok: true, cancelled: true });
});

module.exports = router;
