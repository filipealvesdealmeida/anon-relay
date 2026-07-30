# O caminho do dado

Este documento descreve, passo a passo, o que acontece com um número de telefone
neste desenho. Ele é escrito para ser conferido contra o código, não para ser
acreditado.

---

## 1. O princípio

> O número é gravado cifrado com uma chave que o sistema operador não possui.
> Só este serviço abre — e ele não tem onde guardar.

Não é uma política interna nem uma promessa de retenção curta. São duas
propriedades de arquitetura que se sustentam uma na outra:

1. a cifra é **assimétrica** — quem grava não consegue reabrir;
2. quem consegue reabrir **não tem armazenamento** — nem banco, nem fila, nem
   disco gravável.

---

## 2. O caminho, etapa por etapa

### Etapa 1 — A planilha sai do navegador

O arquivo é lido **no navegador** e enviado como texto no corpo da requisição.
Em conta anônima ele **não vira arquivo temporário** no servidor: o upload usa
armazenamento em memória e o navegador reenvia a lista a cada etapa do
assistente.

Verificável em: `server.js`, função `uploadCsv`.

### Etapa 2 — O número é cifrado antes de encostar no banco

Logo após a limpeza da lista (normalização, deduplicação), cada telefone é
substituído por dois valores:

| Campo | Conteúdo |
|---|---|
| `phone` | `hmac:<HMAC do número>` — a chave de comparação |
| `phoneEnc` | o número cifrado com a chave pública **deste** serviço |

A partir dessa linha, o número em claro não existe mais no processo do sistema
operador. Ele consegue cifrar; a chave privada não está lá.

Verificável em: `lib/anon-crypto.js` e o endpoint `process-csv` do sistema.

### Etapa 3 — Banco, fila e relatórios trabalham sem o número

`Contact`, o payload do job no Redis, `Message`, `Conversation` e a blacklist
guardam a chave `hmac:` — nunca o número. Toda consulta do sistema continua
funcionando porque só o *valor* do campo mudou.

Verificável em: `node scripts/anon-scan.js` no sistema operador, que lê o dado
real e procura qualquer sequência com formato de telefone.

### Etapa 4 — O envio

O worker chama `POST /send` deste serviço com o `phoneEnc`. Aqui:

1. o número é decifrado numa variável local;
2. é entregue à Meta — a saída legítima, o destino da operação;
3. a variável sai de escopo.

Não sobra nada porque não há onde sobrar: sem banco, sem fila, sem disco.

Verificável em: `src/routes/send.js` — a rota inteira cabe numa tela.

### Etapa 5 — O que volta

`HMAC(wamid)`. Nunca o `wamid`.

O identificador que a Meta devolve embute o telefone do destinatário em base64:

```
wamid.HBgNNTU2Mjk5MjIyMjIyMhUCABEYEjc...
             └── "5562992222222" em base64
```

Devolvê-lo seria entregar de volta o número que nos foi confiado cifrado. O hash
serve para casar o callback de entrega e leitura, e não reconstrói nada.

Duas propriedades:

1. **Sem o segredo**, é ruído.
2. **Mesmo com o segredo vazado**, o `wamid` tem sufixo aleatório de alta
   entropia — não há espaço de candidatos para testar, como haveria com um
   telefone. É a chave mais forte do sistema.

### Etapa 6 — Os retornos da Meta

Entregas, leituras e respostas chegam ao webhook do sistema operador. O payload
**contém** telefone em texto puro (`statuses[].recipient_id`, `messages[].from`)
— e é ali que ele para:

| Campo | O que acontece |
|---|---|
| `recipient_id` | Não é lido. A mensagem é identificada pelo HMAC do `wamid`. |
| `from` (resposta) | Vira chave `hmac:` e número cifrado na mesma linha; o valor cru sai de escopo no fim da função. |

Verificável em: `worker.js`, `processMetaWebhook` e `processMetaInboundMessage`.

---

## 3. O que um vazamento revelaria

| Cenário | O que o atacante obtém |
|---|---|
| Dump do Mongo | Chaves `hmac:` e blobs cifrados. Nenhum número. |
| Backup do Redis | Payloads de job com chave e cifrado. Nenhum número. |
| `.env` do sistema operador | A chave **pública**. Não abre nada. |
| Banco **e** `.env` do operador | Ainda nenhum número: falta a chave privada. |
| `.env` deste serviço (chave privada) | Consegue abrir os cifrados **se também tiver o banco**. |
| Banco **e** pepper | Consegue *testar* se um número específico está numa lista (ver limite abaixo). |

---

## 4. O limite — dito sem rodeio

**O que esta arquitetura prova:** que o número é gravado cifrado com uma chave
ausente do sistema que o grava; que o único processo capaz de abri-lo não tem
armazenamento; e que a imagem dele veio de um código público, com atestado de
procedência.

**O que ela não prova:** o que executa dentro do servidor no nível do
processador. Provar isso exigiria *confidential computing* (TEE/enclaves) —
desproporcional para este caso.

**Onde o anonimato é mais fraco:** o HMAC. Para deduplicar listas, respeitar
descadastros e não responder duas vezes à mesma pessoa, o sistema precisa
responder "é a mesma pessoa?" — e cifra aleatorizada não responde isso. O HMAC
responde, ao custo de ser determinístico. Como o espaço de números brasileiros é
pequeno (~10¹⁰), quem tivesse o banco **e** o pepper conseguiria testar se um
número específico está numa lista. O `phoneEnc` não tem essa fraqueza.

**Uma ressalva de operação:** este serviço e o sistema operador rodam hoje na
mesma máquina. A separação de chaves protege contra vazamento de banco, de
backup e de dump — não contra quem já tem root na VPS naquele instante. Separar
em máquinas diferentes é uma mudança de configuração, não de código.

**O que fecha o resto:** o contrato de operador (LGPD), com cláusula expressa de
não-retenção.

---

## 5. Retenção declarada

| Dado | Onde | Prazo |
|---|---|---|
| Número de telefone em claro | em lugar nenhum | — |
| Número cifrado (`phoneEnc`) | banco do sistema operador | enquanto o disparo existir |
| Chave `hmac:` | banco do sistema operador | enquanto o disparo existir |
| `HMAC(wamid)` | banco do sistema operador | enquanto a mensagem existir |
| Qualquer coisa | **neste serviço** | **nada é guardado** |

---

## 6. Como verificar por conta própria

```bash
# 1. A imagem em produção veio deste repositório?
gh attestation verify oci://ghcr.io/<owner>/anon-relay@<digest> --owner <owner>

# 2. A produção declara rodar esse digest?
curl -s https://<dominio>/anon-api/version

# 3. O que este serviço guarda, segundo ele mesmo?
curl -s https://<dominio>/anon-api/privacy/manifest

# 4. E o sistema operador — guarda algum número em claro?
node scripts/anon-scan.js       # lá, no sistema; espera-se "achados: 0"

# 5. O sistema operador realmente não consegue decifrar?
node scripts/anon-selftest.js   # a verificação que passa quando falha
```

---

## 7. Solicitações de titular (LGPD, art. 18)

A resposta é incomum e verificável: não há número de telefone armazenado a ser
exibido, corrigido ou excluído. O que existe é um valor cifrado, ilegível para
quem o guarda, e um hash usado para respeitar descadastros — que é justamente o
que a pessoa pediu para ser preservado, quando pediu.

O contrato de operador que acompanha a contratação formaliza a não-retenção e
nomeia o responsável.
