'use strict';

/**
 * Relatorio — a unica coisa que sobra de um disparo.
 *
 * Sao contagens. Nao ha endpoint irmao que devolva a lista por tras de cada
 * contagem, porque essa lista nao existe em lugar nenhum depois do envio.
 */

const express = require('express');
const store = require('../store');
const dispatch = require('../dispatch');
const { requireTicket } = require('../ticket');

const router = express.Router();
router.use(requireTicket);

const num = (v) => parseInt(v, 10) || 0;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function shape(job, responded, errors, live) {
  const total = num(job.total);
  const sent = num(job.sent);
  const failed = num(job.failed);
  const delivered = num(job.delivered);
  const read = num(job.read);
  const optout = num(job.optout);
  const processed = live ? live.processed : sent + failed;

  return {
    id: job.id,
    label: job.label || '',
    template: job.templateName,
    numero: job.senderLabel,
    status: job.status,
    criadoEm: job.createdAt ? new Date(num(job.createdAt)).toISOString() : null,
    iniciadoEm: job.startedAt ? new Date(num(job.startedAt)).toISOString() : null,
    concluidoEm: job.finishedAt ? new Date(num(job.finishedAt)).toISOString() : null,
    progresso: {
      total,
      processadas: processed,
      percentual: pct(processed, total),
      emAndamento: !!(live && live.running),
    },
    numeros: {
      enviadas: sent,
      entregues: delivered,
      lidas: read,
      respondidas: responded,
      falhas: failed,
      descadastros: optout,
    },
    taxas: {
      entrega: pct(delivered, sent),
      leitura: pct(read, delivered),
      resposta: pct(responded, delivered),
      falha: pct(failed, sent),
    },
    naoEnviados: {
      descadastrados: num(job.skippedSuppressed),
      invalidos: num(job.skippedInvalid),
      duplicados: num(job.skippedDuplicate),
    },
    errosPorCodigo: errors || {},
  };
}

// Lista de disparos do tenant.
router.get('/jobs', async (req, res) => {
  const jobs = await store.listJobs(req.tenant, 50);
  res.json({
    ok: true,
    geradoEm: new Date().toISOString(),
    jobs: jobs.map((j) => shape(j, num(j.responded), null, dispatch.jobState(j.id))),
  });
});

// Relatorio de um disparo.
router.get('/jobs/:id/report', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job || job.tenant !== req.tenant) {
    return res.status(404).json({ ok: false, error: 'disparo nao encontrado' });
  }
  const [responded, errors] = await Promise.all([
    store.countResponders(job.id),
    store.getErrors(job.id),
  ]);
  res.json({
    ok: true,
    geradoEm: new Date().toISOString(),
    atualizaEmSegundos: 300,
    relatorio: shape(job, responded, errors, dispatch.jobState(job.id)),
  });
});

module.exports = router;
