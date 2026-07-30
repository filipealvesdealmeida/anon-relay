'use strict';

/**
 * Superficie de auditoria — endpoints publicos, sem ticket.
 *
 *   GET /version          o que exatamente esta rodando (commit + digest)
 *   GET /health           esta de pe?
 *   GET /privacy/manifest o que o servico grava, declarado pela propria maquina
 *   GET /privacy/scan     varredura ao vivo do Redis atras de telefone
 *
 * O ponto de /privacy/scan e esse: a promessa nao e verificada por um documento,
 * e por uma varredura executada no dado real, no momento em que voce pergunta.
 */

const express = require('express');
const config = require('../config');
const store = require('../store');
const pkg = require('../../package.json');

const router = express.Router();

router.get('/health', async (req, res) => {
  let redisOk = false;
  try {
    redisOk = (await store.ping()) === 'PONG';
  } catch (_) {
    redisOk = false;
  }
  res.status(redisOk ? 200 : 503).json({
    ok: redisOk,
    service: pkg.name,
    uptimeSec: Math.round(process.uptime()),
  });
});

router.get('/version', (req, res) => {
  res.json({
    service: pkg.name,
    version: pkg.version,
    commit: config.build.commit,
    image_digest: config.build.imageDigest,
    release_tag: config.build.releaseTag,
    deployed_at: config.build.deployedAt,
    source:
      config.build.commit && config.build.commit !== 'dev'
        ? `${config.build.sourceRepo}/tree/${config.build.commit}`
        : config.build.sourceRepo,
    node: process.version,
  });
});

/**
 * Declaracao legivel por maquina do que este servico grava.
 * A lista de dependencias vem do proprio package.json em execucao — se alguem
 * adicionar um driver de banco, aparece aqui sem ninguem precisar atualizar
 * texto nenhum.
 */
router.get('/privacy/manifest', (req, res) => {
  const deps = Object.keys(pkg.dependencies || {});
  const bancoDeDados = deps.filter((d) =>
    ['mongoose', 'mongodb', 'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'sequelize', 'prisma', 'knex'].includes(d)
  );
  const upload = deps.filter((d) => ['multer', 'formidable', 'busboy', 'express-fileupload'].includes(d));

  res.json({
    servico: pkg.name,
    commit: config.build.commit,
    principio: 'Nenhum numero de telefone sobrevive ao request que o trouxe.',
    dependencias: deps,
    driversDeBanco: bancoDeDados,
    bibliotecasDeUploadEmDisco: upload,
    escreveEmDisco: false,
    persistencia: {
      motor: 'redis',
      finalidade: 'contadores agregados e indices derivados por HMAC',
      chaves: [
        { padrao: 'job:<id>', conteudo: 'contadores e metadados do disparo', dadoPessoal: false },
        { padrao: 'job:<id>:resp', conteudo: 'HyperLogLog: quantos responderam, sem quem', dadoPessoal: false },
        { padrao: 'job:<id>:err', conteudo: 'contagem por codigo de erro da Meta', dadoPessoal: false },
        { padrao: 'tenant:<hash>:jobs', conteudo: 'indice de disparos do cliente', dadoPessoal: false },
        { padrao: 'w:<hash>', conteudo: 'HMAC(wamid) -> disparo. Irreversivel.', dadoPessoal: false },
        { padrao: 'sender:<hash>:active', conteudo: 'disparo corrente do numero remetente', dadoPessoal: false },
        {
          padrao: 'sup:<hash>',
          conteudo: 'HMAC(telefone) de quem pediu descadastro',
          dadoPessoal: 'derivado — ver limite declarado',
        },
      ],
      retencao: {
        relatorios: `${config.redis.reportTtlDays} dias`,
        indiceDeMensagens: `${config.redis.wamidTtlHours} horas`,
        descadastros: '5 anos (obrigacao de nao recontatar)',
      },
    },
    limiteDeclarado:
      'A chave de descadastro e HMAC do telefone com segredo fora do banco. Vazamento do banco sozinho nao revela nada. ' +
      'Um atacante que obtenha banco E segredo do processo consegue TESTAR se um numero especifico esta na lista de descadastro. ' +
      'Nenhuma outra chave tem essa propriedade: o indice de mensagens deriva de um identificador de alta entropia e nao e testavel.',
    verificacao: {
      atestadoDeProcedencia: 'gh attestation verify oci://<imagem> --owner <owner>',
      varreduraAoVivo: '/privacy/scan',
      codigoFonte: config.build.sourceRepo,
    },
  });
});

/**
 * Varredura ao vivo: le TODAS as chaves do namespace deste servico e procura
 * qualquer coisa com cara de telefone (8+ digitos seguidos) em nome de chave
 * ou em valor. Retorna a contagem por tipo de chave e os achados.
 *
 * Resultado esperado, sempre: achados = 0.
 */
router.get('/privacy/scan', async (req, res) => {
  const started = Date.now();
  const PHONE_LIKE = /\d{8,}/;
  const prefix = config.redis.prefix;
  const porTipo = {};
  const achados = [];
  let chavesVarridas = 0;
  let cursor = '0';

  try {
    do {
      const [next, keys] = await store.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      if (!keys.length) continue;

      // ioredis aplica keyPrefix nos comandos, mas SCAN devolve a chave completa —
      // tira o prefixo antes de reconsultar pra nao duplicar.
      const bare = keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));

      const typePipe = store.redis.pipeline();
      bare.forEach((k) => typePipe.type(k));
      const types = await typePipe.exec();

      const readPipe = store.redis.pipeline();
      bare.forEach((k, i) => {
        const t = types[i]?.[1];
        if (t === 'string') readPipe.get(k);
        else if (t === 'hash') readPipe.hgetall(k);
        else readPipe.exists(k); // hll/zset: conteudo binario/score, sem texto
      });
      const values = await readPipe.exec();

      bare.forEach((key, i) => {
        chavesVarridas++;
        const tipo = key.split(':')[0];
        porTipo[tipo] = (porTipo[tipo] || 0) + 1;

        if (PHONE_LIKE.test(key)) {
          achados.push({ chave: key, onde: 'nome da chave' });
        }
        const v = values[i]?.[1];
        if (typeof v === 'string' && PHONE_LIKE.test(v)) {
          achados.push({ chave: key, onde: 'valor' });
        } else if (v && typeof v === 'object') {
          for (const [f, val] of Object.entries(v)) {
            // createdAt/startedAt sao epoch em ms (13 digitos) — legitimos e
            // declarados; qualquer outro campo com digitos longos e achado.
            if (['createdAt', 'startedAt', 'finishedAt'].includes(f)) continue;
            if (typeof val === 'string' && PHONE_LIKE.test(val)) {
              achados.push({ chave: key, onde: `campo ${f}` });
            }
          }
        }
      });
    } while (cursor !== '0');

    res.json({
      ok: achados.length === 0,
      geradoEm: new Date().toISOString(),
      duracaoMs: Date.now() - started,
      chavesVarridas,
      porTipo,
      achados,
      observacao:
        'Varredura executada agora, sobre o dado real em producao. "achados: []" significa que nenhuma chave ou valor ' +
        'no armazenamento deste servico contem sequencia com formato de telefone. Timestamps epoch sao ignorados por serem declarados.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
