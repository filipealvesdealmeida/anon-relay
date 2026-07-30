# anon-relay

O cofre de envio: o único processo com a chave privada que abre um número de
telefone — e o único sem qualquer armazenamento.

O sistema que opera os disparos guarda cada telefone **cifrado** com a chave
pública deste serviço. Ele consegue cifrar e não consegue abrir. Quando chega a
hora de enviar, chama aqui: decifra em memória, entrega à Meta, devolve um hash
e esquece.

Três dependências, nenhum banco, nenhuma fila, disco somente leitura. Dá para
ler o repositório inteiro numa tarde.

- **O caminho do dado, etapa por etapa:** [PRIVACY.md](PRIVACY.md)
- **Código que roda em produção:** este repositório, no commit que `/version` declara

---

## O que ele faz

```
sistema chamador                 cofre                        Meta
      │                            │                            │
      ├── telefone CIFRADO ───────►│                            │
      │                            ├─ decifra em memória        │
      │                            ├─ envia ───────────────────►│
      │                            │◄─ wamid ────────────────────┤
      │◄── HMAC(wamid) ────────────┤                            │
      │                            └─ a variável sai de escopo   │
```

O `wamid` não volta de propósito: ele embute o telefone do destinatário em
base64, e devolvê-lo desfaria todo o cuidado do caminho. O hash serve para casar
o callback de entrega e leitura depois — e não reconstrói nada.

## O que ele deliberadamente não tem

- Banco de dados, fila, cache — **nenhum armazenamento**
- Escrita em disco (o container roda `read_only: true`)
- Qualquer rota que liste, busque ou devolva um destinatário
- Conhecimento de quem é o cliente: o ticket carrega um identificador derivado

## Rotas

```
GET  /health              saúde
GET  /version             commit + digest da imagem em execução
GET  /privacy/manifest    o que este serviço guarda (resposta: nada)
POST /send                decifra, envia, devolve HMAC(wamid)   [ticket]
GET  /templates           templates aprovados                   [ticket]
GET  /senders             números disponíveis                   [ticket]
```

---

## Como auditar

Três comandos. Nenhum depende de quem opera o servidor.

### 1. A imagem em produção veio deste código?

```bash
gh attestation verify oci://ghcr.io/<owner>/anon-relay@<digest> --owner <owner>
```

O atestado é gerado pelo GitHub Actions no build, assinado via Sigstore, e liga
aquele digest a um commit específico e a uma execução pública do workflow.

### 2. Qual é o digest publicado?

```bash
docker buildx imagetools inspect ghcr.io/<owner>/anon-relay:<tag>
```

### 3. A produção está rodando esse digest?

```bash
curl -s https://<dominio>/anon-api/version
```

Se os três batem, o que roda em produção é o código que você acabou de ler.

### Bônus: o manifesto

```bash
curl -s https://<dominio>/anon-api/privacy/manifest
```

A lista de dependências e a ausência de drivers de banco são lidas do processo
em execução, não escritas à mão. Se alguém adicionar um, aparece ali sozinho.

---

## Rodando local

```bash
cp .env.example .env      # preencha ANON_PRIVATE_KEY, ANON_PEPPER, ANON_SENDERS
npm install
npm start
```

Gere o par de chaves com o `scripts/anon-keygen.js` do sistema chamador — ele
imprime a privada para cá e a pública para lá.

## Testes

```bash
npm test
```

Cobrem o cofre (decifra o que deve, recusa o que não deve), o contrato de
`/send` (nunca devolve wamid nem telefone) e o teto de segurança por número.

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
├── hashing.js       o cofre: decifra, e por que o wamid não volta em claro
├── rate.js          teto de segurança por número, com prioridade
├── meta.js          cliente da Cloud API (fetch nativo)
├── ticket.js        autenticação das chamadas do sistema chamador
├── logging.js       logger com redação obrigatória de dígitos e wamid
└── routes/
    ├── send.js      decifra, envia, devolve hash — leia inteiro
    └── version.js   /version e /privacy/manifest
```

## O limite

Este serviço prova que **ele** não guarda nada. Ele não prova o que acontece do
outro lado da chamada — quem opera os disparos guarda os números cifrados com a
chave pública correspondente e não consegue abri-los, mas isso se verifica no
código daquele sistema (`node scripts/anon-scan.js`) e no contrato de operador,
não aqui.

## Licença

Código aberto para auditoria. Uso comercial do serviço mediante contrato.
