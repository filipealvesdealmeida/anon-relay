# O caminho do dado

Este documento descreve, passo a passo, o que acontece com um número de telefone
que entra neste serviço. Ele é escrito para ser conferido contra o código, não
para ser acreditado.

Repositório público: todo o comportamento descrito aqui está em `src/`, em cerca
de 1.200 linhas. A leitura completa leva menos de uma tarde.

---

## 1. O princípio

> Nenhum número de telefone sobrevive ao request que o trouxe.

Não é uma política interna nem uma promessa de retenção curta. É uma propriedade
da arquitetura: não existe no serviço um lugar onde um número pudesse ser
guardado, mesmo que alguém quisesse.

---

## 2. O caminho, etapa por etapa

### Etapa 1 — A planilha sai do navegador

O arquivo é lido **no seu navegador** e enviado como texto no corpo da
requisição. Ele vai direto para o relay (`/anon-api/…`, roteado pelo Apache para
a porta 3020) e **não passa pelo sistema principal** — nem pelo processo que tem
banco de dados, nem pelo que grava conversas.

Verificável em: `deploy/apache-anon.conf`.

### Etapa 2 — Leitura em memória

O texto é analisado por um parser próprio (`src/csv.js`, sem dependência
externa). Não há biblioteca de upload, não há diretório temporário, não há
`fs.writeFile` em lugar nenhum do repositório.

O container roda com o sistema de arquivos **somente leitura**
(`read_only: true` em `deploy/docker-compose.yml`). Uma tentativa de escrita
falharia no kernel, independentemente do que o código pedisse.

### Etapa 3 — Normalização e checagem de descadastro

Cada número é normalizado (formato brasileiro de 13 dígitos), duplicados são
descartados e o conjunto é conferido contra a lista de descadastro — que guarda
**hashes**, não números. A comparação acontece em memória.

Verificável em: `src/csv.js`, `src/dispatch.js` (`prepare`).

### Etapa 4 — Envio

A lista fica numa fila **na memória do processo**. Para cada mensagem:

1. o número é enviado à Meta (única saída legítima, é o destino da operação);
2. a posição dele na fila é sobrescrita por `null` **antes** do envio começar;
3. as variáveis locais são zeradas ao fim da iteração.

Do envio sobra uma única coisa: `HMAC(wamid) → identificador do disparo`.

Verificável em: `src/dispatch.js` (`run`).

### Etapa 5 — Retornos da Meta (entregue, lida, respondida)

Os webhooks da Meta **contêm** número de telefone em texto puro:
`statuses[].recipient_id` e `messages[].from`. O que o serviço faz com cada um:

| Campo | O que acontece |
|---|---|
| `recipient_id` | Não é lido. O disparo é identificado pelo HMAC do `wamid`, indexado no envio. |
| `from` (resposta) | Vira hash e entra num HyperLogLog — estrutura que conta **quantos** responderam sem registrar **quem**. |
| `from` (descadastro) | Vira hash na lista de supressão, para nunca mais receber. |

Verificável em: `src/webhook-processor.js` — 100 linhas, lidas de uma vez.

**Duas origens possíveis para esses eventos.** A Meta permite uma URL de webhook
por App. Quando os números anônimos têm App próprio, ela entrega direto aqui e a
assinatura conferida é a dela (`X-Hub-Signature-256`). Quando dividem o App com
outro sistema, a Meta entrega lá; aquele sistema separa os eventos dos números
anônimos **antes de qualquer escrita** e os repassa para cá assinados com o
segredo compartilhado. Nos dois casos, o que este serviço faz com o telefone é
exatamente o descrito na tabela acima — e evento sem assinatura válida é
descartado.

### Etapa 6 — A resposta automática (quando o disparo tem uma)

Se o disparo foi configurado para responder quem interage, o fluxo executa
**neste instante**, com o telefone que acabou de chegar no webhook. Ele entra no
escopo da função, as mensagens são enviadas, e a referência morre no fim.

Os atrasos entre mensagens são temporizadores na memória do processo — não uma
fila persistida. Isso é uma decisão, não uma limitação técnica: uma fila que
sobrevivesse ao reinício seria uma cópia dos números gravada em disco.
Consequência assumida: se o serviço reiniciar no meio de um fluxo, os passos
restantes se perdem. Por isso os atrasos têm teto duro (1h entre mensagens, 4h
no total).

Para não responder a mesma pessoa a cada mensagem que ela mandar, o serviço
guarda em memória `HMAC(telefone)` por disparo, por 12 horas. É anti-repetição,
não histórico: some com o processo, e nem para isso o número precisa existir.

Quem pediu descadastro **não** recebe resposta automática. O silêncio é a
resposta certa.

Verificável em: `src/automation.js`.

### Etapa 7 — O que resta

Contadores. `enviadas`, `entregues`, `lidas`, `respondidas`, `falhas`,
`descadastros`. Nenhum endpoint deste serviço é capaz de responder "quem estava
na lista", porque a lista não existe em lugar nenhum depois do envio.

---

## 3. Por que o `wamid` não é guardado

O identificador que a Meta devolve em cada envio **contém o número do
destinatário codificado em base64**:

```
wamid.HBgNNTU2Mjk5MjIyMjIyMhUCABEYEjc...
             └── "5562992222222" em base64
```

Guardar o `wamid` seria guardar o telefone. Por isso o índice armazena
`HMAC-SHA256(wamid, pepper)` truncado em 128 bits.

Duas propriedades:

1. **Sem o segredo**, a chave é ruído — um vazamento do banco não entrega nada.
2. **Mesmo com o segredo vazado**, o `wamid` tem um sufixo aleatório de alta
   entropia (identificador único da mensagem, imprevisível). Não há espaço de
   candidatos para testar, como haveria com um telefone.

O segredo (`ANON_PEPPER`) vive na variável de ambiente do container, nunca junto
dos dados.

---

## 4. O limite — dito sem rodeio

**O que esta arquitetura prova:** que a imagem publicada veio daquele código
(atestado de procedência, Sigstore) e que a produção declara estar rodando
aquela imagem (`/version` × digest da release).

**O que ela não prova:** o que executa dentro do servidor no nível do processador.
Provar isso exigiria *confidential computing* (TEE/enclaves) — desproporcional
para este caso. Quem fecha esse resíduo é o contrato de operador (LGPD), com
cláusula expressa de não-retenção.

**Onde o anonimato é mais fraco:** a lista de descadastro guarda
`HMAC(telefone, pepper)`. O espaço de números brasileiros é pequeno (~10¹⁰).
Um atacante com **banco e segredo do processo** conseguiria testar se um número
específico está na lista. Nenhuma outra chave do sistema tem essa propriedade.

Esse trecho existe porque a alternativa é pior para a própria pessoa: esquecer
também o "não quero mais receber" significaria recontatá-la no disparo seguinte.

---

## 5. O que é assumido como custo

**Um disparo interrompido não pode ser retomado.** Se o processo reiniciar no
meio, o que faltava enviar se perde. Uma fila persistente resolveria — e seria
exatamente a cópia dos números que este serviço promete não manter. O painel
avisa isso antes de começar.

**O mesmo vale para a resposta automática.** Fluxo em andamento no momento de um
reinício não continua depois.

**Não há histórico de destinatários.** Não é possível responder "esse número
recebeu?" nem "quem respondeu?". A pergunta não tem onde ser respondida.

---

## 6. Como verificar por conta própria

```bash
# 1. A imagem em produção veio deste repositório?
gh attestation verify oci://ghcr.io/<owner>/anon-relay@<digest> --owner <owner>

# 2. Qual digest está no registry?
docker buildx imagetools inspect ghcr.io/<owner>/anon-relay:<tag>

# 3. A produção declara rodar esse digest?
curl -s https://<dominio>/anon-api/version

# 4. O que o serviço guarda, segundo ele mesmo?
curl -s https://<dominio>/anon-api/privacy/manifest

# 5. Varredura ao vivo do armazenamento atrás de telefone
curl -s https://<dominio>/anon-api/privacy/scan
```

O passo 5 é o mais direto: a varredura roda no dado real, no momento em que você
pergunta, e devolve `achados: []`.

---

## 7. Retenção declarada

| Dado | Prazo | Motivo |
|---|---|---|
| Contadores do relatório | 30 dias | disponibilidade do relatório |
| `HMAC(wamid) → disparo` | 72 horas | janela em que a Meta ainda envia status |
| `HMAC(telefone)` de descadastro | 5 anos | obrigação de não recontatar |
| Número de telefone | **nenhum** | não é gravado em momento algum |

---

## 8. Encarregado e contato

Solicitações de titular (LGPD, art. 18) sobre este serviço têm uma resposta
incomum e verificável: não há dado pessoal armazenado a ser exibido, corrigido
ou excluído — exceto o pedido de descadastro, que é justamente o que a pessoa
solicitou preservar.

O contrato de operador que acompanha a contratação formaliza a não-retenção e
nomeia o responsável.
