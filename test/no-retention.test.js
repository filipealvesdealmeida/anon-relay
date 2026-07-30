'use strict';

/**
 * O teste que sustenta a promessa do produto.
 *
 * Roda um disparo completo contra uma Meta simulada — incluindo os wamids que
 * embutem o telefone em base64, como os reais — processa os webhooks de
 * entrega, leitura, resposta e descadastro, e depois varre TODO o
 * armazenamento atras de qualquer sequencia com formato de telefone.
 *
 * Se alguem, algum dia, adicionar uma escrita que guarde numero, este teste
 * quebra e o CI reprova antes de qualquer imagem ser publicada.
 *
 * Requer Redis local (o CI sobe um service container).
 */

// Prefixo proprio: os arquivos de teste rodam em paralelo e a varredura daqui
// olha TODAS as chaves do namespace — precisa ver so as suas.
process.env.REDIS_PREFIX = (process.env.REDIS_PREFIX || 'anontest:').replace(/:$/, '') + '-ret:';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const dispatch = require('../src/dispatch');
const csvLib = require('../src/csv');
const { wamidKey } = require('../src/hashing');
const { processWebhookPayload } = require('../src/webhook-processor');

const SENDER = { id: '999888777', label: 'Numero de teste', token: 'token-falso' };
const TOTAL = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Numeros de teste: 55 + 62 + 9 + 8 digitos. */
function fakePhone(i) {
  return `55629${String(90000000 + i)}`;
}

/**
 * wamid no formato real: o identificador da Cloud API embute o numero do
 * destinatario em base64. Se o servico guardasse o wamid cru, guardaria o
 * telefone — e a varredura abaixo acusaria.
 */
function fakeWamid(phone, i) {
  const embutido = Buffer.from(phone).toString('base64');
  return `wamid.HBgN${embutido}FQIAERgSN${i}ABCDEF0123456789`;
}

/** Meta simulada. Encaminha ao fetch real qualquer coisa que nao seja o Graph. */
function installFetchMock(capture) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (!href.includes('graph.facebook.com')) return original(url, options);

    const body = JSON.parse(options.body);
    const phone = body.to;
    // Um numero e recusado pela Meta pra exercitar o caminho de falha.
    if (phone.endsWith('00005')) {
      return new Response(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const wamid = fakeWamid(phone, capture.length);
    capture.push({ wamid, phone });
    return new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => {
    global.fetch = original;
  };
}

async function limparNamespace() {
  const prefix = process.env.REDIS_PREFIX;
  let cursor = '0';
  do {
    const [next, keys] = await store.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) {
      // ioredis prefixa comandos; SCAN devolve a chave completa.
      await store.redis.del(...keys.map((k) => k.slice(prefix.length)));
    }
  } while (cursor !== '0');
}

/** Varre tudo e devolve os achados com formato de telefone. */
async function varrer() {
  const prefix = process.env.REDIS_PREFIX;
  const PHONE_LIKE = /\d{8,}/;
  const IGNORAR = new Set(['createdAt', 'startedAt', 'finishedAt']);
  const achados = [];
  let chaves = 0;
  let cursor = '0';

  do {
    const [next, keys] = await store.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    for (const full of keys) {
      chaves++;
      const key = full.slice(prefix.length);
      // Sem excecao: nenhuma chave pode conter sequencia longa de digitos.
      if (PHONE_LIKE.test(key)) {
        achados.push(`${key} :: nome da chave`);
      }
      const tipo = await store.redis.type(key);
      if (tipo === 'string') {
        const v = await store.redis.get(key);
        if (v && PHONE_LIKE.test(v)) achados.push(`${key} :: valor "${v}"`);
      } else if (tipo === 'hash') {
        const h = await store.redis.hgetall(key);
        for (const [f, v] of Object.entries(h)) {
          if (IGNORAR.has(f)) continue;
          if (PHONE_LIKE.test(String(v))) achados.push(`${key} :: campo ${f} = "${v}"`);
        }
      }
    }
  } while (cursor !== '0');

  return { chaves, achados };
}

test('disparo completo nao deixa nenhum numero no armazenamento', async (t) => {
  await limparNamespace();

  const enviados = [];
  const restaurarFetch = installFetchMock(enviados);

  t.after(async () => {
    restaurarFetch();
    await limparNamespace();
  });

  // ── 1. Planilha em memoria ───────────────────────────────────────────────
  const linhas = ['nome,telefone'];
  for (let i = 0; i < TOTAL; i++) linhas.push(`Contato ${i},${fakePhone(i)}`);
  const parsed = csvLib.parse(linhas.join('\n'));
  assert.equal(parsed.rows.length, TOTAL);

  // ── 2. Preparo e disparo ─────────────────────────────────────────────────
  const { queue } = await dispatch.prepare(parsed.rows, { 1: { type: 'firstName', fallback: 'tudo bem' } });
  parsed.rows.length = 0;
  assert.equal(queue.length, TOTAL);

  const jobId = 'teste-' + Date.now().toString(36);
  await store.createJob(jobId, {
    tenant: 'tenant-de-teste',
    senderId: SENDER.id,
    senderLabel: SENDER.label,
    templateName: 'modelo_teste',
    total: queue.length,
  });

  await dispatch.run(jobId, SENDER, queue, { templateName: 'modelo_teste', language: 'pt_BR', ratePerSecond: 80 });

  const depoisDoEnvio = await store.getJob(jobId);
  assert.equal(parseInt(depoisDoEnvio.sent, 10), TOTAL - 1, 'um numero foi recusado pela Meta simulada');
  assert.equal(parseInt(depoisDoEnvio.failed, 10), 1);
  assert.equal(depoisDoEnvio.status, 'sent');

  // ── 3. Webhooks de status ────────────────────────────────────────────────
  // Passa pelo mesmo processador que o handler HTTP chama — o payload vai e
  // volta serializado em JSON, como chegaria da Meta.
  const postar = async (payload) => {
    await processWebhookPayload(JSON.parse(JSON.stringify(payload)));
  };

  const statuses = (lista, status) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: SENDER.id },
              statuses: lista.map((e) => ({
                id: e.wamid,
                status,
                // A Meta manda o telefone aqui. O servico nao pode le-lo.
                recipient_id: e.phone,
                timestamp: '1700000000',
              })),
            },
          },
        ],
      },
    ],
  });

  await postar(statuses(enviados, 'delivered'));
  await postar(statuses(enviados.slice(0, 20), 'read'));

  // ── 4. Respostas (uma citando a mensagem, outra livre) e um descadastro ──
  await postar({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: SENDER.id },
              messages: [
                {
                  from: enviados[0].phone,
                  id: 'wamid.INBOUND1',
                  type: 'text',
                  text: { body: 'tenho interesse sim, pode mandar' },
                  context: { id: enviados[0].wamid },
                },
                {
                  from: enviados[1].phone,
                  id: 'wamid.INBOUND2',
                  type: 'text',
                  text: { body: 'quanto custa?' },
                },
                {
                  from: enviados[2].phone,
                  id: 'wamid.INBOUND3',
                  type: 'text',
                  text: { body: 'SAIR' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  // ── 5. Conferencia dos numeros do relatorio ──────────────────────────────
  const job = await store.getJob(jobId);
  const responderam = await store.countResponders(jobId);
  assert.equal(parseInt(job.delivered, 10), TOTAL - 1);
  assert.equal(parseInt(job.read, 10), 20);
  assert.equal(responderam, 3, 'tres contatos distintos responderam');
  assert.equal(parseInt(job.optout, 10), 1);

  // ── 6. A varredura ───────────────────────────────────────────────────────
  const { chaves, achados } = await varrer();
  assert.ok(chaves > 0, 'a varredura precisa ter olhado alguma coisa');
  assert.deepEqual(achados, [], `armazenamento contem dado com formato de telefone:\n${achados.join('\n')}`);

  // ── 7. Nenhum wamid cru sobreviveu ───────────────────────────────────────
  const umWamid = enviados[0].wamid;
  const chaveCrua = await store.redis.get(`w:${umWamid}`);
  assert.equal(chaveCrua, null, 'o wamid nunca pode ser chave literal');
  const chaveHash = await store.redis.get(`w:${wamidKey(umWamid)}`);
  assert.equal(chaveHash, jobId, 'o vinculo existe, mas so pelo hash');
});

test('quem pediu descadastro nao entra no proximo disparo', async (t) => {
  const phone = '5562990000777';
  const { optOutKey } = require('../src/hashing');

  await store.suppress(optOutKey(phone));
  t.after(async () => {
    await store.redis.del(`sup:${optOutKey(phone)}`);
  });

  const rows = [
    { phone, fields: {} },
    { phone: '5562990000778', fields: {} },
  ];
  const { queue, skippedSuppressed } = await dispatch.prepare(rows, {});

  assert.equal(skippedSuppressed, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].phone, '5562990000778');
});

// Fecha a conexao no fim de todos os testes do arquivo (senao o processo trava).
test('encerra a conexao', async () => {
  await store.close();
});
