# Estado da implementação

**Atualizado em:** 12/10/2026
**Como ler:** nada é marcado como pronto sem comando executado. "Comprovação"
é o que foi rodado de verdade nesta máquina.

---

## Baseline executado

```
npm run verify
  typecheck   tsc -b tsconfig.build.json .......... exit 0
  lint        eslint . --max-warnings=0 ........... exit 0
  invisíveis  164 arquivos, 0 achados .............. exit 0
  testes      21 arquivos, 380 testes ............. 380 passed

npm run build      API (tsup) + web (next, 18 rotas) ... exit 0
npm run openapi    47 operações derivadas dos schemas ... exit 0
npm run aceite     24/24 verificações ................... ATENDIDO
```

`npm run aceite` roda o critério de aceite do blueprint contra a API no ar.
Não é simulação: são chamadas HTTP reais, do cadastro ao relatório.

---

## Roadmap — fase a fase

| Fase | Escopo | Estado |
| --- | --- | --- |
| 0 | Reconhecimento e plano de risco | **Concluída** |
| 1 | Fundação, config, logs, health, CI | **Concluída** |
| 2 | Auth, organizações, RBAC, isolamento | **Concluída** |
| 3 | Lojas, zonas, pareamento, heartbeat | **Concluída** |
| 4 | Mídia, anúncios, versões, aprovação | **Concluída** · falta pipeline FFmpeg |
| 5 | Playlists, agenda, campanhas | **Concluída** |
| 6 | Player PWA, manifesto, eventos | **Concluída** · falta service worker de cache |
| 7 | Relatórios, dashboards, CSV | **Concluída** |
| 8 | Planos, cotas, uso sem gateway | **Concluída** |
| 9 | Contratos de IA, sem chamada real | **Concluída** |
| 10 | Contrato de gateway, sem cobrar | **Concluída** |
| 11 | Painel Jumpers, auditoria | **Concluída** |
| 12 | Hardening, acessibilidade, docs | **Parcial** — ver lacunas |
| 13 | Checklist de ativação | **Concluída** — `docs/ATIVAR_IA_E_GATEWAY.md` |

---

## Critério de aceite do blueprint

Cada linha verificada por `npm run aceite`:

| Requisito | Comprovação |
| --- | --- |
| Criar conta e organização | papel `owner`, assinatura em trial |
| Duas lojas com fusos diferentes | São Paulo e Manaus, horas locais distintas no mesmo instante |
| Upload de áudio próprio validado | 3 arquivos medidos; ZIP disfarçado recusado |
| Anúncio manual, editado e aprovado | máquina de estados; transição ilegal recusada |
| Playlist com spots inseridos | `music > music > promo_spot > music` |
| Campanha agendada com expiração | vigência avaliada a cada manifesto |
| Parear player e verificar estado | código de uso único; heartbeat reflete no painel |
| Relatórios consistentes e CSV | evento aparece no relatório; CSV com BOM |
| Limites sem cobrança conectada | medidores reais; checkout recusa sem fingir |
| Operar sem IA e sem gateway | ambos devolvem 503 com ação |
| Integrações ausentes identificadas | `/status/integrations` diz o que fica indisponível |
| Isolamento entre tenants | loja alheia → 404; painel Jumpers → 404 |

---

## Cobertura de teste por área

| Área | Testes | Destaque |
| --- | --- | --- |
| Fuso e DST | 17 | salto e recuo em Santiago; dia de 25 h |
| Resolução de agenda | 20 | prioridade, meia-noite, feriado, sem loop |
| Motor de rotação | 26 | teto por hora, vigência no meio, determinismo |
| Máquinas de estado | 19 | webhook duplicado idempotente |
| RBAC e isolamento | 17 | 404 em vez de 403 |
| Cripto e privacidade | 17 | URL assinada adulterada; IP truncado |
| Sonda de áudio | 14 | ZIP, SVG, HTML e EXE recusados |
| Cotas | 8 | bloqueio no limite exato |
| CSV | 10 | injeção de fórmula neutralizada |
| Banco e migrations | 32 | FK composta impede cruzar tenants |
| API (HTTP real) | 164 | 9 módulos, incluindo isolamento cruzado |
| Fila | 18 | `SKIP LOCKED`, lease, dead letter |

---

## Lacunas declaradas

Não executadas nesta máquina. Não contam como aprovadas.

| Item | Por quê | Quando |
| --- | --- | --- |
| Pipeline FFmpeg (normalização, LUFS) | binário ausente; sonda nativa cobre tipo e duração | Fase 4 restante |
| Service worker de cache do player | o player toca e reporta; falta o pre-cache offline | Fase 6 restante |
| Driver S3 do storage | porta pronta; driver lança erro explícito | antes do deploy |
| E2E automatizado (Playwright) | fluxo validado manualmente e por `npm run aceite` | antes do primeiro cliente |
| Teste contra PostgreSQL gerenciado | só PGlite aqui; o SQL é idêntico | junto do deploy |
| Teste de carga | sem ambiente representativo | antes de escalar |
| Restauração de backup | exige banco gerenciado | junto do deploy |
| Adapters reais de IA e gateway | nenhum fornecedor escolhido | após credenciais |

---

## Defeitos encontrados e corrigidos

Dez ao todo. Os três mais relevantes vieram de **testar no navegador**, não
da suíte — registrados aqui porque o padrão importa mais que o bug.

| Defeito | Como apareceu | Correção |
| --- | --- | --- |
| Token CSRF perdido ao recarregar | logado, mas toda escrita falhava | `/auth/me` devolve o token |
| CSRF exigido em rota pública | tablet com cookie de console não pareava | checagem só onde a sessão é usada |
| PGlite aberto por dois processos | `RuntimeError: Aborted()` do WASM | trava de processo único com mensagem |
| `rowCount: 0` em INSERT/UPDATE | seed reportou "0 planos" tendo inserido 3 | `affectedRows`; **relevante para segurança** — o padrão `rowCount === 0 → 404` negaria operações legítimas |
| Transação abortada no lote de eventos | um evento ruim derrubava os bons | `SAVEPOINT` por evento |
| `avoidBackToBackSameSpot` amplo demais | playlist de spot único parava de tocá-lo | compara com o item imediatamente anterior |
| BOM literal no código-fonte | caractere invisível | escape + scanner permanente no `verify` |
| `isProduction` lido do processo | teste validava caminho diferente do real | `loadConfig(env)` virou função pura |
| Diretório do banco relativo ao pacote | cada app teria o próprio banco | ancorado na raiz do monorepo |
| Worker importando de dentro da API | `tsc` recusou o `rootDir` | nasceu `packages/runtime` |
| Imports `.js` quebrando o Turbopack | build do web falhou no 1º import de valor | imports sem extensão em todo o repo |
