'use strict';

/**
 * Automação sem memória de contato.
 *
 * A automação é o ponto onde seria mais fácil e mais tentador guardar o
 * telefone: um fluxo com atrasos pede uma fila, e uma fila pede persistência.
 * Aqui ela roda em memória, e este teste confirma duas coisas:
 * que ela de fato responde, e que continua sem deixar rastro.
 */

// Os arquivos de teste rodam em paralelo. Prefixo proprio pra este nao disputar
// as mesmas chaves do teste de nao-retencao.
process.env.REDIS_PREFIX = (process.env.REDIS_PREFIX || 'anontest:').replace(/:$/, '') + '-auto:';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const automation = require('../src/automation');
const { processWebhookPayload } = require('../src/webhook-processor');
const { phoneKey, optOutKey } = require('../src/hashing');

const SENDER_ID = '999888777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A automação envia por meta.sendText, que usa fetch. Interceptamos para
// registrar o que sairia — inclusive o destinatário, que o teste precisa ver
// para confirmar que a mensagem foi para a pessoa certa.
function mockFetch() {
  const enviados = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (!href.includes('graph.facebook.com')) return original(url, options);
    const body = JSON.parse(options.body);
    enviados.push({ to: body.to, type: body.type, text: body.text?.body });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.RESP' + enviados.length }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { enviados, restore: () => { global.fetch = original; } };
}

function inbound(from, text, extra = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: SENDER_ID },
              messages: [{ from, id: 'wamid.IN' + Math.round(Date.now() % 100000), type: 'text', text: { body: text }, ...extra }],
            },
          },
        ],
      },
    ],
  };
}

async function criarJob(id, auto) {
  await store.createJob(id, {
    tenant: 'tenant-teste',
    senderId: SENDER_ID,
    senderLabel: 'Numero de teste',
    templateName: 'modelo',
    total: 10,
    automation: auto,
  });
  // O inbound sem citação é atribuído pelo número remetente reservado ao job.
  await store.redis.set(store.keys.senderActive(SENDER_ID), id, 'EX', 3600);
}

async function limpar(id) {
  await store.redis.del(`job:${id}`, `job:${id}:resp`, `job:${id}:err`);
  await store.redis.del(store.keys.senderActive(SENDER_ID));
  await store.redis.del(store.keys.tenantJobs('tenant-teste'));
}

// ── Validação ─────────────────────────────────────────────────────────────

test('recusa automacao malformada em vez de consertar sozinha', () => {
  assert.equal(automation.validate({ enabled: true, steps: [] }).ok, false);
  assert.equal(automation.validate({ enabled: true, trigger: 'keyword', keywords: [], steps: [{ text: 'oi' }] }).ok, false);
  assert.equal(automation.validate({ enabled: true, steps: [{ text: '' }] }).ok, false);
  assert.equal(automation.validate({ enabled: true, steps: [{ text: 'x'.repeat(2000) }] }).ok, false);
  assert.equal(automation.validate({ enabled: true, steps: Array(9).fill({ text: 'oi' }) }).ok, false);
  // Fluxo longo demais para sobreviver sem persistência.
  assert.equal(
    automation.validate({ enabled: true, steps: [{ text: 'a', delaySeconds: 3600 }, { text: 'b', delaySeconds: 3600 }, { text: 'c', delaySeconds: 3600 }, { text: 'd', delaySeconds: 3600 }, { text: 'e', delaySeconds: 3600 }] }).ok,
    false
  );
});

test('aceita automacao valida e normaliza os limites', () => {
  const r = automation.validate({
    enabled: true,
    trigger: 'keyword',
    keywords: ['quero', ' SIM '],
    steps: [{ text: ' primeiro ', delaySeconds: -5 }, { text: 'segundo', delaySeconds: 99999 }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.automation.keywords, ['quero', 'SIM']);
  assert.equal(r.automation.steps[0].delaySeconds, 0);
  assert.equal(r.automation.steps[1].delaySeconds, 3600, 'atraso é limitado, não recusado');
  assert.equal(r.automation.steps[0].text, 'primeiro');
});

test('automacao desligada nao vira configuracao', () => {
  assert.deepEqual(automation.validate(null), { ok: true, automation: null });
  assert.deepEqual(automation.validate({ enabled: false }), { ok: true, automation: null });
});

// ── Gatilhos ──────────────────────────────────────────────────────────────

test('gatilho any responde qualquer coisa', () => {
  const a = { enabled: true, trigger: 'any', keywords: [], steps: [] };
  assert.equal(automation.matches(a, { text: 'qualquer coisa', isButton: false }), true);
});

test('gatilho button so responde a botao', () => {
  const a = { enabled: true, trigger: 'button', keywords: [], steps: [] };
  assert.equal(automation.matches(a, { text: 'CONFIRMAR', isButton: true }), true);
  assert.equal(automation.matches(a, { text: 'CONFIRMAR', isButton: false }), false);
});

test('gatilho keyword exige a mensagem inteira, como no sistema principal', () => {
  const a = { enabled: true, trigger: 'keyword', keywords: ['quero', 'tenho interesse'], steps: [] };
  assert.equal(automation.matches(a, { text: 'Quero!' }), true, 'case e pontuacao normalizados');
  assert.equal(automation.matches(a, { text: 'TENHO INTERESSE' }), true);
  assert.equal(automation.matches(a, { text: 'quero saber mais' }), false, 'nao e busca de trecho');
  assert.equal(automation.matches(a, { text: '' }), false);
});

// ── Execução ──────────────────────────────────────────────────────────────

test('responde quem interage e conta no relatorio, sem guardar o numero', async (t) => {
  const { enviados, restore } = mockFetch();
  const jobId = 'auto-' + Date.now().toString(36);
  const phone = '5562991110001';

  t.after(async () => {
    restore();
    automation.atendidos.clear();
    await limpar(jobId);
  });

  await criarJob(jobId, {
    enabled: true,
    trigger: 'any',
    keywords: [],
    steps: [{ text: 'Oi! Recebi sua mensagem.', delaySeconds: 0 }, { text: 'Um consultor assume daqui.', delaySeconds: 0 }],
  });

  const counts = await processWebhookPayload(inbound(phone, 'quero saber mais'));
  assert.equal(counts.automacoes, 1);
  await sleep(150); // o fluxo roda solto

  assert.equal(enviados.length, 2, 'as duas mensagens do fluxo saíram');
  assert.equal(enviados[0].to, phone, 'foram para quem escreveu');
  assert.equal(enviados[0].text, 'Oi! Recebi sua mensagem.');

  const job = await store.getJob(jobId);
  assert.equal(parseInt(job.autoReplies, 10), 2);
  assert.equal(await store.countResponders(jobId), 1);

  // O que sobrou no armazenamento não pode conter o telefone.
  const hash = await store.redis.hgetall(`job:${jobId}`);
  const serializado = JSON.stringify(hash);
  assert.ok(!serializado.includes(phone), 'o hash do job nao pode conter o telefone');
  assert.ok(!serializado.includes('991110001'), 'nem um pedaco dele');
  assert.ok(serializado.includes('automation'), 'mas a configuracao da automacao esta la');
});

test('um contato recebe o fluxo uma vez, nao a cada mensagem', async (t) => {
  const { enviados, restore } = mockFetch();
  const jobId = 'auto2-' + Date.now().toString(36);
  const phone = '5562991110002';

  t.after(async () => {
    restore();
    automation.atendidos.clear();
    await limpar(jobId);
  });

  await criarJob(jobId, { enabled: true, trigger: 'any', keywords: [], steps: [{ text: 'resposta unica', delaySeconds: 0 }] });

  await processWebhookPayload(inbound(phone, 'oi'));
  await sleep(80);
  await processWebhookPayload(inbound(phone, 'alguem ai?'));
  await sleep(80);
  await processWebhookPayload(inbound(phone, 'ainda quero'));
  await sleep(80);

  assert.equal(enviados.length, 1, 'tres mensagens, um fluxo');
  const job = await store.getJob(jobId);
  assert.equal(parseInt(job.autoReplies, 10), 1);
});

test('quem pede descadastro recebe silencio, nao automacao', async (t) => {
  const { enviados, restore } = mockFetch();
  const jobId = 'auto3-' + Date.now().toString(36);
  const phone = '5562991110003';

  t.after(async () => {
    restore();
    automation.atendidos.clear();
    await store.redis.del(`sup:${optOutKey(phone)}`);
    await limpar(jobId);
  });

  await criarJob(jobId, { enabled: true, trigger: 'any', keywords: [], steps: [{ text: 'nao deveria sair', delaySeconds: 0 }] });

  const counts = await processWebhookPayload(inbound(phone, 'SAIR'));
  await sleep(120);

  assert.equal(counts.descadastros, 1);
  assert.equal(counts.automacoes, 0);
  assert.equal(enviados.length, 0, 'nenhuma mensagem foi enviada a quem pediu para sair');

  const suprimido = await store.filterSuppressed([optOutKey(phone)]);
  assert.equal(suprimido.size, 1, 'e ele entrou na lista de descadastro');
});

test('disparo sem automacao nao responde nada', async (t) => {
  const { enviados, restore } = mockFetch();
  const jobId = 'auto4-' + Date.now().toString(36);

  t.after(async () => {
    restore();
    automation.atendidos.clear();
    await limpar(jobId);
  });

  await criarJob(jobId, null);
  const counts = await processWebhookPayload(inbound('5562991110004', 'oi'));
  await sleep(80);

  assert.equal(counts.respostas, 1, 'a resposta ainda conta no relatorio');
  assert.equal(counts.automacoes, 0);
  assert.equal(enviados.length, 0);
});

test('o anti-repeticao guarda hash, nunca telefone', async (t) => {
  const { restore } = mockFetch();
  const jobId = 'auto5-' + Date.now().toString(36);
  const phone = '5562991110005';

  t.after(async () => {
    restore();
    automation.atendidos.clear();
    await limpar(jobId);
  });

  await criarJob(jobId, { enabled: true, trigger: 'any', keywords: [], steps: [{ text: 'oi', delaySeconds: 0 }] });
  await processWebhookPayload(inbound(phone, 'oi'));
  await sleep(80);

  const chaves = [...automation.atendidos.keys()];
  assert.equal(chaves.length, 1);
  assert.ok(!chaves[0].includes(phone), 'a chave em memoria nao contem o telefone');
  assert.ok(chaves[0].includes(phoneKey(phone)), 'contem o hash dele');
});

test('encerra a conexao', async () => {
  await store.close();
});
