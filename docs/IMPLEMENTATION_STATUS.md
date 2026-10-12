# Estado da implementação

**Atualizado em:** 12/10/2026
**Como ler:** nada aqui é marcado como pronto sem comando executado e teste
verde. "Comprovação" é o que foi rodado de verdade nesta máquina.

Baseline de verificação, executado por inteiro:

```
npm run verify
  typecheck  tsc -b tsconfig.build.json .......... exit 0
  lint       eslint . --max-warnings=0 ........... exit 0
  invisíveis 74 arquivos, 0 achados ............... exit 0
  testes     14 arquivos, 228 testes ............. 228 passed
```

Teste de fumaça com a API no ar (`npx tsx apps/api/src/main.ts`):
`/health/live` → 200 · `/health/ready` → 200 `degraded` · `/api/v1/status/integrations` → 200 · rota inexistente → 404 com código estável.

---

## Fase 0 — Reconhecimento · **concluída**

| Requisito | Estado | Comprovação |
| --- | --- | --- |
| Auditar repositório existente | Concluído | Pasta continha só blueprint, prompt e 2 PNGs. Zero código, zero manifesto, zero migration, sem git. |
| Baseline de testes anterior | N/A | Não havia suíte para rodar. Registrado como ausente, não como "passou". |
| Decisões arquiteturais | Concluído | Justificadas no README e nos comentários de cada módulo. |

---

## Fase 1 — Fundação · **concluída**

| Requisito | Estado | Comprovação | Risco em aberto |
| --- | --- | --- | --- |
| Monorepo com workspaces | Concluído | 4 pacotes + 3 apps, `tsc -b` com project references, exit 0 | npm workspaces em vez de pnpm (pnpm não disponível na máquina) |
| TypeScript strict | Concluído | `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, exit 0 | — |
| Validação de ambiente fail-fast | Concluído | 18 testes em `packages/runtime/src/config.test.ts` | — |
| Log estruturado com redação | Concluído | `redact()` testado em profundidade; nenhum segredo sai | — |
| Request ID e erros consistentes | Concluído | 4 testes; correlation id arbitrário é recusado | — |
| Health liveness/readiness | Concluído | 4 testes; dependência opcional degrada sem derrubar | — |
| Banco + migrations | Concluído | 7 migrations aplicam do zero; 17 testes em PostgreSQL real | — |
| Seed seguro e não destrutivo | Concluído | 7 testes; recusa `NODE_ENV=production`; idempotente | — |
| CI | **Ausente** | Nenhum workflow escrito ainda | Próxima sessão |
| Docker Compose | **Ausente** | Dev não precisa dele; produção vai precisar | Próxima sessão |

---

## Núcleo de domínio — **implementado e testado**

| Módulo | Estado | Comprovação |
| --- | --- | --- |
| Fuso horário e DST | Concluído | 17 testes: 4 offsets brasileiros, salto e recuo em Santiago, dia de 25 h em Nova York |
| Resolvedor de agenda | Concluído | 20 testes: prioridade, janela cruzando meia-noite, feriado, horário especial, escopo de zona |
| Motor de rotação | Concluído | 26 testes: inserção por faixas/minutos, teto por hora, vigência, janela de silêncio, determinismo por semente |
| Máquinas de estado | Concluído | 19 testes: anúncio, dispositivo, campanha, assinatura |
| RBAC e isolamento | Concluído | 17 testes: 5 papéis, escopo por loja, 404 em vez de 403 |
| Sonda de áudio nativa | Concluído | 14 testes: WAV, MP3 CBR/VBR, FLAC; recusa ZIP, SVG e EXE disfarçados |
| Senhas e tokens | Concluído | 17 testes: scrypt, URLs assinadas, truncamento de IP |
| Cotas de plano | Concluído | 8 testes: bloqueio no limite, erro acionável |
| Exportação CSV | Concluído | 10 testes: injeção de fórmula neutralizada, path traversal bloqueado |
| Fila de jobs | Concluído | 18 testes: `skip locked`, lease expirado, backoff, dead letter |

---

## Portas das integrações — **contratos prontos, sem fornecedor**

| Porta | Estado | Observação |
| --- | --- | --- |
| `AnnouncementCopyProvider` | Interface definida | Nenhum adapter concreto. `disabled` é o padrão. |
| `SpeechSynthesisProvider` | Interface definida | Separada da geração de texto, de propósito. |
| `PaymentProvider` | Interface definida | Nenhum gateway escolhido. Domínio independente de fornecedor. |
| `ObjectStorage` | Driver local pronto | Driver S3 lança erro explícito; não finge funcionar. |
| `AudioProbe` | Driver nativo pronto | Driver ffprobe entra na Fase 4. |
| `Mailer` | Interface definida | Sem SMTP, registra `not_configured`. |

---

## Ainda não construído

Ordem recomendada, seguindo o roadmap do blueprint:

| Fase | Escopo | Depende de |
| --- | --- | --- |
| 2 | Autenticação, sessão, organizações, convites, guards nas rotas | Fundação (pronta) |
| 3 | Lojas, zonas, pairing, heartbeat, revogação | Fase 2 |
| 4 | Upload, pipeline de mídia, anúncios, versões, aprovação | Fase 3 |
| 5 | Playlists e agenda na API e na UI | Motor pronto, falta expor |
| 6 | Player PWA | Fase 5 |
| 7 | Relatórios, dashboards, CSV | Fase 6 |
| 8–13 | Planos, adapters de IA e gateway, painel Jumpers, hardening | Acima |

O console web hoje tem **uma** página: estado real das dependências, lida da
API. Ela existe para não haver tela decorativa no repositório — as telas do
lojista entram sobre a API, não antes dela.

---

## Defeitos encontrados e corrigidos nesta sessão

| Defeito | Como apareceu | Correção |
| --- | --- | --- |
| `avoidBackToBackSameSpot` comparava com o último spot de todos | Teste de inserção falhou: playlist com spot único parava de tocá-lo | Passou a comparar com o item imediatamente anterior |
| Driver PGlite reportava `rowCount: 0` em INSERT/UPDATE/DELETE | Seed disse "0 planos inseridos" tendo inserido 3 | `affectedRows` quando não há linhas retornadas. **Relevante para segurança**: o padrão `update … where organization_id = $1` com `rowCount === 0 → 404` negaria operações legítimas |
| BOM literal (`EF BB BF`) dentro do código-fonte | Lint acusou "irregular whitespace" | Substituído por escape `﻿`; scanner permanente adicionado ao `verify` |
| `isProduction` lido do ambiente do processo, não do argumento | Teste de produção passou pelo motivo errado | `loadConfig(env)` virou função pura do argumento |
| Diretório do banco resolvia contra `packages/db/` | `npm run db:migrate` falhou com ENOENT | Ancorado na raiz do monorepo; diretório criado se faltar |
| Worker importava de dentro de `apps/api` | `tsc` recusou: fora do `rootDir` | `config` e `logger` movidos para `packages/runtime` |
| Artefatos `.js`/`.d.ts` dentro de `src/` | Lint falhou ao parsear | Removidos e bloqueados no `.gitignore` |
