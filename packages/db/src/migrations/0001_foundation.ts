export const id = '0001_foundation';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Fundacao: identidade, organizacao, sessao, auditoria e notificacoes.
--
-- Convencoes do schema, validas em todas as migrations:
--  * chave primaria uuid com gen_random_uuid() (pgcrypto embutido no PG 13+);
--  * enums como text + CHECK, nao tipos ENUM: adicionar um valor vira um ALTER
--    de constraint reversivel, enquanto ALTER TYPE ... ADD VALUE nao roda em
--    transacao e nao tem rollback (ver docs/adr/0003);
--  * timestamptz sempre, nunca timestamp: o produto e multi-fuso;
--  * organization_id em toda tabela de negocio;
--  * UNIQUE (id, organization_id) nas tabelas raiz, para que as filhas possam
--    referenciar o par composto e o banco torne impossivel associar recursos
--    de organizacoes diferentes -- mesmo que uma query esqueca o WHERE.
-- ---------------------------------------------------------------------------

create table users (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null check (length(name) between 1 and 160),
  -- E-mail ja chega normalizado (trim + lowercase) da camada de contrato.
  email           text        not null,
  password_hash   text        not null,
  status          text        not null default 'active' check (status in ('active','suspended')),
  platform_role   text        not null default 'none'   check (platform_role in ('none','support','superadmin')),
  mfa_secret      text,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index users_email_key on users (email);
create index users_platform_role_idx on users (platform_role) where platform_role <> 'none';

create table organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null check (length(name) between 1 and 160),
  slug              text        not null,
  timezone          text        not null default 'America/Sao_Paulo',
  status            text        not null default 'active' check (status in ('active','suspended','archived')),
  requires_approval boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index organizations_slug_key on organizations (slug);

create table organization_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  user_id         uuid        not null references users(id) on delete cascade,
  role            text        not null check (role in ('owner','admin','content_editor','store_operator','viewer_finance')),
  status          text        not null default 'active' check (status in ('invited','active','suspended')),
  invited_by      uuid references users(id) on delete set null,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_memberships_user_idx on organization_memberships (user_id);

-- Sessao com token apenas em hash: um dump do banco nao permite se passar por
-- ninguem. rotated_from encadeia a rotacao e permite detectar reuso de token
-- antigo, sinal classico de roubo de sessao.
create table sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid        not null references users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  token_hash      text        not null,
  csrf_secret     text        not null,
  user_agent      text,
  ip_prefix       text,
  rotated_from    uuid references sessions(id) on delete set null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create unique index sessions_token_hash_key on sessions (token_hash);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;
create index sessions_expiry_idx on sessions (expires_at);

create table password_reset_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  token_hash text        not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index password_reset_tokens_hash_key on password_reset_tokens (token_hash);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id);

-- Trilha append-only. Sem UPDATE e sem DELETE no codigo da aplicacao; o
-- usuario do banco em producao recebe apenas INSERT e SELECT nesta tabela
-- (ver infra/docker/init-roles.sql).
create table audit_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  actor_type      text        not null check (actor_type in ('user','device','system','platform')),
  actor_id        uuid,
  actor_label     text,
  action          text        not null,
  resource_type   text        not null,
  resource_id     text,
  outcome         text        not null default 'success' check (outcome in ('success','denied','error')),
  reason          text,
  request_id      text,
  -- IP truncado em /24 (IPv4) e /48 (IPv6) antes de chegar aqui.
  ip_prefix       text,
  user_agent      text,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index audit_logs_org_created_idx on audit_logs (organization_id, created_at desc);
create index audit_logs_resource_idx on audit_logs (resource_type, resource_id);
create index audit_logs_action_idx on audit_logs (action, created_at desc);

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  -- null = notificacao da organizacao inteira, visivel a quem tem permissao.
  user_id         uuid references users(id) on delete cascade,
  severity        text        not null default 'info' check (severity in ('info','success','warning','critical')),
  title           text        not null,
  body            text        not null,
  href            text,
  -- Deduplica avisos repetidos do mesmo problema (ex.: player offline).
  dedupe_key      text,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index notifications_org_created_idx on notifications (organization_id, created_at desc);
create index notifications_unread_idx on notifications (organization_id, user_id) where read_at is null;
create unique index notifications_dedupe_key on notifications (organization_id, dedupe_key) where dedupe_key is not null and read_at is null;
`;
