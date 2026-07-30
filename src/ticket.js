'use strict';

/**
 * Tickets de acesso.
 *
 * O relay nao tem usuarios, nem senhas, nem sessao, nem banco pra consultar
 * qualquer uma dessas coisas. Quem autentica e o sistema principal; ele emite
 * um ticket assinado com um segredo compartilhado e o painel envia esse ticket
 * a cada chamada.
 *
 * O que o ticket carrega e deliberadamente pobre:
 *   t   tenant  — HMAC do userId. O relay nunca sabe QUEM e o cliente.
 *   s   senders — ids de numero que este ticket pode usar
 *   d   teto diario de mensagens (0 = sem teto)
 *   exp expira em (epoch segundos)
 *   jti id do ticket (so pra log)
 *
 * Formato: v1.<payload base64url>.<hmac base64url>
 */

const crypto = require('crypto');
const config = require('./config');
const { safeEqual } = require('./hashing');

const VERSION = 'v1';
const DEFAULT_TTL_SEC = 30 * 60;

function sign(payload, secret = config.secrets.ticket) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('base64url');
  return `${VERSION}.${body}.${sig}`;
}

function issue({ tenant, senders, dailyLimit = 0, ttlSec = DEFAULT_TTL_SEC }, secret) {
  return sign(
    {
      t: tenant,
      s: senders,
      d: dailyLimit,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
      jti: crypto.randomBytes(8).toString('base64url'),
    },
    secret
  );
}

/** @returns {{ok:true, claims:Object} | {ok:false, error:string}} */
function verify(token, secret = config.secrets.ticket) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'ticket ausente' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, error: 'formato invalido' };
  const [, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('base64url');
  if (!safeEqual(sig, expected)) return { ok: false, error: 'assinatura invalida' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, error: 'payload ilegivel' };
  }
  if (!claims.t) return { ok: false, error: 'tenant ausente' };
  if (!claims.exp || claims.exp * 1000 < Date.now()) return { ok: false, error: 'ticket expirado' };
  return { ok: true, claims };
}

/** Middleware express: exige ticket valido e popula req.tenant / req.allowedSenders. */
function requireTicket(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-anon-ticket');
  const result = verify(token);
  if (!result.ok) {
    return res.status(401).json({ ok: false, error: result.error });
  }
  req.tenant = result.claims.t;
  req.allowedSenders = Array.isArray(result.claims.s) ? result.claims.s : [];
  req.dailyLimit = parseInt(result.claims.d, 10) || 0;
  req.ticketId = result.claims.jti;
  return next();
}

module.exports = { issue, sign, verify, requireTicket, DEFAULT_TTL_SEC };
