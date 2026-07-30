'use strict';

/**
 * Resposta automática — automação sem memória de quem é o contato.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * O PROBLEMA
 * ────────────────────────────────────────────────────────────────────────────
 * Automação normalmente funciona assim: alguém responde, o sistema grava a
 * conversa, enfileira os passos do fluxo com o telefone dentro do payload, e um
 * worker executa cada passo lendo aquele telefone do banco.
 *
 * Aqui não existe banco, não existe conversa gravada e não pode existir fila
 * com telefone dentro. Então o desenho é outro:
 *
 *   O telefone chega no webhook, entra no closure desta função e vive apenas
 *   enquanto os passos rodam. Os atrasos entre passos são setTimeout na
 *   memória do processo — não uma fila persistida. Quando o último passo
 *   termina, a referência morre e não sobrou nada em lugar nenhum.
 *
 * CONSEQUÊNCIA ASSUMIDA, igual à do disparo: se o processo reiniciar no meio de
 * um fluxo, os passos que faltavam se perdem. Persistir para sobreviver ao
 * restart seria persistir o telefone — exatamente o que este serviço promete
 * não fazer. Por isso os atrasos são curtos por limite duro (ver LIMITES).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONDE A CONFIGURAÇÃO VIVE
 * ────────────────────────────────────────────────────────────────────────────
 * No próprio disparo. A automação é definida junto com o envio e guardada no
 * hash do job — é configuração do cliente (texto das mensagens, gatilho), não
 * dado de ninguém. Quando um retorno chega, o disparo é identificado pelo HMAC
 * do wamid e a automação daquele disparo é a que roda.
 */

const meta = require('./meta');
const store = require('./store');
const log = require('./logging');
const { phoneKey } = require('./hashing');
const { normalizeForMatch } = require('./optout');

// ── LIMITES ────────────────────────────────────────────────────────────────
// Existem por três razões: janela de 24h da Meta, risco de troca infinita de
// mensagens com robô do outro lado, e a impossibilidade de retomar após restart.
const MAX_STEPS = 5;
const MAX_STEP_DELAY_SEC = 3600; // 1 hora entre passos
const MAX_TOTAL_DELAY_SEC = 4 * 3600; // 4 horas de fluxo
const MAX_TEXT = 900;

/**
 * Contatos já atendidos, por disparo. Vive em memória e some com o processo —
 * é anti-loop, não histórico. Guarda hash, nunca telefone, porque nem para isto
 * o número precisa existir fora do instante do atendimento.
 */
const atendidos = new Map(); // `${jobId}:${phoneHash}` -> timestamp
const JANELA_ANTI_REPETICAO_MS = 12 * 3600 * 1000;

function limparAtendidosVelhos() {
  const limite = Date.now() - JANELA_ANTI_REPETICAO_MS;
  for (const [k, ts] of atendidos) if (ts < limite) atendidos.delete(k);
}
setInterval(limparAtendidosVelhos, 30 * 60 * 1000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Valida e normaliza a automação recebida do painel. Recusa configuração
 * inválida em vez de "corrigir" silenciosamente.
 * @returns {{ok:true, automation:Object|null} | {ok:false, error:string}}
 */
function validate(input) {
  if (!input || input.enabled === false) return { ok: true, automation: null };

  const gatilho = String(input.trigger || 'any');
  if (!['any', 'button', 'keyword'].includes(gatilho)) {
    return { ok: false, error: 'gatilho invalido (use any, button ou keyword)' };
  }

  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 20)
    : [];
  if (gatilho === 'keyword' && !keywords.length) {
    return { ok: false, error: 'gatilho keyword exige ao menos uma palavra' };
  }

  const passos = Array.isArray(input.steps) ? input.steps : [];
  if (!passos.length) return { ok: false, error: 'automacao sem nenhuma mensagem' };
  if (passos.length > MAX_STEPS) return { ok: false, error: `maximo de ${MAX_STEPS} mensagens` };

  let totalDelay = 0;
  const steps = [];
  for (const p of passos) {
    const text = String(p?.text || '').trim();
    if (!text) return { ok: false, error: 'ha uma mensagem vazia na automacao' };
    if (text.length > MAX_TEXT) return { ok: false, error: `mensagem acima de ${MAX_TEXT} caracteres` };
    const delay = Math.max(0, Math.min(parseInt(p?.delaySeconds, 10) || 0, MAX_STEP_DELAY_SEC));
    totalDelay += delay;
    steps.push({ text: text.slice(0, MAX_TEXT), delaySeconds: delay });
  }
  if (totalDelay > MAX_TOTAL_DELAY_SEC) {
    return { ok: false, error: `o fluxo inteiro nao pode passar de ${MAX_TOTAL_DELAY_SEC / 3600} horas` };
  }

  return { ok: true, automation: { enabled: true, trigger: gatilho, keywords, steps } };
}

/** O retorno do contato dispara esta automação? */
function matches(automation, { text, isButton }) {
  if (!automation?.enabled) return false;
  if (automation.trigger === 'any') return true;
  if (automation.trigger === 'button') return !!isButton;
  if (automation.trigger === 'keyword') {
    const alvo = normalizeForMatch(text);
    if (!alvo) return false;
    // Mesma regra do sistema principal: a mensagem inteira é igual a uma das
    // frases. "quero" bate com "quero"; "quero saber mais" não.
    return automation.keywords.some((k) => normalizeForMatch(k) === alvo);
  }
  return false;
}

/**
 * Executa o fluxo. O telefone entra por parâmetro, vive no closure e não é
 * escrito em lugar nenhum — nem em log, nem em contador, nem em índice.
 *
 * Não é await-ado pelo webhook: os passos rodam soltos enquanto o handler já
 * respondeu 200 para a Meta.
 */
async function run(jobId, sender, phone, automation) {
  const chave = `${jobId}:${phoneKey(phone)}`;

  // Um contato, um fluxo. Sem isto, cada mensagem que a pessoa mandasse
  // reiniciaria a automação inteira.
  if (atendidos.has(chave)) return { skipped: 'ja_atendido' };
  atendidos.set(chave, Date.now());

  let enviadas = 0;
  try {
    for (const [i, step] of automation.steps.entries()) {
      if (step.delaySeconds > 0) await sleep(step.delaySeconds * 1000);

      const r = await meta.sendText(sender, phone, step.text);
      if (r.ok) {
        enviadas++;
        await store.incrJob(jobId, 'autoReplies', 1);
      } else {
        // 131047 = janela de 24h fechada. Adiantar os próximos passos não
        // adianta: eles falhariam igual.
        await store.recordError(jobId, `auto:${r.errorCode}`);
        log.warn('fluxo interrompido', { jobId, passo: i + 1, code: r.errorCode });
        break;
      }
    }
  } catch (err) {
    log.error('falha na resposta automatica', { jobId, message: err.message });
  }

  return { enviadas };
}

module.exports = {
  validate,
  matches,
  run,
  atendidos,
  LIMITES: { MAX_STEPS, MAX_STEP_DELAY_SEC, MAX_TOTAL_DELAY_SEC, MAX_TEXT },
};
