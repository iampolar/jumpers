# JUMPERS · CastWave
## Blueprint de produto, arquitetura, execução e critérios de aceite

**Versão:** 1.0 · **Data:** 12/10/2026  
**Marca:** Jumpers  
**Produto:** CastWave  
**Categoria:** SaaS B2B para sonorização comercial, playlists e anúncios por voz em lojas físicas.

---

## 1. A visão — não é só um site que transforma texto em voz

**CastWave é a central de áudio inteligente do varejo.** O lojista organiza músicas licenciadas ou próprias, cria anúncios de ofertas, agenda mensagens por horário e loja, monta uma grade de programação e controla a reprodução de vários pontos físicos por um painel web. Quando as integrações de IA forem conectadas, o mesmo fluxo poderá transformar uma ideia ou promoção em um roteiro e em uma locução profissional; antes disso, o produto já deve funcionar com texto manual, modelos prontos e upload de áudio.

### Proposta de valor

> **“Sua loja no ritmo certo. Música, ofertas e avisos no momento certo.”**

O cliente não compra “uma voz de IA”. Ele compra consistência, autonomia e controle sobre a comunicação sonora de suas lojas.

### Diferenciais que tornam a ideia maior

1. **Programação comercial, não apenas uma playlist:** combinar música ambiente, ofertas, avisos, jingles e mensagens institucionais em uma grade por dia, hora, loja e zona de áudio.
2. **Campanhas com começo e fim:** “Oferta de hoje” pode entrar em rotação durante uma janela definida, deixar de tocar automaticamente após o vencimento e gerar um relatório.
3. **Rede de lojas em um único painel:** uma marca controla todas as filiais, mas pode personalizar conteúdo para cada unidade ou grupo de unidades.
4. **Player dedicado e resiliente:** cada loja pareia um navegador/dispositivo por código; o player baixa antecipadamente os próximos arquivos e continua tocando durante quedas temporárias de internet quando o cache estiver disponível.
5. **Operação segura:** rascunhos e prévias antes da publicação, limites de duração, prioridade, bloqueios de horário, trilha de auditoria e alertas de player offline.
6. **Métricas operacionais reais:** reproduções iniciadas, concluídas, falhas, disponibilidade dos dispositivos e campanhas por período/loja. O produto nunca deve afirmar que alguém ouviu ou comprou apenas porque um áudio tocou.
7. **Pronto para IA sem ficar refém dela:** roteiro manual, modelos e upload funcionam desde o primeiro dia. IA entra por interfaces substituíveis, sem reescrever o núcleo.
8. **Pronto para cobrança sem acoplamento:** catálogo de planos, limites e controle de assinatura existem independentemente do gateway. O adaptador de pagamento é conectado posteriormente.

### O que o CastWave NÃO deve ser

- Não deve ser só um formulário de texto com botão “gerar áudio”.
- Não deve se apresentar como biblioteca de músicas com direitos autorais incluídos. O cliente só usa faixas que tenha direito de executar.
- Não deve simular uma geração de IA, um pagamento ou um webhook em produção quando o respectivo provedor não estiver configurado.
- Não deve exigir IA para cadastrar loja, criar roteiro, carregar áudio, agendar ou tocar conteúdo.
- Não deve misturar dados de empresas/lojas diferentes, nem expor painéis administrativos da Jumpers aos clientes.

---

## 2. Perfis e permissões

### 2.1 Papéis

- **Jumpers Superadmin:** gerencia organizações, planos, flags, status dos serviços, incidentes e suporte operacional. Não deve visualizar conteúdo privado do cliente por padrão; acesso excepcional precisa de motivo e auditoria.
- **Dono da organização (Owner):** administra assinatura, usuários, lojas, permissões e configurações da própria empresa.
- **Administrador da organização:** gerencia conteúdo, lojas, dispositivos, programação e relatórios; sem poderes globais da Jumpers.
- **Editor de conteúdo:** cria roteiros, envia áudio, monta playlists e campanhas; pode precisar de aprovação antes de publicar.
- **Operador de loja:** visualiza o estado do player e executa ações limitadas na(s) loja(s) autorizada(s).
- **Leitor/Financeiro:** consulta relatórios e informações de assinatura conforme permissão; não edita conteúdo.
- **Dispositivo/player:** identidade técnica limitada, sem sessão humana e sem acesso a telas administrativas.

### 2.2 Isolamento obrigatório

Cada registro de negócio deve pertencer a uma `organization_id`; registros ligados a uma loja devem, quando aplicável, conter também `store_id`. Toda consulta deve obter o escopo a partir da sessão autenticada e validar o vínculo entre organização, loja, usuário e recurso. Não confiar em `organization_id` vindo livremente do navegador.

Aplicar testes de isolamento cruzado em endpoints de leitura, edição, exclusão, exportação, download de áudio, relatórios, jobs e player. Preferir chaves estrangeiras compostas para impedir associações entre organizações diferentes. Registrar ações sensíveis em log de auditoria.

---

## 3. Experiência do produto

### 3.1 Mapa da aplicação

**Área da organização**

1. **Visão geral:** resumo de lojas ativas/offline, status do áudio, campanhas em execução, próximos anúncios, alertas e uso do plano.
2. **Programação:** calendário e grade por dia/horário; exceções para feriados, eventos e horários especiais.
3. **Anúncios:** lista com busca, filtros, estado, loja-alvo, janela de validade, duração e prévia; criar anúncio manualmente ou a partir de modelo.
4. **Criador de anúncio:** objetivo, oferta, produto/serviço, preço informado pelo lojista, condições, tom, duração desejada, pronúncia de marcas, roteiro editável e aprovação. O botão de IA fica desabilitado e explica como será habilitado se não houver provedor configurado.
5. **Biblioteca de áudio:** músicas, locuções, jingles e avisos; upload, metadados, duração, formato, volume normalizado, origem e confirmação de direitos de uso.
6. **Playlists:** sequências de faixas e anúncios, regras de inserção de anúncios, repetição e ordem aleatória controlada.
7. **Campanhas:** período de vigência, lojas participantes, anúncios associados, frequência, prioridades, limites e resultados.
8. **Lojas e zonas:** cadastro de filiais, fuso horário IANA, horário de funcionamento, zonas (salão, caixa, entrada etc.) e configurações individuais.
9. **Dispositivos/Players:** pareamento, nome, loja/zona, última atividade, versão, estado, última reprodução, erros e revogação.
10. **Relatórios:** execução por período, loja, campanha, anúncio, playlist e dispositivo; exportação CSV quando autorizado.
11. **Equipe e permissões:** convites, funções, acesso por loja, estado do usuário e revogação de sessões.
12. **Assinatura e uso:** plano atual, limites, medidores, histórico, estado de cobrança e opção de checkout somente quando o gateway estiver configurado.
13. **Configurações:** identidade da empresa, voz/preferências futuras, volume do player, política de aprovação, fuso horário e notificações.
14. **Central de ajuda:** artigos curtos, diagnóstico do player, abertura/consulta de chamados e status do serviço.

**Área Jumpers (separada por layout, autorização e rotas)**

- Visão geral de operação e saúde dos serviços.
- Organizações, usuários e estado de contas.
- Planos, limites e concessões manuais auditadas.
- Jobs, falhas, tentativas e fila de reprocessamento.
- Eventos de pagamento e webhooks, quando conectados.
- Auditoria, status das integrações e configurações operacionais sem expor segredos.
- Ferramentas de suporte com acesso mínimo e trilha de auditoria.

**Player de loja**

- Tela minimalista de “tocando agora”, próxima faixa/anúncio, loja/zona, conexão, última sincronização e estado do cache.
- Botão de início explícito na primeira ativação do navegador para respeitar bloqueios de reprodução automática.
- Nunca mostrar ferramentas administrativas na sessão do dispositivo.
- Tela de recuperação com instrução clara se o dispositivo perder autorização, a loja ficar sem programação ou algum arquivo falhar.

### 3.2 Direção visual

- **Marca-mãe:** JUMPERS. **Produto:** CastWave.
- **Personalidade:** premium, precisa, sonora, confiável e acessível para um gerente de loja — sem parecer software corporativo antigo.
- **Paleta sugerida:** Ink `#070A12`, Surface `#101522`, Surface Elevated `#171D2B`, Cyan `#16D9E8`, Blue `#3977FF`, Violet de apoio `#7C5CFF`, Text `#F5F7FB`, Muted `#98A2B3`, Success `#36C98F`, Warning `#F5B942`, Danger `#F06472`.
- **Tipografia:** Geist ou Inter; títulos compactos e confiantes; números tabulares nos relatórios.
- **Componentes:** cartões discretos, bordas finas, estados claros, foco de teclado visível, gráficos simples, espaços generosos e animação curta. Evitar glassmorphism excessivo e neon em toda superfície.
- **Marca:** usar o coelho como silhueta geométrica ligada a ondas sonoras, não como mascote infantil. Garantir variantes clara, escura, símbolo isolado, favicon e wordmark. Validar leitura em 16–32 px antes de aprovar.
- **Acessibilidade:** WCAG 2.2 AA como objetivo; estados nunca comunicados só por cor; navegação por teclado; labels reais; contraste medido; redução de movimento respeitada.

---

## 4. Escopo de lançamento

### Entra no MVP funcional

- Autenticação e recuperação de conta; organização/tenant; convite de equipe e RBAC.
- Cadastro de lojas, zonas e horários, incluindo fuso horário.
- Criação manual de roteiros e anúncios com modelos reutilizáveis.
- Upload de áudio próprio/licenciado, validação de arquivo, processamento de duração e normalização por worker.
- Playlists com músicas/anúncios e regras de inserção em pontos definidos.
- Campanhas com início/fim, seleção de lojas e prioridades.
- Agenda e publicação; preview antes de ativar; aprovação configurável.
- Pairing seguro do player por código de uso único e curto prazo.
- Player web/PWA com reprodução, sincronização, heartbeat, cache antecipado e recuperação de conectividade dentro dos limites do navegador.
- Métricas de execução, dashboards e CSV.
- Planos/limites/configuração interna e medição de uso sem checkout real.
- Painel Jumpers isolado, auditoria, saúde, logs, jobs e gestão de falhas.
- Adaptadores e contratos prontos para IA/TTS e gateway, cobertos por testes, mas sem falsificar integrações reais.
- Docker Compose local, migrations, seed seguro, documentação, testes unitários/integrados/E2E e pipeline de qualidade.

### Não bloquear o MVP com

- Aplicativo nativo de Windows/Linux, marketplace de vozes, editor de áudio multifaixa completo, criação automática de jingles, integração com hardware de som proprietário ou analytics avançado de audiência.
- Catálogo de música comercial licenciada incluído pela Jumpers.
- Promessas de atribuição de vendas, reconhecimento de público ou captação de microfone.

Estas possibilidades devem caber na arquitetura sem serem simuladas como prontas.

---

## 5. Arquitetura técnica recomendada

> Antes de criar ou alterar código, o agente deve auditar o repositório real. Se já existir stack madura e coerente, preservá-la quando tecnicamente viável. Não reescrever o projeto apenas por preferência pessoal. A stack abaixo é a referência para um repositório novo ou sem decisões existentes.

### 5.1 Stack de referência

- **Monorepo:** pnpm workspaces, TypeScript strict.
- **Web app:** Next.js App Router, React, Tailwind CSS, componentes acessíveis (Radix/shadcn ou equivalentes já existentes), React Hook Form + Zod, TanStack Query para estado remoto e biblioteca de gráficos simples.
- **API:** NestJS em módulos de domínio, REST versionada em `/api/v1`, validação de DTOs, OpenAPI/Swagger e tratamento consistente de erros.
- **Worker:** processo Node/Nest separado para jobs de áudio, agendamento, eventos do player e relatórios; compartilhar contratos e serviços de domínio, não importar código de UI.
- **Banco:** PostgreSQL; Prisma ORM (ou ORM já adotado); migrations versionadas e SQL explícito para constraints que o ORM não expresse bem.
- **Filas:** Redis + BullMQ, jobs idempotentes, retry com backoff, limite de concorrência e fila de falhas.
- **Arquivos:** API compatível com S3; MinIO local via Docker Compose e S3/R2 compatível em produção, por configuração. Banco guarda metadados; não guardar arquivos binários grandes em tabelas.
- **Processamento de áudio:** FFmpeg/ffprobe no worker para duração, validação técnica e normalização configurável; fixar/documentar versão e tratar ausência do executável como readiness degradada, não sucesso fictício.
- **Player:** módulo PWA separado logicamente; service worker/cache com limites explícitos; API de device restrita por token próprio.
- **Testes:** Vitest ou Jest conforme o repositório, Supertest para API, Playwright para fluxos E2E, testes de migrations/DB real quando possível.
- **Dev/ops:** Docker Compose, `.env.example` sem segredos, logs JSON estruturados, `/health/live` e `/health/ready`, política de backups, CI com lint, typecheck, testes e build.

### 5.2 Organização possível do monorepo

```text
apps/
  web/                 # painel da organização + painel Jumpers + player
  api/                 # REST, auth e domínio
  worker/              # filas, áudio, agendamento, métricas
packages/
  contracts/           # schemas Zod, DTOs compartilhados e eventos
  ui/                  # design system reutilizável
  config/              # configurações TS/ESLint compartilhadas
infra/
  docker/              # Dockerfiles e Compose
  scripts/             # setup, migrations auxiliares, seed, backup/restore
  docs/                # diagramas, decisões e runbooks
```

A divisão é uma referência, não uma obrigação. Preferir módulos claros a microserviços prematuros. O MVP deve ser um **monólito modular com worker separado**, capaz de evoluir sem custo operacional desnecessário.

### 5.3 Módulos de domínio da API

- `AuthModule` — sessões, credenciais, recuperação e proteção de tentativas.
- `OrganizationsModule` — tenants, membros e preferências.
- `AccessControlModule` — papéis, permissões e escopos por loja.
- `StoresModule` — lojas, zonas e timezone.
- `DevicesModule` — pairing, autenticação de player, heartbeat e revogação.
- `MediaModule` — upload seguro, metadados, storage e processamento.
- `AnnouncementsModule` — roteiros, versões, duração e estados.
- `PlaylistsModule` — itens, ordem, inserção de spots e regras de rotação.
- `SchedulingModule` — calendário, janelas, exceções, DST e publicação.
- `CampaignsModule` — vigência, segmentação e métricas.
- `PlaybackModule` — manifesto de reprodução, confirmação de eventos e operação offline.
- `AnalyticsModule` — agregações, relatórios e exportação.
- `BillingModule` — planos, assinaturas, entitlements, consumo e gateway port.
- `AIIntegrationModule` — contrato de geração de roteiro e síntese de fala, sem dependência concreta.
- `NotificationsModule` — notificações internas; e-mail opcional por adapter configurável.
- `SupportModule` — chamados e diagnóstico.
- `AuditModule` — trilha append-only para eventos sensíveis.
- `AdminModule` — operações globais explicitamente autorizadas e auditadas.
- `HealthModule` — health/readiness de banco, Redis, storage e workers.

---

## 6. Principais fluxos de negócio

### 6.1 Criar e publicar um anúncio

1. Editor seleciona loja(s), campanha, janela de validade, objetivo, oferta e restrições.
2. Escreve o texto manualmente ou seleciona um modelo. A geração por IA é uma capability opcional.
3. O sistema valida campos, tamanho, termos proibidos/configurações comerciais, duração estimada e se a oferta tem datas coerentes.
4. O editor escuta prévia quando houver áudio e pode substituir o arquivo por upload.
5. O conteúdo é salvo como rascunho/versionado; em organizações com aprovação, solicita revisão.
6. Ao ser aprovado/publicado, o serviço cria uma versão imutável e programa o item para lojas elegíveis.
7. Os players obtêm manifesto assinado, baixam os próximos recursos e sincronizam a grade.
8. O player registra início, conclusão ou falha com `event_id` idempotente.
9. Relatórios agregam eventos sem alegar que um cliente ouviu a mensagem.
10. No fim da campanha, o anúncio deixa de ser elegível automaticamente; mantém-se histórico auditável.

### 6.2 Grade de áudio da loja

A grade precisa distinguir:

- **Faixa musical:** reprodução de fundo.
- **Spot promocional:** anúncio inserido entre faixas ou em intervalos configurados.
- **Aviso operacional:** abertura, fechamento, fila, segurança ou comunicado.
- **Jingle institucional:** item sonoro curto de marca.

Regras configuráveis por playlist/loja: janela de execução, intervalo entre spots, repetição máxima por período, prioridade, validade, pausa por horário, evitar anúncios duplicados seguidos e comportamento quando um item falha. Prioridade deve ser explícita e testada para não criar loops infinitos.

O MVP deve inserir anúncios em pontos definidos (por exemplo, após N faixas ou por janela de tempo) e evitar sobreposição por padrão. Ducking de música durante locução pode entrar como melhoria posterior, sob feature flag e testes de áudio.

### 6.3 Parear um player

1. Usuário autorizado escolhe loja e zona e solicita código de pareamento.
2. Código aleatório de uso único, TTL curto (ex. 5 minutos) e armazenado como hash.
3. Player mostra código; usuário o confirma no painel.
4. API troca código por credencial de dispositivo, armazena apenas hash/rotaciona o segredo quando viável e retorna o escopo mínimo.
5. Device recebe manifesto só da loja/zona autorizada.
6. Usuário pode renomear, mover, suspender ou revogar o dispositivo; a revogação bloqueia novas sincronizações e exige novo pareamento.

### 6.4 Offline e recuperação

- Player sincroniza manifesto e pré-carrega o conjunto futuro de itens dentro de limite por bytes/tempo.
- Eventos ficam em buffer local com ID idempotente e são enviados ao reconectar.
- Se não existir cache válido, mostrar estado claro e não afirmar “tocando”.
- Cache deve ter limites e política de limpeza; downloads devem ser verificados por tamanho/checksum quando disponível.
- Estado offline não pode impedir que o usuário revogue um dispositivo no servidor; a revogação terá efeito ao reconectar, portanto tokens e manifestos devem expirar em prazo curto e o comportamento deve constar na documentação.
- Browser/PWA tem limites de autoplay, suspensão e cache conforme o dispositivo. O produto deve comunicar esses limites e registrar métricas; não prometer confiabilidade de um appliance nativo.

---

## 7. Estados e regras de consistência

### 7.1 Estados do anúncio

`DRAFT → PENDING_APPROVAL → APPROVED → SCHEDULED → ACTIVE → COMPLETED/EXPIRED`  
Estados alternativos: `REJECTED`, `PAUSED`, `CANCELLED`, `FAILED`.

Nem toda organização usa aprovação; a transição permitida deve vir de uma máquina de estados no domínio, não de strings arbitrárias enviadas pelo frontend. Publicar uma versão gera um snapshot auditável do conteúdo aprovado.

### 7.2 Estados do dispositivo

`PAIRING → ACTIVE → DEGRADED/OFFLINE → REVOKED`.

`OFFLINE` deve derivar de heartbeat com timeout configurável; não depende exclusivamente do navegador dizer que está offline. O estado `REVOKED` é terminal para a credencial atual.

### 7.3 Estados da assinatura

Estados mínimos: `TRIALING`, `ACTIVE`, `PAST_DUE`, `PAUSED`, `CANCELLED`, `EXPIRED`, `INCOMPLETE`. Transições precisam ser explícitas. O produto deve definir comportamento de grace period e bloqueio por plano; nunca apagar áudio ou campanhas ao cancelar assinatura. O gateway futuro não é a fonte única do estado: eventos validados atualizam o domínio com idempotência e auditoria.

### 7.4 Consistência

- Operações financeiras, publicação e pairing devem ser transacionais quando aplicável.
- Jobs aceitam chave de idempotência e podem ser reexecutados sem duplicar resultado.
- Mudanças agendadas precisam respeitar timezone IANA e horário de verão; datas são armazenadas em UTC, com timezone da loja preservado para regras locais.
- Erros de validação retornam forma consistente (código estável, mensagem segura, detalhes de campo); não retornar stack traces em produção.
- Todas as listagens usam paginação, filtro e ordenação permitida pelo servidor.

---

## 8. Modelo de dados sugerido

Os nomes finais devem acompanhar convenções existentes do repositório. Criar migrations incrementais, índices e constraints; não adicionar tabelas sem uso funcional. Todas as tabelas de domínio precisam de `created_at`, `updated_at` quando aplicável, e `organization_id` nos dados multi-tenant.

### Identidade e organização

- `users`: id, nome, e-mail normalizado/único, hash de senha ou referência ao sistema de auth, estado, timestamps.
- `organizations`: id, nome comercial, slug interno, timezone padrão, estado, plano atual/referência de assinatura, timestamps.
- `organization_memberships`: organization_id, user_id, role, status, permissions opcionais; unique (organization_id, user_id).
- `store_memberships` (ou tabela de escopo): user_id, organization_id, store_id, permissões limitadas para usuário de loja.
- `sessions`, `password_reset_tokens`, `email_verification_tokens`: tokens persistidos com hash, expiração e uso único quando o sistema de auth próprio for adotado.

### Lojas e players

- `stores`: id, organization_id, nome, slug, endereço opcional, timezone, abertura/fechamento e estado.
- `audio_zones`: id, organization_id, store_id, nome, configuração de volume/uso e estado.
- `player_devices`: id, organization_id, store_id, zone_id, nome, token_hash, status, last_seen_at, app_version, last_error_code, paired_at, revoked_at.
- `device_pairing_codes`: id, organization_id, store_id, zone_id, code_hash, expires_at, used_at, requested_by_user_id.
- `device_heartbeats` (opcional se histórico necessário): device_id, timestamp, health, buffer_depth, current_item_id, app_version.

### Conteúdo, mídia e playlists

- `media_assets`: id, organization_id, kind, storage_key, original_filename saneado, mime_type detectado, size_bytes, duration_ms, checksum, status de processamento, metadata JSON validado, uploaded_by, rights_attested_at.
- `announcements`: id, organization_id, title, type, status, current_version_id, created_by, approved_by, valid_from, valid_until, deleted_at/archive state.
- `announcement_versions`: id, organization_id, announcement_id, version_number, script_text, locale, pronunciation_dictionary JSON validado, media_asset_id, estimated_duration_ms, approval metadata, content_hash, created_at; unique (announcement_id, version_number).
- `playlists`: id, organization_id, nome, tipo, status, política de rotação, regras de spots JSON validado ou tabelas normalizadas.
- `playlist_items`: id, organization_id, playlist_id, media_asset_id/announcement_version_id, sort_order, item_type, weight/interval, priority, active_from, active_until, max_plays_per_period.
- `schedules`: id, organization_id, store_id/zone_id, playlist_id, weekdays, start_local_time, end_local_time, effective_from, effective_until, priority, timezone snapshot/policy.
- `schedule_exceptions`: store_id, date local, regra (override/blackout/special hours), payload validado, author.

### Campanhas e reprodução

- `campaigns`: id, organization_id, nome, objetivo, status, starts_at, ends_at, target scope, created_by, approval state.
- `campaign_announcements`: campaign_id, announcement_version_id, store_id opcional, prioridade e limites de frequência.
- `playback_events`: id/event_id idempotente, organization_id, store_id, zone_id, device_id, item/version, event_type (`started`, `completed`, `failed`, `skipped`), occurred_at_device, received_at_server, duration_ms, error_code e metadados mínimos.
- `analytics_daily`: organization_id, date, store_id, campaign_id/announcement_version_id, started_count, completed_count, failed_count, total_played_ms; tabela derivada/reconstruível.
- `player_manifests` não precisa ser tabela no MVP se puder ser gerado sob demanda; guardar snapshots apenas se necessário para auditoria e debugging.

### Uso, plano e cobrança

- `plans`: código, nome, preço exibido, currency, intervalo, quotas, features JSON validado, active; preços/limites não devem ficar hardcoded no frontend.
- `subscriptions`: organization_id, plan_id, status, period_start/end, trial_end, cancel_at_period_end, provider, provider_customer_id nullable, provider_subscription_id nullable.
- `usage_ledger`: organização, período, métrica, quantidade, origem/idempotency_key; append-only para usos que afetam limites/custos.
- `billing_customers`/`payment_methods` somente com os identificadores não sensíveis necessários do provedor. Nunca armazenar dados completos de cartão.
- `checkout_sessions`: organization_id, provider, provider_session_id, status, idempotency_key, expires_at, metadata validada.
- `payment_webhook_events`: provider, event_id, event_type, payload protegido/minimizado, signature_valid, processed_at, processing_error; unique (provider, event_id). Nunca processar antes de validar assinatura.

### Operação e auditoria

- `notifications`: destinatário, organização, tipo, payload seguro, lida_em, created_at.
- `support_tickets` e `support_messages`: organização, autor, estado, prioridade, conteúdo e auditoria; controlar acesso ao conteúdo.
- `audit_logs`: actor, organization_id, action, resource_type/id, outcome, request_id, IP/UA conforme política de privacidade, timestamp; registros append-only e sem segredos.
- `outbox_events` (recomendado): eventos transacionais pendentes para enfileirar/publicar após commit e evitar inconsistência banco/fila.
- `idempotency_keys`: escopo, chave, request hash, status e resposta mínima/expiração, apenas para endpoints mutáveis que precisam.

### Constraints e índices importantes

- Índices em `(organization_id, created_at)`, `(organization_id, status)`, `(store_id, status)`, `valid_from/valid_until`, `device_id/occurred_at`, `campaign_id/date` e chaves de busca necessárias.
- Unique em e-mail normalizado; slug apropriado; código de pareamento único enquanto válido; `event_id`/provider event únicos; versão de anúncio única por anúncio.
- Checks: duração/bytes não negativos; vigência final posterior ao início; enums válidos; `started/completed` têm campos coerentes; quotas não negativas.
- Foreign keys compostas ou constraints equivalentes impedem cruzar organizações, lojas e anúncios.
- Evitar guardar dados redundantes sem estratégia de snapshot; onde necessário preservar valor/condição histórica, versionar/snapshot explicitamente.

---

## 9. API REST — contrato de alto nível

Todas as rotas privadas exigem autenticação e autorização server-side. Usar `/api/v1`, paginação consistente, filtros permitidos, schema documentado e correlation/request ID. Ajustar nomes ao código já existente quando necessário.

### Sessão e organização

- `POST /api/v1/auth/register` (se cadastro público estiver habilitado), `POST /auth/login`, `POST /auth/logout`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `GET /auth/me`.
- `GET/ PATCH /api/v1/organization`.
- `GET/ POST /api/v1/members`, `PATCH/ DELETE /api/v1/members/:id`, `POST /members/:id/resend-invite`.

### Lojas, zonas e players

- `GET/ POST /api/v1/stores`, `GET/ PATCH/ DELETE /stores/:id` (preferir arquivar a apagar registros históricos).
- `GET/ POST /api/v1/stores/:id/zones`, `PATCH/ DELETE /zones/:id`.
- `POST /api/v1/stores/:id/pairing-codes`, `POST /api/v1/devices/pair`, `GET /api/v1/devices`, `GET /devices/:id`, `PATCH /devices/:id`, `POST /devices/:id/revoke`.
- Endpoints device-only: `POST /api/v1/player/heartbeat`, `GET /player/manifest`, `POST /player/events/batch`, `GET /player/assets/:id/authorization`.

### Anúncios e mídia

- `GET/ POST /api/v1/announcements`, `GET/ PATCH /announcements/:id`, `POST /announcements/:id/versions`, `POST /announcements/:id/submit-approval`, `POST /announcements/:id/approve`, `POST /announcements/:id/reject`, `POST /announcements/:id/publish`, `POST /announcements/:id/pause`, `POST /announcements/:id/cancel`.
- `POST /api/v1/media/uploads` (criar upload), `POST /media/uploads/:id/complete`, `GET /media`, `GET /media/:id`, `POST /media/:id/reprocess`, `POST /media/:id/archive`.
- Upload pode usar URL assinada, mas o completion precisa validar tamanho, assinatura/checksum e confirmação de processamento. URL assinada é limitada por tempo e escopo.

### Playlists, agenda e campanhas

- `GET/ POST /api/v1/playlists`, `GET/ PATCH/ DELETE /playlists/:id`, `POST /playlists/:id/items`, `PATCH/ DELETE /playlists/:id/items/:itemId`, `POST /playlists/:id/preview`.
- `GET/ POST /api/v1/schedules`, `PATCH/ DELETE /schedules/:id`, `GET /schedules/calendar`, `POST /schedules/exceptions`.
- `GET/ POST /api/v1/campaigns`, `GET/ PATCH /campaigns/:id`, `POST /campaigns/:id/publish`, `POST /campaigns/:id/pause`, `GET /campaigns/:id/report`.

### Relatórios, uso e operação

- `GET /api/v1/analytics/overview`, `/analytics/playback`, `/analytics/campaigns`, `/analytics/devices`, `/analytics/export.csv`.
- `GET /api/v1/usage`, `GET /api/v1/billing/plans`, `GET /api/v1/billing/subscription`, `POST /api/v1/billing/checkout` (retorna `provider_not_configured` sem fingir checkout), `POST /api/v1/billing/cancel` (respeitando as regras do domínio).
- `GET /api/v1/notifications`, `PATCH /notifications/:id/read`, suporte e auditoria conforme papel.
- `GET /health/live`, `GET /health/ready`, `GET /api/v1/status/integrations` (somente status operacional, nunca segredos).

### Painel Jumpers

Prefixo lógico próprio e guards `superadmin`: organizações, plano/limite, fila de jobs, eventos de webhook, saúde e auditoria. Não usar apenas esconder links no frontend; a API tem de negar acesso por padrão.

---

## 10. As duas integrações que ficam para a etapa seguinte

### 10.1 IA: separar escrita de roteiro e síntese de voz

Não acoplar o domínio a um fornecedor. Prever, no mínimo, estes contratos:

```ts
export interface AnnouncementCopyProvider {
  generate(input: CopyGenerationInput): Promise<CopyGenerationResult>;
}

export interface SpeechSynthesisProvider {
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
}
```

Os contratos reais devem usar schemas estritos compartilhados, timeout, limite de entrada, controle de idioma (`pt-BR` no lançamento), metadados de uso/custo quando disponibilizados e erros tipados. O resultado do TTS retorna arquivo/stream e metadados — nunca uma URL pública permanente.

**Pronto agora:** formulário, modelos, roteiro manual/editável, upload de áudio, estados de integração, feature flags, job orchestration, orçamento/quotas, rastreio de uso, logs sem conteúdo sensível e testes de contrato.  
**Depois:** adapter real para LLM e adapter real de TTS, secrets no ambiente e testes de integração autorizados.

Regras:

- Não chamar o fornecedor pelo browser.
- Nunca incluir chave em bundle, logs, mensagem de erro ou repositório.
- Não transmitir anúncio diretamente para reprodução assim que a IA responder; manter prévia, edição e aprovação conforme política da organização.
- Validar schema, duração/limites, roteiro vazio, resultado de áudio, tipo, bytes e checksum.
- Não cobrar/contabilizar em duplicidade em retry; usar chave de idempotência e registrar o uso com estado claro.
- Se não houver credencial, a geração fica explicitamente indisponível; escrita manual e upload continuam plenamente utilizáveis.
- `MockAIProvider` apenas em testes e desenvolvimento claramente identificado. Nunca retornar áudio falso como sucesso em produção.

### 10.2 Gateway de pagamento

Definir a porta interna `PaymentProvider`, por exemplo com operações tipadas para criar checkout, validar/verificar evento, consultar status e solicitar cancelamento/reembolso se o escopo contratado exigir. O domínio de assinaturas não deve depender de Stripe, Mercado Pago, Pagar.me ou outro fornecedor específico.

**Pronto agora:** planos e preços configuráveis, quotas, subscriptions state machine, página de assinatura, estado “gateway não configurado”, interface do adapter, armazenamento de eventos, idempotência, sandbox contract tests e tratamento de assinatura inválida.  
**Depois:** implementar o adapter do gateway escolhido, configurar secrets/URLs, testar sandbox, confirmar webhooks e realizar checklist de produção.

Regras críticas:

- Nenhum checkout marcado como pago com base apenas no redirect do navegador.
- Validar assinatura do webhook antes de qualquer efeito colateral.
- Aplicar idempotência em `(provider, event_id)` e verificar a transição de estado permitida.
- Guardar payload mínimo necessário e proteger dados pessoais; nunca guardar cartão completo/CVV.
- Não aceitar valor/moeda enviados pelo cliente como fonte de verdade; buscar plano/preço no servidor.
- `PAYMENTS_PROVIDER=disabled` bloqueia criação de checkout real e informa motivo acionável.
- `FakePaymentProvider` é apenas para testes. Não pode estar habilitado em ambiente `production`.

### 10.3 Integrações auxiliares sem bloquear o produto

- Notificações internas funcionam sem serviço externo. E-mail pode ter um adapter SMTP padrão/configurável e uma implementação local de captura para desenvolvimento; se não houver SMTP configurado, não fingir entrega — registrar `not_configured` e manter a notificação dentro do app.
- Storage usa MinIO local por padrão e driver S3 compatível por configuração.
- Processamento usa FFmpeg/ffprobe instalado no container do worker.
- O produto deve informar o estado de cada dependência de forma segura e sem expor valores de ambiente.

---

## 11. Segurança, privacidade e LGPD

1. **Autenticação:** hash de senha moderno (Argon2id ou implementação madura já adotada), sessões seguras HttpOnly/Secure/SameSite se cookies forem usados, proteção CSRF conforme estratégia, limitação de tentativas e respostas anti-enumeração na recuperação.
2. **Autorização:** RBAC no servidor, escopo por organização e loja em todas as operações; negar por padrão; testar IDOR/BOLA.
3. **Admin Jumpers:** MFA recomendado/obrigatório para superadmins; rotas e layout separados; ações sensíveis com motivo e auditoria.
4. **Player:** credenciais próprias, hash em repouso, pairing de uso único, tokens rotacionáveis, escopo mínimo por loja/zona, rate limit e revogação.
5. **Arquivos:** verificar MIME por conteúdo, assinatura/magic bytes, tamanho máximo, duração máxima, nomes saneados, evitar path traversal, armazenar fora do web root, URLs assinadas curtas e antivírus/scan quando operacionalmente disponível.
6. **Segredos:** `.env` fora do Git, validação fail-fast em produção, nenhuma chave nos logs, frontend ou artefatos; `.env.example` só com nomes e exemplos não sensíveis.
7. **Webhooks:** assinatura validada antes de parsear/processar efeitos; idempotência; tolerância a replay/timestamp se o fornecedor suportar; guardar falhas com política de reprocessamento segura.
8. **Banco:** menor privilégio, migrations auditáveis, backups criptografados, retenção definida, teste real de restore. Nunca usar seed destrutivo em dados existentes.
9. **Auditoria:** login administrativo, mudanças de plano/permissão, publicação/aprovação, pairing/revogação, exportação e operação de suporte.
10. **Privacidade:** não coletar áudio ambiente de loja, não ativar microfone, não capturar dados de clientes. Minimizar IP/UA e definir retenção; permitir exportar/excluir dados quando legalmente aplicável, preservando registros que precisem ser retidos por obrigação legítima.
11. **Conteúdo:** exigir que o cliente confirme direitos de uso de músicas e locuções enviadas; política de denúncia/remoção e trilha de quem publicou.
12. **Headers e rede:** TLS em produção, CSP, HSTS, proteção clickjacking, CORS restrito, cookies seguros, rate limit, validação de entrada e saída.
13. **Erros:** respostas públicas genéricas; detalhes internos apenas nos logs com request ID. Nunca exibir stack trace/SQL ao cliente.

---

## 12. Workers, filas e operações

Filas previstas:

- `media-process`: inspeção, duração, normalização e status do arquivo.
- `announcement-ai`: futura geração de texto/voz; existe por contrato, mas não executa provider real sem configuração.
- `schedule-publish`: atualizar elegibilidade/publicação de conteúdos agendados.
- `analytics-rollup`: agregar eventos do player, reconstruível a partir do ledger bruto.
- `notification-delivery`: notificação interna e, opcionalmente, e-mail.
- `billing-events`: processamento de eventos validados de pagamento quando o adapter for conectado.

Todo job deve ter payload tipado, idempotency key, timeout, política de retry exponencial, limite de tentativas, logs com `jobId` e `requestId`, status de falha visível e ferramenta de reprocessamento auditada. Não colocar texto de anúncio completo, tokens ou payloads sensíveis em logs. Jobs de alto volume devem ser limitados por organização/plano para impedir que um tenant degrade todo o serviço.

### Operação e monitoramento

- Liveness verifica se processo vive; readiness verifica dependências necessárias ao serviço.
- Health separado para Postgres, Redis, storage, FFmpeg e worker. Não divulgar host/credenciais publicamente.
- Logs JSON com níveis apropriados e redaction de segredos/PII.
- Métricas: jobs pendentes/falhos, tempo de processamento, players online/offline, falhas de reprodução, latência API, erros de upload e divergência de heartbeat.
- Alertas operacionais para fila parada, worker ausente, storage indisponível, aumento de falhas e backup sem sucesso.
- Runbooks: restaurar banco, rodar migrations, reprocessar mídia, revogar player comprometido e investigar webhook recusado.

---

## 13. Estratégia de testes — nenhuma fase está pronta só porque compila

### 13.1 Testes unitários

- Máquinas de estado de anúncio, campanha, dispositivo e assinatura.
- Regras de prioridade/rotação, intervalo entre anúncios, vigência e exceções de agenda.
- Timezone, transições de horário de verão e limites de campanhas.
- Entitlements/limites por plano, quotas e uso idempotente.
- Guardas RBAC e escopo por organização/loja.
- Validação de inputs e schemas de adapters de IA/gateway.
- Cálculo de duração estimada e validação de metadata.

### 13.2 Testes de integração

- Banco PostgreSQL real ou containerizado; migrations do zero e atualização entre versões.
- Redis/BullMQ: retry, job duplicado, falha permanente e reprocessamento.
- Storage: upload, arquivo inválido, checksum, arquivo inexistente e URL expirada.
- FFmpeg: áudio válido, corrupto, duração zero, codec/formato inesperado, normalização falha e timeout.
- Player API: pairing vencido/usado, token inválido, dispositivo revogado, manifesto escopado e replay de eventos.
- Eventos de reprodução duplicados/desordenados e atraso offline.
- Webhook falso/assinatura inválida não produz efeitos; evento válido repetido produz apenas uma transição.
- Adapter de IA: schema inválido, timeout, provider ausente, saída vazia, retry e uso cobrado uma vez.

### 13.3 Testes E2E essenciais

1. Registrar usuário → criar organização → entrar no dashboard.
2. Criar loja + zona → criar anúncio manual → carregar áudio → criar playlist → agendar → publicar.
3. Parear player → clicar para iniciar áudio → reproduzir playlist → registrar evento → ver relatório.
4. Desligar rede depois do pre-cache → continuar com os arquivos disponíveis → reconectar → enviar eventos pendentes sem duplicar contagem.
5. Campanha expira → deixa de entrar no manifesto → continua disponível no histórico.
6. Editor sem permissão tenta aprovar; usuário de uma organização tenta acessar ID de outra; ambos recebem negação segura.
7. Superadmin acessa área de operação e sua ação fica auditada; usuário comum recebe 403/404 conforme política.
8. Sem credenciais de IA: geração mostra indisponibilidade e criação manual funciona.
9. Sem gateway: checkout é bloqueado com mensagem acionável; assinatura de teste/demonstração não é confundida com cobrança real.
10. CSV respeita filtros, limites, permissões e escape de células perigosas.
11. Recuperação de senha usa token expirável e de uso único; rate limiting e anti-enumeração funcionam.
12. Acessibilidade crítica: navegação de teclado, foco visível, rótulos, contraste e estado de loading/erro.

### 13.4 Segurança e confiabilidade

- Testes de IDOR/BOLA em todos os recursos por ID.
- Upload com extensão falsa, MIME incompatível, arquivo excessivo e tentativa de path traversal.
- Rate limit em auth, pairing, upload, geração e endpoints device.
- XSS em texto de anúncio/nome de playlist; SQL injection mitigada pelo ORM/validação.
- Duplo clique e retries concorrentes de publicação/cancelamento.
- Teste de carga básico: manifesto/player heartbeat e listagem paginada; registrar baseline sem inventar SLA.
- Backup e restauração verificados em ambiente isolado.

### 13.5 Portas de qualidade por fase

Uma fase só pode ser marcada como concluída quando:

- lint passa;
- typecheck passa;
- testes relevantes passam;
- build de produção passa;
- migration é reversível ou tem plano de recuperação documentado;
- fluxos manuais de aceite são executados;
- não há segredo no diff;
- documentação e `.env.example` estão atualizados;
- o agente informa comandos executados, resultados e qualquer limitação real.

Não declarar “todos os testes passam” se não foram executados. Não usar mocks como evidência de integração real.

---

## 14. Roadmap de implementação por fases

As fases devem ser executadas nesta ordem. Em um repositório real, o agente primeiro mapeia o que já existe e marca cada item como **existente e validado**, **existente com defeito**, **parcial**, **ausente** ou **fora do escopo**; não duplica funcionalidades.

### Fase 0 — Reconhecimento e plano de risco

- Auditar arquivos, stack, comandos, migrations, páginas, rotas, testes, autenticação, estado do banco, storage e workers.
- Executar os testes atuais antes de editar; registrar baseline de falhas.
- Criar mapa de dependências, riscos e decisões arquiteturais (ADRs curtos).
- Gerar inventário de requisitos, gaps e plano de execução sem apagar nem reescrever partes saudáveis.

**Porta:** baseline reproduzível e plano baseado no código real.

### Fase 1 — Fundação de desenvolvimento e qualidade

- Configuração/env validation, logging, request ID, error handling, health endpoints, Docker Compose para Postgres/Redis/MinIO.
- CI com lint, typecheck, testes e build; seed somente para ambiente local/teste.
- Documentação de setup e restore.

**Porta:** subir do zero seguindo README e comprovar migrations.

### Fase 2 — Identidade, organizações e isolamento multi-tenant

- Auth segura, organizações, membership, RBAC, recuperação de conta, convites internos.
- Guardas de organização/loja e testes negativos de isolamento.
- Layouts e rotas separadas para cliente e Jumpers.

**Porta:** testes cross-tenant falham de forma segura.

### Fase 3 — Lojas, zonas e dispositivos

- CRUD/arquivamento de lojas e zonas; timezone; códigos de pairing; token de dispositivo; heartbeat; revogação; status do player.
- UI de operação de players, feedback de último contato e erros.

**Porta:** pairing de ponta a ponta, expiração e revogação testadas.

### Fase 4 — Biblioteca de mídia e anúncios manuais

- Upload, storage privado, validação de conteúdo, FFprobe/FFmpeg, duração, normalização e estado de processamento.
- CRUD de anúncios, versões, modelos manuais, fluxo de aprovação e prévia de áudio enviado.
- Mensagens para provider de IA indisponível, sem bloquear o resto.

**Porta:** mídia inválida não vira “pronta”; anúncio manual percorre o fluxo completo.

### Fase 5 — Playlists e motor de programação

- Tipos de itens, ordem, regras de rotação, repetição, janelas, prioridade, exceções e elegibilidade de campanha.
- Resolução de agenda por timezone e store/zone, sem duas regras incompatíveis selecionadas arbitrariamente.
- Visualização de calendário e editor de playlist acessível.

**Porta:** testes de calendário, DST, prioridade e expiração passam.

### Fase 6 — Player CastWave PWA

- Pairing no player, tela de início por gesto do usuário, manifesto, playback, pre-cache, reconexão, buffer de eventos, heartbeat e diagnóstico.
- Testar Chrome/Edge desktop em modos normal/kiosk quando disponível e documentar o que navegador não garante.
- Não comunicar continuidade offline se não houver recursos no cache.

**Porta:** playlist e anúncio reproduzem com eventos; teste de desconexão/reconexão passa.

### Fase 7 — Campanhas, relatórios e exportações

- Campanhas com validade, atribuição de lojas, frequência e prioridade.
- Métricas brutas idempotentes + agregações reconstruíveis; dashboard, filtros, CSV seguro.
- Indicar período, fuso, zona e o que a métrica significa.

**Porta:** relatório confere com os eventos de teste e não duplica eventos repetidos.

### Fase 8 — Plano, limites e consumo sem gateway

- Plans/entitlements configuráveis, trial e assinatura state machine; ledger de uso; limites de lojas, players, campanhas/áudio conforme plano.
- UI de uso e estado de cobrança “não conectado”; concessão administrativa auditada para teste.
- Proteger contra abuso de recursos mesmo enquanto o gateway está ausente.

**Porta:** limites aplicados server-side e mudanças de plano auditadas.

### Fase 9 — Contratos de IA prontos, sem chamada real

- Definir adapters separados para roteiro e TTS, schemas, budget guard, timeouts, retries e registro de uso.
- Fluxo de prévia/edição/aprovação e estados de geração. Provider ausente é condição explícita.
- Testes de contrato com mocks somente em test/development.

**Porta:** usuário pode usar o produto sem IA; integração fica isolada para adicionar chaves e adapters reais depois.

### Fase 10 — Contrato do gateway pronto, sem cobrar de verdade

- Adapter `PaymentProvider`, estado da assinatura, checkout, webhook receiver, verificação de assinatura, idempotência, reconciliação e logs.
- UI de assinatura/planos e erros seguros quando desabilitado.
- Proibir provider fake em produção via guard/validação.

**Porta:** nenhum evento sem assinatura válida altera o estado; nenhum checkout reporta sucesso sem provider real.

### Fase 11 — Painel Jumpers, auditoria e suporte

- Organizações, saúde dos workers, jobs falhos, players com erro, eventos operacionais e ferramenta de suporte com escopo mínimo.
- Auditoria para todas as ações sensíveis; busca/filtros/paginação; proteção adicional do superadmin.

**Porta:** nenhum cliente alcança rotas/admin data; ações administrativas ficam rastreáveis.

### Fase 12 — Hardening, acessibilidade, carga e recuperação

- Revisão de segurança, headers, limites, uploads, retenção, acessibilidade, performance de listagens e player.
- Backup/restauração; teste de restore; runbooks de incidente e de reprocessamento.
- E2E de ponta a ponta, carga básica, análise das dependências e atualização de documentação.

**Porta:** checklist de release documentado, defeitos críticos zerados e falhas restantes declaradas.

### Fase 13 — Preparação para conectar IA e gateway

- Checklist de secrets, ambientes, allowlist de webhook, URLs públicas, timeouts, limites de custo, alertas, sandbox e rollback.
- Validar uma geração real controlada e um pagamento sandbox só após o usuário configurar credenciais e selecionar fornecedores.
- Não inventar credenciais nem executar cobranças reais sem autorização.

**Porta:** só depois disso declarar que as integrações externas estão realmente ativas.

---

## 15. Critérios gerais de aceite do produto

O MVP só está pronto para homologação quando alguém consegue, de forma demonstrável:

- Criar uma conta/organização e convidar alguém com permissão limitada.
- Cadastrar duas lojas com fusos/horários diferentes.
- Carregar música/locução que tenha direito de uso, criar um anúncio manual, editar e aprovar.
- Montar playlist, inserir spots, agendar uma campanha e confirmar a expiração.
- Parear player a uma loja/zona, iniciar playback por ação humana, verificar status e revogar dispositivo.
- Continuar com itens já baixados durante uma perda temporária de rede, quando a plataforma permitir, e sincronizar eventos ao reconectar.
- Consultar relatórios consistentes e exportar somente dados autorizados.
- Ver limites/uso do plano sem cobrança conectada.
- Usar toda a operação principal sem IA nem gateway configurados.
- Ver as integrações ausentes claramente identificadas, sem chamadas secretas, falsas confirmações ou estados enganosos.
- Confirmar que todos os testes de isolamento, autorização, upload, agenda, player, webhooks e migrations foram executados e aprovados.

---

## 16. Riscos que precisam ser tratados conscientemente

- **Autoplay e estabilidade do navegador:** a primeira reprodução pode exigir interação, e o navegador pode suspender páginas. Mitigar com gesto inicial, modo kiosk documentado, pré-cache, health monitorado e possível wrapper nativo no futuro.
- **Direitos musicais:** o lojista é responsável pelo licenciamento de trilhas que enviar; comunicar isso no upload e nos termos. Não distribuir músicas protegidas sem licença.
- **Qualidade de áudio:** validação/normalização ajuda, mas hardware da loja e volume físico variam. Oferecer teste de áudio e volume por player; não prometer nível acústico uniforme.
- **Fuso/horário de verão:** manter timezone IANA por loja e testes explícitos.
- **Duplicidade de eventos:** dispositivos repetem requests após reconexão; IDs idempotentes são obrigatórios.
- **Custos de IA:** quotas, duração máxima, preview, consentimento do usuário, orçamento e controle de retries precisam existir antes de ligar providers reais.
- **Pagamentos:** webhooks atrasam, duplicam e podem vir fora de ordem; máquina de estado e reconciliação protegem a assinatura.
- **Escopo amplo:** não implementar editor multifaixa ou automações sofisticadas antes do fluxo principal funcionar de ponta a ponta.

---

## 17. O que significa “pronto para ligar a IA e o gateway”

Ao terminar as fases 0–12, espera-se que:

- O produto principal opere com conteúdo manual e uploads reais.
- O áudio rode através do player com status e eventos reais.
- Os dados de planos/assinaturas/uso existam sem cobrar.
- A interface `AnnouncementCopyProvider` gere roteiro quando um provider real for conectado; `SpeechSynthesisProvider` transforme roteiro em áudio quando o TTS real for conectado.
- A interface `PaymentProvider` crie checkout e processe webhooks quando o gateway for selecionado/conectado.
- A ativação consista em configurar secrets/URLs, implementar ou finalizar os adapters específicos, rodar testes sandbox e aplicar o checklist de produção — **não em reconstruir todo o produto**.

Ainda será necessário configurar domínio/TLS, storage/backup de produção e credenciais seguras. Isso é configuração operacional, não desculpa para deixar funcionalidades centrais como placeholders.

---

## 18. Instrução final para o agente implementador

Use este documento como contrato funcional e arquitetural, mas obedeça ao estado real do repositório. Primeiro audite. Depois faça mudanças pequenas, rastreáveis e testadas, fase por fase. Priorize integração vertical (banco → domínio → API → UI → teste) em vez de criar dezenas de telas estáticas. Nenhuma tela pode ser apenas decoração: botões precisam executar ação real ou estar desabilitados com explicação honesta. Não remover comportamento existente sem razão e sem verificar regressões. Ao concluir cada fase, entregue resumo do que mudou, arquivos principais, comandos executados, resultado dos testes, gaps restantes e próxima fase.

**Objetivo de lançamento:** CastWave é uma central de sonorização comercial utilizável antes da IA e do gateway; essas integrações serão a cereja do bolo, não o alicerce da casa.
