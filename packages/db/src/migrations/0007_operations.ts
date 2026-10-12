export const id = '0007_operations';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Filas, outbox, idempotencia e suporte.
--
-- A fila mora no Postgres. Nao e falta de ambicao: com SKIP LOCKED o Postgres
-- entrega uma fila transacional, auditavel e consistente com o dado de
-- negocio -- o job e enfileirado no MESMO commit que criou o recurso, o que
-- torna impossivel o classico "gravou no banco mas o job se perdeu". O driver
-- BullMQ/Redis entra por configuracao quando o volume justificar, atras da
-- mesma porta JobQueuePort (ver docs/adr/0005).
-- ---------------------------------------------------------------------------

create table jobs (
  id              uuid primary key default gen_random_uuid(),
  queue           text        not null check (queue in ('media-process','announcement-ai','schedule-publish',
                                                        'analytics-rollup','notification-delivery','billing-events')),
  payload         jsonb       not null,
  status          text        not null default 'pending'
                    check (status in ('pending','running','completed','failed','dead')),
  organization_id uuid references organizations(id) on delete cascade,
  attempts        smallint    not null default 0,
  max_attempts    smallint    not null default 5,
  -- Mesma chave = mesmo trabalho. Reenfileirar nao duplica efeito.
  idempotency_key text,
  run_at          timestamptz not null default now(),
  -- Lease: um worker que morre sem finalizar devolve o job apos o vencimento.
  locked_at       timestamptz,
  locked_by       text,
  lock_expires_at timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer,
  last_error      text,
  created_at      timestamptz not null default now()
);
-- Indice parcial que serve exatamente a query de "pegar o proximo job".
create index jobs_ready_idx on jobs (queue, run_at) where status = 'pending';
create index jobs_stuck_idx on jobs (lock_expires_at) where status = 'running';
create index jobs_org_idx on jobs (organization_id, created_at desc);
create index jobs_failed_idx on jobs (queue, finished_at desc) where status in ('failed','dead');
create unique index jobs_idempotency_key on jobs (queue, idempotency_key)
  where idempotency_key is not null and status in ('pending','running');

-- Transactional outbox: o evento e gravado no mesmo commit do dado e so
-- depois vira job. Elimina a janela em que o banco mudou e a fila nao soube.
create table outbox_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  event_type      text        not null,
  payload         jsonb       not null,
  published_at    timestamptz,
  attempts        smallint    not null default 0,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index outbox_events_pending_idx on outbox_events (created_at) where published_at is null;

-- Idempotencia de requisicoes HTTP mutaveis. Guarda o hash do corpo para
-- detectar reuso da mesma chave com payload diferente (409, nao resposta
-- antiga silenciosa).
create table idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  scope           text        not null,
  key             text        not null,
  request_hash    text        not null,
  status          text        not null default 'in_progress' check (status in ('in_progress','completed','failed')),
  response_status smallint,
  response_body   jsonb,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (organization_id, scope, key)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

create table support_tickets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  subject         text        not null,
  status          text        not null default 'open' check (status in ('open','pending','resolved','closed')),
  priority        text        not null default 'normal' check (priority in ('low','normal','high')),
  -- Snapshot tecnico anexado automaticamente. Sem dado do cliente final.
  diagnostics     jsonb       not null default '{}'::jsonb,
  created_by      uuid references users(id) on delete set null,
  assigned_to     uuid references users(id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create index support_tickets_org_status_idx on support_tickets (organization_id, status, created_at desc);
create index support_tickets_queue_idx on support_tickets (status, priority, created_at) where status in ('open','pending');

create table support_messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  ticket_id       uuid        not null,
  author_id       uuid references users(id) on delete set null,
  -- 'jumpers' marca resposta da operacao; muda o lado da bolha na UI.
  author_side     text        not null check (author_side in ('customer','jumpers')),
  body            text        not null,
  created_at      timestamptz not null default now(),
  foreign key (ticket_id, organization_id) references support_tickets (id, organization_id) on delete cascade
);
create index support_messages_ticket_idx on support_messages (ticket_id, created_at);
`;
