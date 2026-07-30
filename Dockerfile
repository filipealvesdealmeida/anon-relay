# anon-relay — imagem minima, sem estado, sem escrita em disco.
#
# A imagem e construida pelo GitHub Actions a partir do repositorio publico e
# publicada com atestado de procedencia (Sigstore). Quem quiser conferir o que
# roda em producao nao precisa confiar em ninguem: verifica o atestado, compara
# o digest com o que /version declara e le o codigo do commit correspondente.
#
# Recomendado: pinar a base por digest. Para atualizar:
#   docker buildx imagetools inspect node:22-alpine
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev: a imagem final nao carrega nada de teste.
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app

# Roda como usuario sem privilegio (a imagem base ja traz o usuario `node`).
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3020

# O container nao precisa escrever em lugar nenhum. Em producao ele sobe com
# read_only: true e um tmpfs em /tmp (ver deploy/docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3020)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
