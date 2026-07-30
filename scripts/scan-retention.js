'use strict';

/**
 * Varredura de retencao — versao CLI do endpoint /privacy/scan.
 *
 * Le todas as chaves do namespace do relay e procura qualquer coisa com
 * formato de telefone. Roda contra o Redis de producao (somente leitura).
 *
 *   node scripts/scan-retention.js
 *
 * Saida esperada: "0 achados". Qualquer outra coisa e um incidente.
 */

require('dotenv').config();

const Redis = require('ioredis');

const PREFIX = process.env.REDIS_PREFIX || 'anon:';
const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const PHONE_LIKE = /\d{8,}/;
const TIMESTAMP_FIELDS = new Set(['createdAt', 'startedAt', 'finishedAt']);

async function main() {
  const redis = new Redis(URL);
  const achados = [];
  const porTipo = {};
  let total = 0;
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      total++;
      const bare = key.slice(PREFIX.length);
      const tipo = bare.split(':')[0];
      porTipo[tipo] = (porTipo[tipo] || 0) + 1;

      if (PHONE_LIKE.test(bare)) {
        achados.push(`${key} :: nome da chave`);
      }

      const type = await redis.type(key);
      if (type === 'string') {
        const v = await redis.get(key);
        if (v && PHONE_LIKE.test(v)) achados.push(`${key} :: valor`);
      } else if (type === 'hash') {
        const h = await redis.hgetall(key);
        for (const [f, v] of Object.entries(h)) {
          if (TIMESTAMP_FIELDS.has(f)) continue;
          if (PHONE_LIKE.test(String(v))) achados.push(`${key} :: campo ${f}`);
        }
      }
    }
  } while (cursor !== '0');

  console.log('');
  console.log('  varredura de retencao — anon-relay');
  console.log('  ' + '─'.repeat(48));
  console.log(`  chaves varridas : ${total}`);
  Object.entries(porTipo).forEach(([t, c]) => console.log(`    ${t.padEnd(14)} ${c}`));
  console.log(`  achados         : ${achados.length}`);
  achados.forEach((a) => console.log(`    ! ${a}`));
  console.log('');

  await redis.quit();
  process.exit(achados.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('falha na varredura:', err.message);
  process.exit(2);
});
