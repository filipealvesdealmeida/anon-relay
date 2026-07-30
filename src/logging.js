'use strict';

/**
 * Logger com redacao obrigatoria.
 *
 * Log e um dos vazamentos mais comuns de dado pessoal: alguem faz
 * console.log(payload) num debug, o payload tem o telefone, e o arquivo fica
 * meses no disco. Aqui nao existe caminho pra isso — a unica funcao de log
 * exportada passa TUDO por um redator que apaga qualquer sequencia longa de
 * digitos e qualquer wamid antes de escrever.
 *
 * Redacao e feita mesmo em campo desconhecido: a regra e sobre o formato do
 * dado, nao sobre o nome do campo.
 */

// 8+ digitos seguidos = candidato a telefone. Nao ha caso legitimo de imprimir
// isso aqui (contadores sao pequenos; ids sao base64url).
const LONG_DIGITS = /\d{8,}/g;
// wamid embute o telefone em base64 — nunca vai pro log inteiro.
const WAMID = /wamid\.[A-Za-z0-9_=-]+/g;

function redactString(s) {
  return String(s)
    .replace(WAMID, 'wamid.<redacted>')
    .replace(LONG_DIGITS, (m) => `<${m.length}d>`);
}

function redact(value, depth = 0) {
  if (depth > 6) return '<deep>';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') {
    // Numeros grandes tambem podem ser telefone digitado sem aspas.
    return String(value).length >= 8 ? '<num>' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redact(v, depth + 1);
  }
  return out;
}

function fmt(level, msg, meta) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactString(msg),
  };
  if (meta !== undefined) line.meta = redact(meta);
  return JSON.stringify(line);
}

const log = {
  info: (msg, meta) => console.log(fmt('info', msg, meta)),
  warn: (msg, meta) => console.warn(fmt('warn', msg, meta)),
  error: (msg, meta) => console.error(fmt('error', msg, meta)),
  redact,
  redactString,
};

module.exports = log;
