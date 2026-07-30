'use strict';

/**
 * Superfície de auditoria — endpoints públicos, sem ticket.
 *
 *   GET /health           está de pé?
 *   GET /version          o que exatamente está rodando (commit + digest)
 *   GET /privacy/manifest o que este serviço guarda, declarado pela máquina
 *
 * A resposta do manifesto é curta porque a verdade é curta: este processo não
 * guarda nada. Não tem banco, não tem fila, não escreve em disco.
 */

const express = require('express');
const config = require('../config');
const pkg = require('../../package.json');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, service: pkg.name, uptimeSec: Math.round(process.uptime()) });
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
 * Declaração legível por máquina. As listas de dependências e de módulos são
 * lidas do processo em execução, não escritas à mão: se alguém adicionar um
 * driver de banco ou uma biblioteca de upload, aparece aqui sozinho.
 */
router.get('/privacy/manifest', (req, res) => {
  const deps = Object.keys(pkg.dependencies || {});
  const bancoDeDados = deps.filter((d) =>
    ['mongoose', 'mongodb', 'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'sequelize', 'prisma', 'knex', 'ioredis', 'redis'].includes(d)
  );
  const upload = deps.filter((d) => ['multer', 'formidable', 'busboy', 'express-fileupload'].includes(d));

  res.json({
    servico: pkg.name,
    commit: config.build.commit,
    papel:
      'Cofre de envio. Recebe o telefone cifrado, decifra em memoria, entrega a Meta e responde com um hash. ' +
      'E o unico processo do sistema que possui a chave privada — e o unico que nao possui armazenamento.',
    principio: 'O numero em claro existe apenas dentro de uma variavel local, entre decifrar e enviar.',
    dependencias: deps,
    driversDeBancoOuFila: bancoDeDados,
    bibliotecasDeUploadEmDisco: upload,
    escreveEmDisco: false,
    armazenamento: 'nenhum',
    oQueRetorna:
      'HMAC(wamid). O wamid da Meta embute o telefone do destinatario em base64, entao devolve-lo seria devolver ' +
      'o numero que nos foi confiado cifrado.',
    limiteDeclarado:
      'Este processo prova que nao guarda nada. Ele nao prova o que acontece do outro lado da chamada: quem ' +
      'opera os disparos guarda os numeros cifrados com a chave publica correspondente e nao consegue abri-los, ' +
      'mas isso se verifica no codigo daquele sistema e no contrato de operador, nao aqui.',
    verificacao: {
      atestadoDeProcedencia: 'gh attestation verify oci://<imagem> --owner <owner>',
      codigoFonte: config.build.sourceRepo,
      auditoriaDoChamador: 'node scripts/anon-scan.js (no sistema que opera os disparos)',
    },
  });
});

module.exports = router;
