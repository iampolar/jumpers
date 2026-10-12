# JUMPERS · CastWave

Central de áudio para redes de lojas físicas: música ambiente, ofertas faladas,
avisos operacionais e jingles, programados por dia, horário, loja e zona, com
players pareados e relatórios de execução.

O núcleo funciona **sem IA e sem gateway de pagamento**. As duas integrações
entram depois, atrás de contratos já definidos — são a cereja, não o alicerce.

---

## Subir o projeto

Requisito único: **Node.js 20.11+**. Sem Docker, sem Postgres instalado, sem
Redis, sem conta em serviço nenhum.

```bash
npm install
npm run dev
```

Painel em <http://localhost:3000>, API em <http://127.0.0.1:4000>.

O banco é um **PostgreSQL 18 real embarcado** ([PGlite], WebAssembly), gravado
em `.data/castwave`. O mesmo SQL roda contra um Postgres gerenciado em
produção trocando apenas `DATABASE_URL` — não existe "modo de teste" no código
de domínio.

```bash
npm run db:seed      # planos + organização de demonstração com 2 lojas
npm run db:status    # o que já foi aplicado e o que falta
```

[PGlite]: https://pglite.dev

---

## Comandos

| Comando                     | O que faz                                                      |
| --------------------------- | -------------------------------------------------------------- |
| `npm run dev`               | Migrations, depois API + worker + web em um terminal            |
| `npm run verify`            | Typecheck, lint, varredura de invisíveis e testes               |
| `npm test`                  | Suíte completa                                                  |
| `npm run db:migrate`        | Aplica migrations pendentes                                     |
| `npm run db:reset`          | Recria o schema (recusa banco não descartável)                  |
| `npm run build`             | Build de produção da API e do web                               |
| `npm run check:invisible`   | Procura BOM, zero-width e override bidi no código-fonte         |

---

## Organização do repositório

```text
apps/
  api/        REST /api/v1, health, guards      (Fastify)
  worker/     filas, vigências, agregações      (processo separado)
  web/        painel, painel Jumpers, player    (Next.js)
packages/
  contracts/  schemas Zod, enums, máquinas de estado, RBAC e PORTAS
  core/       fuso horário, rotação, autorização, sonda de áudio, cotas, CSV
  runtime/    configuração validada e log estruturado
  db/         migrations SQL, cliente, migrador, seed
```

A dependência aponta sempre para dentro: `apps` conhecem `packages`, nunca o
contrário, e nenhum app importa de outro app.

---

## Decisões que valem explicação

**PostgreSQL embarcado no desenvolvimento.** Um projeto que exige Docker para
rodar o primeiro teste perde contribuidor na primeira hora. PGlite dá Postgres
de verdade — FKs compostas, índices parciais, `skip locked`, DDL transacional —
em 700 ms, sem serviço. Os testes de integração exercitam exatamente as
constraints que vão para produção.

**SQL explícito, sem ORM.** O isolamento entre clientes depende de chaves
estrangeiras compostas `(id, organization_id)` que um ORM não expressa bem.
Com elas, associar uma zona de áudio de uma rede a uma loja de outra é
**impossível no banco**, não apenas improvável no código. Há teste provando.

**Fila no Postgres, não no Redis.** `for update skip locked` entrega uma fila
transacional: o job é enfileirado no mesmo commit que criou o recurso, então
não existe "gravou no banco mas o job se perdeu". Um serviço a menos para
operar. A porta `JobQueuePort` permite trocar por BullMQ quando o volume pedir.

**Sem FFmpeg o produto continua funcionando.** Uma sonda nativa lê o cabeçalho
real do arquivo (RIFF, frames MPEG com tag Xing, páginas Ogg, STREAMINFO do
FLAC, boxes do MP4) e obtém duração confiável e tipo verdadeiro por magic
bytes. Com FFmpeg instalado, ele assume e acrescenta loudness. Sem ele o
`/health/ready` reporta `degraded` e diz o que se perdeu — nunca fingimos ter
medido o que não medimos.

Mais em [`docs/`](./docs).

---

## Integrações externas

Todas nascem desligadas, e o produto inteiro funciona assim:

| Integração        | Padrão           | O que fica indisponível                      |
| ----------------- | ---------------- | -------------------------------------------- |
| Roteiro por IA    | `disabled`       | Botão "gerar roteiro"; escrita manual e modelos seguem |
| Locução (TTS)     | `disabled`       | Botão "gerar locução"; upload de áudio segue  |
| Gateway           | `disabled`       | Checkout; planos, cotas e medição seguem      |
| E-mail (SMTP)     | não configurado  | Envio externo; notificação fica no app        |

`GET /api/v1/status/integrations` informa o estado real de cada uma e o que
exatamente fica desabilitado. Nenhuma tela simula sucesso de integração
ausente, e provider `mock`/`fake` é **recusado no boot** com `NODE_ENV=production`.

---

## Direitos sobre o áudio

O CastWave **não distribui catálogo musical**. O lojista envia faixas sobre as
quais tem direito de execução e confirma isso no upload; a confirmação fica
registrada com autor e data. O seed não cria áudio de demonstração por esse
motivo — biblioteca vazia é honesta, playlist com faixa fantasma não é.
