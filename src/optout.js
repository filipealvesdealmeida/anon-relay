'use strict';

/**
 * Deteccao de pedido de descadastro.
 *
 * Quando alguem responde "sair", o numero entra na lista de supressao — em
 * forma de hash — e nunca mais recebe. Esta e a unica memoria de longo prazo
 * do servico, e existe porque a alternativa (esquecer tambem o "nao quero")
 * seria pior pra propria pessoa.
 */

const KEYWORDS = [
  'sair',
  'sai',
  'parar',
  'pare',
  'para',
  'cancelar',
  'cancela',
  'descadastrar',
  'descadastro',
  'remover',
  'remove',
  'stop',
  'unsubscribe',
  'nao quero',
  'não quero',
  'nao envie',
  'não envie',
  'nao me mande',
  'não me mande',
  'me tira',
  'me tire',
  'sem interesse',
  'nao tenho interesse',
  'não tenho interesse',
];

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mensagem curta e igual a uma palavra-chave, ou contendo uma frase de recusa.
 * O limite de tamanho evita que "nao quero perder essa oportunidade" vire
 * opt-out.
 */
function isOptOut(text) {
  const t = normalizeForMatch(text);
  if (!t) return false;
  if (t.length <= 24 && KEYWORDS.includes(t)) return true;
  if (t.length <= 60) {
    return KEYWORDS.some((k) => k.includes(' ') && t.includes(normalizeForMatch(k)));
  }
  return false;
}

module.exports = { isOptOut, KEYWORDS, normalizeForMatch };
