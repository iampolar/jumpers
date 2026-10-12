export const id = '0006_billing';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Planos, assinaturas, consumo e eventos de gateway.
--
-- Tudo aqui funciona com PAYMENTS_PROVIDER=disabled. O gateway, quando entrar,
-- preenche provider_* e alimenta payment_webhook_events -- nao substitui a
-- maquina de estados, que continua sendo a fonte de verdade do dominio.
-- ---------------------------------------------------------------------------

create table plans (
  id           uuid primary key default gen_random_uuid(),
  code         text        not null,
  name         text        not null,
  description  text,
  -- Preco SEMPRE do servidor. O browser nunca informa valor nem moeda.
  price_cents  integer     not null check (price_cents >= 0),
  currency     char(3)     not null default 'BRL',
  interval     text        not null default 'month' check (interval in ('month','year')),
  quotas       jsonb       not null,
  features     jsonb       not null default '[]'::jsonb,
  active       boolean     not null default true,
  sort_order   smallint    not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index plans_code_key on plans (code);

create table subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid        not null references organizations(id) on delete cascade,
  plan_id                  uuid        not null references plans(id) on delete restrict,
  status                   text        not null default 'trialing'
                             check (status in ('trialing','active','past_due','paused','cancelled','expired','incomplete')),
  current_period_start     timestamptz not null default now(),
  current_period_end       timestamptz not null,
  trial_ends_at            timestamptz,
  cancel_at_period_end     boolean     not null default false,
  -- 'disabled' enquanto nao houver gateway. Nunca inventamos um provedor.
  provider                 text        not null default 'disabled',
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
-- Uma assinatura viva por organizacao; historico fica nas canceladas.
create unique index subscriptions_active_org_key on subscriptions (organization_id)
  where status in ('trialing','active','past_due','paused','incomplete');
create index subscriptions_org_idx on subscriptions (organization_id, created_at desc);
create unique index subscriptions_provider_key on subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

-- Append-only. Cada linha tem idempotency_key para que um retry de job ou de
-- webhook nao cobre nem contabilize o mesmo consumo duas vezes.
create table usage_ledger (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  metric          text        not null check (metric in ('stores_active','devices_active','media_storage_bytes',
                                                         'ai_copy_generations','ai_tts_seconds','playback_events')),
  quantity        bigint      not null,
  period_start    timestamptz not null,
  source          text        not null,
  idempotency_key text        not null,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create unique index usage_ledger_idempotency_key on usage_ledger (organization_id, metric, idempotency_key);
create index usage_ledger_org_period_idx on usage_ledger (organization_id, metric, period_start desc);

create table checkout_sessions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid        not null references organizations(id) on delete cascade,
  plan_id             uuid        not null references plans(id) on delete restrict,
  provider            text        not null,
  provider_session_id text,
  status              text        not null default 'created'
                        check (status in ('created','redirected','completed','expired','failed','cancelled')),
  -- Valor congelado do catalogo no instante da criacao. Serve de conferencia
  -- contra o que o gateway reportar depois.
  price_cents         integer     not null check (price_cents >= 0),
  currency            char(3)     not null,
  idempotency_key     text        not null,
  expires_at          timestamptz not null,
  created_by          uuid references users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index checkout_sessions_idempotency_key on checkout_sessions (organization_id, idempotency_key);
create index checkout_sessions_org_idx on checkout_sessions (organization_id, created_at desc);

-- Todo evento recebido e gravado ANTES de qualquer efeito, com o resultado da
-- verificacao de assinatura. Evento invalido fica registrado como invalido --
-- nao desaparece, e nao produz efeito.
create table payment_webhook_events (
  id               uuid primary key default gen_random_uuid(),
  provider         text        not null,
  event_id         text        not null,
  event_type       text        not null,
  organization_id  uuid references organizations(id) on delete set null,
  signature_valid  boolean     not null,
  -- Payload ja minimizado pelo adapter. Nunca cartao, CVV ou PII supérflua.
  payload          jsonb       not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  processing_error text,
  attempts         smallint    not null default 0
);
-- Deduplicacao exigida pelo blueprint: (provider, event_id) e unico.
create unique index payment_webhook_events_provider_event_key on payment_webhook_events (provider, event_id);
create index payment_webhook_events_pending_idx on payment_webhook_events (received_at)
  where processed_at is null and signature_valid;
`;
