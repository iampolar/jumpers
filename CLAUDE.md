# CastWave

SaaS B2B para redes de varejo gerenciarem áudio nas lojas: música ambiente, spots promocionais, avisos operacionais e jingles, programados por loja, zona e horário, a partir de um painel único.

O projeto fica em `castwave/`. A raiz guarda o blueprint original (`Jumpers_CastWave_Arquitetura_Completa.md`), o prompt mestre e os logos.

---

## Princípio inegociável

**O núcleo funciona sem IA e sem gateway de pagamento.** Os dois entram depois, atrás de portas já definidas (`aiCopyProvider`, `aiTtsProvider`, `paymentsProvider`, hoje todos `disabled`). Ver `docs/ATIVAR_IA_E_GATEWAY.md`.

Não introduza dependência de IA ou de cobrança em caminho crítico.

---

## Comandos

```bash
npm install
npm run verify      # typecheck + lint + invisíveis + 381 testes — rode antes de entregar
npm run dev         # sobe API e web juntos
npm run aceite      # script de aceite executável contra a API no ar
```

Login de demonstração: `owner@aurora.exemplo.br` / `castwave-demo-2026`

---

## Armadilhas que já custaram caro

Leia esta seção antes de mexer. Cada item abaixo foi um bug real.

### PGlite é de processo único

O banco de desenvolvimento é PostgreSQL compilado para WebAssembly. **Dois processos no mesmo diretório corrompem o cluster.** Existe um lockfile com PID (`acquireSingleProcessLock`) que recusa o segundo processo com mensagem explicativa — se você vir esse erro, não contorne, encerre o outro processo. É por isso que `scripts/dev.mjs` não sobe o worker em modo PGlite.

Para rodar API e worker juntos, use um Postgres de verdade via `DATABASE_URL`.

### PGlite não devolve `rowCount` em INSERT/UPDATE/DELETE

Use `affectedOrReturned()` de `packages/db/src/client.ts`. **Isso é relevante para segurança:** um `update ... where organization_id = $1` combinado com `rowCount === 0 → 404` negaria operações legítimas.

### Imports relativos não podem ter extensão `.js`

O Turbopack não honra `experimental.extensionAlias`. O erro só aparece no primeiro import de *valor* (imports de tipo somem na compilação), então ele se esconde. 186 imports já foram corrigidos; não reintroduza.

### Datas sempre no fuso da loja

Use `localDateString(instant, timezone)` de `packages/core/src/time/timezone.ts`. **Nunca** `toISOString().slice(0,10)` — isso devolve a data em UTC, e em São Paulo (UTC−3) as duas divergem das 21h à meia-noite. Esse bug já apareceu duas vezes: num teste, que reprovava toda noite nessa janela, e na semente de rotação (`deriveSeed`), onde fazia a programação do dia se reembaralhar sozinha no meio do expediente.

### Constraint violada aborta a transação inteira no Postgres

Em processamento de lote, use `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` por item. Sem isso, um evento ruim mata o lote todo.

### 404, não 403, para recurso fora do escopo

Responder 403 revelaria que o recurso existe — vira oráculo de enumeração entre tenants.

### Arquivos com caracteres invisíveis

`npm run check:invisible` varre BOM e afins, e está dentro do `verify`. Já aconteceu de uma ferramenta de escrita materializar `﻿` como caractere real no fonte.

---

## Arquitetura

Monorepo com npm workspaces, TypeScript estrito (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), project references.

```
packages/contracts   schemas Zod — fonte da verdade dos contratos
packages/core        regras de negócio puras (rotação, agendamento, fuso)
packages/db          cliente SQL, migrações, seed
packages/runtime     configuração compartilhada entre apps
apps/api             Fastify 5
apps/web             Next.js 16 (Turbopack) + Tailwind v4
apps/worker          fila de jobs
```

**Isolamento multi-tenant é estrutural, não convencional:** as foreign keys são compostas `(id, organization_id)`, o que torna associação entre tenants impossível no nível do banco. Não crie FK simples em tabela com `organization_id`.

**SQL é escrito à mão.** Não há ORM. A fila usa `SKIP LOCKED` com expiração de lease.

**Sessões são opacas no banco**, não JWT. CSRF por double-submit. URLs de mídia assinadas com HMAC. Senhas com scrypt (não Argon2id — evita node-gyp).

`docs/openapi.json` é **gerado** a partir dos schemas Zod que validam de verdade (`npm run openapi`), então não diverge do comportamento.

---

## Identidade visual

Quatro cores, em `apps/web/src/app/globals.css`:

```
Azul Noite      #081020   fundo
Ciano Tech      #00D1FF   destaque E preenchimento primário (10.5:1 sobre o fundo)
Branco Absoluto #FFFFFF   texto
Cinza Titanium  #8495A7   secundário
```

Duas coisas não óbvias:

- **A paleta de marca não serve como paleta de dados.** Ciano puro é claro demais para conviver com outras séries na mesma faixa de luminosidade. As cores de gráfico vivem em `lib/chart-palette.ts`, validadas para daltonismo. Não troque uma pela outra.
- **O fundo do login e o do console são o mesmo efeito**, não dois parecidos. Os parâmetros de movimento estão numa constante única (`MALHA` em `components/ambient-background.tsx`); só a intensidade difere. Se for mexer, mexa na intensidade, não na composição.

A luz do ponteiro é uma camada larga e fraca de propósito. **Se ela aparecer como um círculo, está errada** — quem responde ao cursor são os pontos da malha. Ver `docs/REFINAMENTO_VISUAL.md`, seção 5.

Variáveis CSS são escritas por `requestAnimationFrame` sem estado do React: o ponteiro dispara dezenas de eventos por segundo e re-renderizar derrubaria o quadro.

---

## Testes

381 testes em 21 arquivos, todos passando. `npm run verify` roda tudo.

**Três defeitos foram encontrados só dirigindo o navegador de verdade** — token CSRF perdido no reload, CSRF aplicado indevidamente em rota pública, e o fundo do console que divergia do login em comportamento. Compilar e passar nos testes não substitui abrir a aplicação e olhar.

Não desligue checagem para fazer algo passar.

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| `docs/CASTWAVE_ARCHITECTURE.md` | arquitetura completa |
| `docs/IMPLEMENTATION_STATUS.md` | o que está pronto e o que não está |
| `docs/RUNBOOK.md` | operação |
| `docs/TEST_PLAN.md` | estratégia de teste |
| `docs/ATIVAR_IA_E_GATEWAY.md` | como plugar IA e cobrança depois |
| `docs/REFINAMENTO_VISUAL.md` | decisões visuais e o que foi medido |
| `docs/adr/` | decisões de arquitetura registradas |

---

## Idioma

Código, comentários, documentação e interface em **português**, sem acentos nos comentários de código (convenção já estabelecida no repositório). Mantenha.
