# anon-relay

Disparo de WhatsApp com **retenção zero de números**. A lista chega, as
mensagens saem, o número é descartado. O que resta é contagem: enviadas,
entregues, lidas, respondidas.

O serviço é pequeno de propósito — três dependências, nenhum banco de dados,
nenhuma escrita em disco. A ideia é que você não precise acreditar em ninguém:
leia `src/` numa tarde e verifique você mesmo.

- **O caminho do dado, etapa por etapa:** [PRIVACY.md](PRIVACY.md)
- **Código que roda em produção:** este repositório, no commit que `/version` declara

---

## Como auditar

Três comandos. Nenhum deles depende de quem opera o servidor.

### 1. A imagem em produção veio deste código?

```bash
gh attestation verify oci://ghcr.io/<owner>/anon-relay@<digest> --owner <owner>
```

O atestado é gerado pelo GitHub Actions no momento do build, assinado via
Sigstore, e liga aquele digest a um commit específico e a uma execução pública
do workflow. Não existe caminho para publicar uma imagem diferente do código
sem que o atestado deixe de bater.

### 2. Qual é o digest publicado?

```bash
docker buildx imagetools inspect ghcr.io/<owner>/anon-relay:<tag>
```

### 3. A produção está rodando esse digest?

```bash
curl -s https://<dominio>/anon-api/version
```

```json
{
  "commit": "a31f89c…",
  "image_digest": "sha256:9f2b…",
  "deployed_at": "2026-07-30T09:32:00Z",
  "source": "https://github.com/<owner>/anon-relay/tree/a31f89c…"
}
```

Se os três batem, o que roda em produção é o código que você acabou de ler.

### Bônus: a varredura ao vivo

```bash
curl -s https://<dominio>/anon-api/privacy/scan
```

Lê **todas** as chaves do armazenamento e procura qualquer sequência com
formato de telefone, em nome de chave ou em valor. Roda no dado real, no
momento em que você pergunta.

```json
{ "ok": true, "chavesVarridas": 1284, "achados": [] }
```

---

## O que o serviço faz

```
navegador                  relay                        Meta
    │                        │                            │
    ├── planilha (texto) ───►│                            │
    │                        ├─ parse em memória          │
    │                        ├─ normaliza, dedup          │
    │                        ├─ filtra descadastro (hash) │
    │                        ├─ envia ────────────────────►
    │                        │◄─ wamid ────────────────────┤
    │                        ├─ grava HMAC(wamid) → job    │
    │                        └─ descarta o número          │
    │                        │                            │
    │                        │◄─ entregue / lida ──────────┤
    │                        ├─ +1 no contador             │
    │                        │                            │
    │◄── contadores ─────────┤                            │
```

## O que ele deliberadamente não faz

- Não guarda destinatário — nem cifrado, nem com prazo curto.
- Não tem endpoint que devolva "quem estava na lista".
- Não retoma disparo interrompido (fila persistente seria a cópia dos números).
- Não conhece o cliente: o ticket carrega um identificador derivado, não o usuário.

---

## Rodando local

```bash
cp .env.example .env      # preencha ANON_PEPPER, ANON_TICKET_SECRET, ANON_SENDERS
npm install
npm start
```

Requer Redis. Gere os segredos com `openssl rand -hex 32`.

## Testes

```bash
npm test
```

Inclui `test/no-retention.test.js`: roda um disparo completo contra uma Meta
simulada e varre todo o armazenamento atrás de qualquer coisa com formato de
telefone. Se alguém introduzir uma escrita que guarde número, o teste quebra —
e o CI reprova antes de qualquer imagem ser publicada.

## Deploy

Nunca por `latest`, nunca de uma máquina pessoal:

1. `git tag v1.2.0 && git push --tags`
2. O workflow **build e atestado** publica no GHCR e gera a procedência.
3. O workflow **deploy por digest** sobe na VPS a imagem pinada por `@sha256:…`
   e confere que `/version` responde exatamente aquele digest.

O histórico público de implantações é a aba Actions/Environments deste
repositório.

## Arquitetura em uma tela

```
src/
├── server.js        montagem do express e rotas
├── config.js        toda a configuração vem de env — não há banco
├── hashing.js       derivação HMAC (e por que o wamid não pode ser guardado)
├── logging.js       logger com redação obrigatória de dígitos e wamid
├── store.js         inventário completo do que é gravado no Redis
├── csv.js           parser próprio, em memória
├── dispatch.js      ciclo de vida do número: entra, envia, some
├── meta.js          cliente da Cloud API (fetch nativo)
├── optout.js        detecção de pedido de descadastro
└── routes/
    ├── jobs.js      disparo (exige ticket)
    ├── report.js    contadores (exige ticket)
    ├── webhook.js   retornos da Meta — 90 linhas, leia inteiro
    └── version.js   /version, /privacy/manifest, /privacy/scan
```

## Licença

Código aberto para auditoria. Uso comercial do serviço mediante contrato.
