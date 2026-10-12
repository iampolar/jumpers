export const id = '0002_stores_devices';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Lojas, zonas de audio e players.
--
-- A FK composta (x_id, organization_id) e o coracao do isolamento: nao existe
-- forma de apontar uma zona da organizacao A para uma loja da organizacao B,
-- nem por bug de aplicacao, nem por script manual, nem por migracao futura.
-- ---------------------------------------------------------------------------

create table stores (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  name            text        not null check (length(name) between 1 and 160),
  slug            text        not null,
  -- Fuso IANA, validado contra a base do ICU na camada de contrato.
  timezone        text        not null,
  city            text,
  state           char(2),
  -- [{weekday, opensAt, closesAt, closed}]. Validado por Zod antes do insert.
  opening_hours   jsonb       not null default '[]'::jsonb,
  status          text        not null default 'active' check (status in ('active','paused','archived')),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index stores_org_slug_key on stores (organization_id, slug);
create index stores_org_status_idx on stores (organization_id, status);

create table audio_zones (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  store_id        uuid        not null,
  name            text        not null check (length(name) between 1 and 80),
  default_volume  smallint    not null default 80 check (default_volume between 0 and 100),
  status          text        not null default 'active' check (status in ('active','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade
);
create unique index audio_zones_store_name_key on audio_zones (store_id, lower(name)) where status = 'active';
create index audio_zones_org_idx on audio_zones (organization_id, store_id);

-- Escopo por loja de um usuario. Linha ausente = acesso a todas as lojas
-- (decidido pelo papel); linha presente = restricao explicita.
create table store_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  store_id        uuid not null,
  created_at      timestamptz not null default now(),
  unique (user_id, store_id),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade
);
create index store_memberships_org_user_idx on store_memberships (organization_id, user_id);

-- Codigo de pareamento: uso unico, TTL curto, guardado apenas como hash.
-- O codigo em claro existe por alguns minutos, so na tela de quem o gerou.
create table device_pairing_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  store_id        uuid        not null,
  zone_id         uuid        not null,
  code_hash       text        not null,
  device_name     text        not null,
  requested_by    uuid references users(id) on delete set null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  used_by_device  uuid,
  created_at      timestamptz not null default now(),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade,
  foreign key (zone_id, organization_id) references audio_zones (id, organization_id) on delete cascade,
  check (expires_at > created_at)
);
-- Unicidade apenas enquanto o codigo esta vivo: codigos antigos podem repetir
-- o hash sem colidir, e o indice parcial fica pequeno.
create unique index device_pairing_codes_active_key on device_pairing_codes (code_hash) where used_at is null;
create index device_pairing_codes_expiry_idx on device_pairing_codes (expires_at) where used_at is null;

create table player_devices (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid        not null references organizations(id) on delete cascade,
  store_id          uuid        not null,
  zone_id           uuid        not null,
  name              text        not null check (length(name) between 1 and 80),
  -- SHA-256 do token do dispositivo. O segredo e entregue uma unica vez.
  token_hash        text        not null,
  token_rotated_at  timestamptz,
  status            text        not null default 'pairing'
                      check (status in ('pairing','active','degraded','offline','revoked')),
  app_version       text,
  last_seen_at      timestamptz,
  last_manifest_rev text,
  last_error_code   text,
  last_error_at     timestamptz,
  current_item_label text,
  buffer_depth      integer,
  cached_items      integer,
  cached_bytes      bigint,
  pending_events    integer,
  paired_at         timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade,
  foreign key (zone_id, organization_id) references audio_zones (id, organization_id) on delete cascade,
  check (status <> 'revoked' or revoked_at is not null)
);
create unique index player_devices_token_hash_key on player_devices (token_hash);
create index player_devices_org_status_idx on player_devices (organization_id, status);
create index player_devices_store_idx on player_devices (store_id, status);
-- Varredura do job que marca players offline por falta de heartbeat.
create index player_devices_last_seen_idx on player_devices (last_seen_at)
  where status in ('active','degraded');
`;
