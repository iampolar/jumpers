# CastWave — arquitetura

**Produto:** central de áudio para redes de lojas físicas.
**Princípio que governa tudo:** o núcleo funciona sem IA e sem gateway de
pagamento. As duas integrações entram atrás de portas já definidas, sem
reescrever o domínio.

---

## 1. Forma geral

```
                 ┌─────────────┐
  lojista ─────▶ │  apps/web   │  Next.js · console + painel Jumpers + player
                 └──────┬──────┘
                        │ mesma origem (cookie SameSite=Lax)
                 ┌──────▼──────┐
  player  ─────▶ │  apps/api   │  Fastify · /api/v1 · guards · health
   (Bearer)      └──┬───────┬──┘
                    │       │
         ┌──────────▼─┐  ┌──▼────────────┐
         │ PostgreSQL │  │ ObjectStorage │  disco (dev) · S3 (prod)
         └──────┬─────┘  └───────────────┘
                │ tabela `jobs` (SKIP LOCKED)
         ┌──────▼──────┐
         │ apps/worker │  vigências · agregações · players offline
         └─────────────┘
```

Monólito modular com worker separado. Não há microserviço: o custo
operacional não se paga no volume de uma rede de varejo, e a transação que
cria um recurso e enfileira o job dele precisa ser **a mesma**.

---

## 2. Camadas e dependência

```
apps/api ─┐
apps/worker ─┼──▶ packages/db ──▶ packages/core ──▶ packages/contracts
apps/web ─┘           │                 │
                      └── packages/runtime (config + log)
```

A dependência aponta sempre para dentro. Nenhum app importa de outro app —
quando o worker precisou de `config`, isso virou `packages/runtime`, não um
`import '../../api/src/config'`.

| Pacote | Papel | Depende de |
| --- | --- | --- |
| `contracts` | schemas Zod, enums, máquinas de estado, RBAC, **portas** | — |
| `core` | fuso/DST, rotação, autorização, sonda de áudio, cotas, CSV | contracts |
| `runtime` | configuração validada, log estruturado | core |
| `db` | migrations, cliente SQL, migrador, seed | core |

`contracts` é isomórfico: usa Web Crypto, não `node:crypto`, para que o mesmo
schema valide no servidor e no navegador.

---

## 3. Decisões e o porquê

### 3.1 PostgreSQL embarcado em desenvolvimento

`DATABASE_URL=file://./.data/castwave` sobe um PostgreSQL 18 real
([PGlite], WebAssembly) em ~700 ms, sem Docker. Os testes de integração
exercitam as **mesmas** constraints, FKs compostas, índices parciais e
`SKIP LOCKED` que rodam em produção — trocar `DATABASE_URL` por
`postgres://...` é a única diferença.

Limite documentado: PGlite é de processo único. API e worker juntos exigem um
PostgreSQL de verdade. Há uma trava com mensagem explicativa em
`packages/db/src/client.ts` — sem ela o segundo processo morria com um
`RuntimeError: Aborted()` do WASM que não dizia nada.

[PGlite]: https://pglite.dev

### 3.2 SQL explícito, sem ORM

O isolamento entre clientes depende de chaves estrangeiras **compostas**:

```sql
foreign key (store_id, organization_id) references stores (id, organization_id)
```

Com elas, apontar uma zona de áudio da rede A para uma loja da rede B é
impossível no banco — não apenas improvável no código. Nenhum ORM popular
expressa isso bem. Há teste provando a recusa.

### 3.3 Fila no PostgreSQL

`for update skip locked` entrega uma fila transacional: o job é enfileirado no
mesmo commit que criou o recurso, então não existe "gravou no banco mas o job
se perdeu". Um serviço a menos para operar. A porta `JobQueuePort` permite
trocar por BullMQ quando o volume justificar.

Lease com `lock_expires_at` devolve à fila o job de um worker que morreu.

### 3.4 Sessão opaca em banco, não JWT

Revogar um JWT exige uma lista de bloqueio — que é justamente o banco que o
JWT prometia evitar. Aqui "desconectar todos os dispositivos" é um `UPDATE`
com efeito imediato. O token vai para o banco **só como hash**.

### 3.5 Sonda de áudio nativa

Uma instalação sem FFmpeg não pode aceitar um arquivo com "duração
desconhecida" e marcá-lo como pronto. A sonda em TypeScript lê o container de
verdade — RIFF, frames MPEG com tag Xing, páginas Ogg, STREAMINFO do FLAC,
boxes do MP4 — e garante tipo real e duração confiável em qualquer ambiente.
Com `ffprobe` configurado, ele assume e acrescenta loudness; sem ele, o
`/health/ready` reporta `degraded` e diz o que se perdeu.

---

## 4. Modelo de dados

7 migrations, 36 tabelas. Convenções:

- `uuid` com `gen_random_uuid()`; `timestamptz` sempre, nunca `timestamp`;
- enums como `text` + `CHECK` (um `ALTER TYPE ... ADD VALUE` não roda em
  transação nem tem rollback);
- `organization_id` em toda tabela de negócio;
- `UNIQUE (id, organization_id)` nas raízes, para as filhas referenciarem o par.

**Grupos:** identidade e sessão · lojas, zonas e players · mídia e anúncios
versionados · playlists, agenda e campanhas · eventos e agregações · planos,
assinatura e webhooks · filas, outbox, idempotência e suporte.

Invariantes que o banco garante sozinho:

| Regra | Como |
| --- | --- |
| Mídia não vira `ready` sem duração, checksum e chave | `CHECK` composto |
| Evento reenviado não conta duas vezes | PK é o `event_id` do player |
| Webhook duplicado não processa duas vezes | `UNIQUE (provider, event_id)` |
| Uma assinatura viva por organização | índice parcial |
| Código de pareamento único **enquanto vivo** | índice parcial `where used_at is null` |
| Campanha com fim antes do início | `CHECK (ends_at > starts_at)` |

---

## 5. Autorização

Três camadas, todas no servidor:

1. **Autenticação** — cookie de sessão (humano) ou Bearer de dispositivo
   (player). Nunca se confundem: o token de player não abre rota
   administrativa, e a sessão humana não obtém manifesto.
2. **Permissão** — matriz `role → permission` em `contracts/rbac.ts`,
   compartilhada com a UI apenas para desabilitar botões *com motivo*.
3. **Escopo** — operador de loja só enxerga as lojas de `store_memberships`.

**Recurso fora do escopo responde 404, não 403.** Um 403 confirmaria que o
recurso existe — oráculo de enumeração que revela a estrutura de uma rede
concorrente. O mesmo vale para o painel Jumpers: para um cliente, ele não
existe.

---

## 6. Fluxos centrais

### Manifesto do player

```
agenda (fuso IANA da loja) ──▶ playlist ──▶ motor de rotação ──▶ manifesto
```

O mesmo resolvedor alimenta o calendário do painel e o manifesto do player —
não há duas implementações para divergir. A vigência de campanha é avaliada
**a cada manifesto**, então conteúdo vencido para de tocar sozinho, sem job e
sem janela de atraso.

URLs de áudio são HMAC de TTL curto, com `audience` amarrado ao dispositivo:
um link vazado não serve a outro player.

### Eventos de reprodução

O `event_id` nasce no **player** (UUID) e é a chave primária da tabela.
Reenviar o buffer após uma reconexão não duplica contagem — a segunda
inserção viola a PK e vira "duplicado aceito". Cada evento vai num
`SAVEPOINT` próprio para que um registro malformado não derrube o lote.

A data **local** da loja é calculada no servidor, com o fuso dela: deixar o
player decidir bagunçaria o relatório de uma rede multi-fuso.

---

## 7. Integrações externas

Todas nascem desligadas e o produto inteiro funciona assim.

| Porta | Contrato | Estado |
| --- | --- | --- |
| `AnnouncementCopyProvider` | gera roteiro | sem fornecedor |
| `SpeechSynthesisProvider` | gera locução | sem fornecedor |
| `PaymentProvider` | checkout, webhook, assinatura | sem gateway |
| `ObjectStorage` | áudio | disco (dev); S3 pendente |
| `AudioProbe` | duração e tipo | nativo; ffprobe pendente |
| `Mailer` | e-mail | sem SMTP |

Regras herdadas por qualquer adapter concreto:

- a chamada parte do servidor, nunca do navegador;
- timeout obrigatório e retentativas limitadas;
- retry reusa a `idempotencyKey` e **não** contabiliza uso duas vezes;
- o resultado vira rascunho de versão — nada vai ao ar sem prévia e aprovação;
- `mock`/`fake` são **recusados no boot** com `NODE_ENV=production`.

---

## 8. O que o produto não faz

Explicitado aqui porque promessa vaga vira expectativa frustrada:

- **não mede audiência** — conta execuções confirmadas pelo player, e os
  relatórios dizem isso;
- **não capta áudio ambiente** nem ativa microfone (declarado também em
  `Permissions-Policy`);
- **não distribui catálogo musical** — o lojista envia o que tem direito de
  executar, e a declaração fica registrada com autor e data;
- **não promete continuidade offline que o navegador não entrega** — a
  revogação vale na próxima sincronização, e a UI diz isso antes do clique.
