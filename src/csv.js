'use strict';

/**
 * Parser de CSV proprio, sem dependencia externa.
 *
 * Duas razoes, ambas de auditoria:
 *  1. Menos supply chain — quem le este repo consegue verificar em 5 minutos
 *     que a lista nunca vira arquivo, stream de disco ou buffer compartilhado.
 *  2. Nenhuma biblioteca de upload significa nenhum diretorio temporario.
 *     O conteudo chega como string no corpo JSON, e a string vive so o tempo
 *     do request.
 *
 * Nada aqui escreve em disco. Nada aqui loga conteudo de linha.
 */

const DELIMITERS = [',', ';', '\t', '|'];

/** Escolhe o delimitador que produz mais colunas consistentes no cabecalho. */
function detectDelimiter(sample) {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = splitLine(sample, d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Split de UMA linha respeitando aspas duplas (com escape "" interno). */
function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Quebra o texto em linhas logicas, respeitando quebras dentro de aspas.
 * Aceita \r\n, \n e \r.
 */
function splitRows(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rows.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length) rows.push(cur);
  return rows;
}

function normalizeHeader(h) {
  return String(h || '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const PHONE_HEADERS = ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'fone', 'contato', 'tel', 'msisdn'];
const NAME_HEADERS = ['nome', 'name', 'primeiro nome', 'primeironome', 'first name', 'firstname', 'cliente', 'contato nome'];

/**
 * Normalizacao BR — mesma regra do sistema principal: movel brasileiro tem 13
 * digitos (55 + DDD + 9 + 8). Planilhas costumam vir com 12.
 */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return '';
  // Numero digitado sem o codigo do pais (10 ou 11 digitos) — assume Brasil.
  if (p.length === 10 || p.length === 11) p = `55${p}`;
  if (p.length === 12 && p.startsWith('55')) p = `${p.slice(0, 4)}9${p.slice(4)}`;
  return p;
}

function isPlausiblePhone(p) {
  if (!/^\d+$/.test(p)) return false;
  if (p.length < 11 || p.length > 15) return false;
  // BR: exige 13 digitos e DDD valido (11-99).
  if (p.startsWith('55')) {
    if (p.length !== 13) return false;
    const ddd = parseInt(p.slice(2, 4), 10);
    if (!(ddd >= 11 && ddd <= 99)) return false;
    // Movel brasileiro sempre comeca com 9 apos o DDD.
    if (p[4] !== '9') return false;
  }
  return true;
}

/** Primeiro nome, capitalizado. Usado so como variavel do template, em memoria. */
function firstName(raw) {
  const cleaned = String(raw || '')
    .replace(/[^\p{L}\p{M}\s'-]/gu, ' ')
    .trim();
  if (!cleaned) return '';
  const first = cleaned.split(/\s+/)[0];
  if (first.length < 2) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Le o texto do CSV e devolve as linhas ja normalizadas.
 * Retorna apenas o necessario pro envio; a string original nao e guardada.
 *
 * @returns {{ headers: string[], rows: Array<{phone:string,fields:Object}>, stats: Object }}
 */
function parse(text, options = {}) {
  const maxRows = options.maxRows || 100000;
  const rawRows = splitRows(String(text || '')).filter((r) => r.trim() !== '');
  if (!rawRows.length) {
    return { headers: [], rows: [], stats: { total: 0, invalid: 0, duplicate: 0 } };
  }

  const delimiter = options.delimiter || detectDelimiter(rawRows[0]);
  const headerCells = splitLine(rawRows[0], delimiter).map(normalizeHeader);

  // Planilha sem cabecalho: se a primeira linha ja parece um telefone, tratamos
  // tudo como dado e batizamos as colunas de col1, col2...
  const headerLooksLikeData = isPlausiblePhone(normalizePhone(headerCells[0]));
  const headers = headerLooksLikeData
    ? headerCells.map((_, i) => `col${i + 1}`)
    : headerCells;
  const startIdx = headerLooksLikeData ? 0 : 1;

  let phoneIdx = headers.findIndex((h) => PHONE_HEADERS.includes(h));
  if (phoneIdx === -1) phoneIdx = headers.findIndex((h) => PHONE_HEADERS.some((p) => h.includes(p)));
  const nameIdx = headers.findIndex((h) => NAME_HEADERS.includes(h) || NAME_HEADERS.some((n) => h.includes(n)));

  const rows = [];
  // truncated avisa quando a planilha passou do teto — corte silencioso faria
  // o painel dizer "tudo certo" sobre uma lista que ficou pela metade.
  const stats = { total: 0, invalid: 0, duplicate: 0, truncated: false };
  const seen = new Set();

  for (let i = startIdx; i < rawRows.length && rows.length < maxRows; i++) {
    const cells = splitLine(rawRows[i], delimiter);
    stats.total++;

    // Sem coluna identificada, procura o primeiro campo que vira telefone valido.
    let phone = '';
    if (phoneIdx >= 0) {
      phone = normalizePhone(cells[phoneIdx]);
    } else {
      for (const c of cells) {
        const cand = normalizePhone(c);
        if (isPlausiblePhone(cand)) {
          phone = cand;
          break;
        }
      }
    }

    if (!isPlausiblePhone(phone)) {
      stats.invalid++;
      continue;
    }
    if (seen.has(phone)) {
      stats.duplicate++;
      continue;
    }
    seen.add(phone);

    const fields = {};
    headers.forEach((h, idx) => {
      if (idx === phoneIdx) return;
      const v = (cells[idx] || '').trim();
      if (v) fields[h] = v;
    });
    if (nameIdx >= 0 && cells[nameIdx]) {
      fields.__first_name = firstName(cells[nameIdx]);
    }

    rows.push({ phone, fields });
  }

  stats.truncated = rows.length >= maxRows && startIdx + rows.length < rawRows.length;

  // seen guarda telefones em memoria durante o parse. Limpar explicitamente
  // reduz a janela em que eles existem no heap.
  seen.clear();

  return { headers, rows, stats, delimiter, phoneColumn: phoneIdx >= 0 ? headers[phoneIdx] : null };
}

/**
 * Resolve as variaveis do template pra uma linha.
 * mapping: { "1": {type:'column'|'text'|'firstName', value?:string} }
 */
function resolveVariables(mapping, row) {
  const out = [];
  const keys = Object.keys(mapping || {}).sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    const spec = mapping[key] || {};
    let value = '';
    if (spec.type === 'text') value = String(spec.value ?? '');
    else if (spec.type === 'firstName') value = row.fields.__first_name || String(spec.fallback || '');
    else if (spec.type === 'column') value = String(row.fields[normalizeHeader(spec.value)] ?? '');
    if (!value.trim() && spec.fallback) value = String(spec.fallback);
    // A Meta rejeita variavel vazia (#131008) e quebraria a mensagem inteira.
    out.push(value.trim() === '' ? '-' : value.trim());
  }
  return out;
}

module.exports = {
  parse,
  splitLine,
  splitRows,
  detectDelimiter,
  normalizePhone,
  isPlausiblePhone,
  firstName,
  normalizeHeader,
  resolveVariables,
};
