'use strict';

/**
 * Cliente da Meta Cloud API — usa o fetch nativo do Node (sem axios).
 *
 * Este e o unico ponto do sistema onde um numero de telefone sai do processo.
 * Ele vai pro destino que a operacao exige (a propria Meta) e nao e registrado
 * em lugar nenhum: nem no retorno da funcao, nem em log, nem em metrica.
 */

const config = require('./config');
const log = require('./logging');
const { maskPhone } = require('./hashing');

// Endereco da Graph API. Sobrescrever so serve pra teste de integracao local
// (apontar pra um servidor que imita a Meta) — em producao o valor default e o
// unico destino pra onde um numero desta ferramenta pode sair.
const BASE = process.env.META_GRAPH_BASE
  ? String(process.env.META_GRAPH_BASE).replace(/\/$/, '')
  : `https://graph.facebook.com/${config.meta.graphVersion}`;

function senderById(id) {
  return config.senders.find((s) => s.id === String(id)) || null;
}

async function metaFetch(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { raw: text.slice(0, 400) };
    }
    return { status: res.status, ok: res.ok, body: json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia um template. Retorna { ok, wamid?, errorCode?, errorMessage?, retryable? }.
 * O parametro `to` nao aparece no retorno de proposito.
 */
async function sendTemplate(sender, { to, templateName, language, variables, headerMediaUrl, headerType, buttonUrlParam }) {
  const components = [];

  if (headerType && headerMediaUrl) {
    const ref = { link: headerMediaUrl };
    if (headerType === 'IMAGE') components.push({ type: 'header', parameters: [{ type: 'image', image: ref }] });
    if (headerType === 'VIDEO') components.push({ type: 'header', parameters: [{ type: 'video', video: ref }] });
    if (headerType === 'DOCUMENT') components.push({ type: 'header', parameters: [{ type: 'document', document: ref }] });
  }

  if (variables && variables.length) {
    components.push({
      type: 'body',
      parameters: variables.map((v) => ({ type: 'text', text: String(v ?? '').trim() || '-' })),
    });
  }

  if (buttonUrlParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(buttonUrlParam) }],
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: templateName, language: { code: language || 'pt_BR' }, components },
  };

  const { status, ok, body } = await metaFetch(`${BASE}/${sender.id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sender.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (ok && body?.messages?.[0]?.id) {
    return { ok: true, wamid: body.messages[0].id };
  }

  const err = body?.error || {};
  const retryable = status >= 500 || status === 429 || [130429, 131048, 368, 1, 2, 4].includes(err.code);
  // O log carrega o destino mascarado — util pra suporte, inutil pra reidentificar.
  log.warn('envio recusado pela Meta', {
    sender: sender.id,
    to: maskPhone(to),
    status,
    code: err.code || null,
    title: (err.error_data?.details || err.message || '').slice(0, 160),
  });
  return {
    ok: false,
    errorCode: err.code != null ? String(err.code) : String(status),
    errorMessage: (err.message || 'erro desconhecido').slice(0, 200),
    retryable,
  };
}

/** Lista templates aprovados da WABA. Metadado de conta — nao ha dado pessoal aqui. */
async function listTemplates(sender) {
  if (!sender.wabaId) return { ok: false, error: 'sender sem wabaId configurado', templates: [] };
  const url = `${BASE}/${sender.wabaId}/message_templates?limit=200&fields=name,status,language,category,components`;
  const { ok, body } = await metaFetch(url, {
    headers: { Authorization: `Bearer ${sender.token}` },
  });
  if (!ok) {
    return { ok: false, error: body?.error?.message || 'falha ao consultar templates', templates: [] };
  }
  const templates = (body?.data || [])
    .filter((t) => t.status === 'APPROVED')
    .map((t) => {
      const bodyComp = (t.components || []).find((c) => c.type === 'BODY');
      const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
      const text = bodyComp?.text || '';
      const varCount = (text.match(/\{\{\d+\}\}/g) || []).length;
      return {
        name: t.name,
        language: t.language,
        category: t.category,
        bodyText: text,
        headerFormat: headerComp?.format || null,
        variableCount: varCount,
      };
    });
  return { ok: true, templates };
}

module.exports = { sendTemplate, listTemplates, senderById, metaFetch, BASE };
