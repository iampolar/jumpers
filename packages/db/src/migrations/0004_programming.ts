export const id = '0004_programming';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Playlists, agenda e campanhas.
-- ---------------------------------------------------------------------------

create table playlists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  name            text        not null check (length(name) between 1 and 160),
  description     text,
  status          text        not null default 'draft' check (status in ('draft','active','archived')),
  -- Regras validadas por zRotationRules antes de gravar; o motor em
  -- @castwave/core/rotation e a unica coisa que as interpreta.
  rotation_rules  jsonb       not null default '{}'::jsonb,
  archived_at     timestamptz,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create index playlists_org_status_idx on playlists (organization_id, status, updated_at desc);

create table playlist_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid        not null references organizations(id) on delete cascade,
  playlist_id       uuid        not null,
  item_type         text        not null check (item_type in ('music','promo_spot','operational_notice','jingle')),
  sort_order        integer     not null default 0,
  media_asset_id    uuid,
  announcement_id   uuid,
  priority          smallint    not null default 0  check (priority between 0 and 100),
  weight            smallint    not null default 1  check (weight between 1 and 100),
  active_from       timestamptz,
  active_until      timestamptz,
  max_plays_per_day integer     check (max_plays_per_day is null or max_plays_per_day > 0),
  enabled           boolean     not null default true,
  created_at        timestamptz not null default now(),
  foreign key (playlist_id, organization_id) references playlists (id, organization_id) on delete cascade,
  foreign key (media_asset_id, organization_id) references media_assets (id, organization_id) on delete restrict,
  foreign key (announcement_id, organization_id) references announcements (id, organization_id) on delete cascade,
  -- Exatamente uma origem: ou um arquivo da biblioteca, ou um anuncio.
  check ((media_asset_id is null) <> (announcement_id is null)),
  check (item_type <> 'music' or media_asset_id is not null),
  check (active_until is null or active_from is null or active_until > active_from)
);
create index playlist_items_playlist_idx on playlist_items (playlist_id, sort_order);
create index playlist_items_announcement_idx on playlist_items (announcement_id) where announcement_id is not null;

create table schedules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid        not null references organizations(id) on delete cascade,
  store_id         uuid        not null,
  -- null = vale para todas as zonas da loja.
  zone_id          uuid,
  playlist_id      uuid        not null,
  name             text        not null check (length(name) between 1 and 160),
  -- 0 = domingo, igual a extract(dow) e a Date#getDay.
  weekdays         smallint[]  not null check (array_length(weekdays, 1) between 1 and 7),
  -- Hora LOCAL da loja. A conversao para UTC acontece no resolvedor, com o
  -- fuso IANA vigente naquele dia -- nunca com um offset fixo salvo aqui.
  start_local_time time        not null,
  end_local_time   time        not null,
  effective_from   date,
  effective_until  date,
  priority         smallint    not null default 0 check (priority between 0 and 100),
  enabled          boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (store_id, organization_id)    references stores      (id, organization_id) on delete cascade,
  foreign key (zone_id, organization_id)     references audio_zones (id, organization_id) on delete cascade,
  foreign key (playlist_id, organization_id) references playlists   (id, organization_id) on delete restrict,
  check (start_local_time <> end_local_time),
  check (effective_until is null or effective_from is null or effective_until >= effective_from)
);
create index schedules_store_idx on schedules (store_id, enabled);
create index schedules_org_idx on schedules (organization_id, enabled);

create table schedule_exceptions (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid        not null references organizations(id) on delete cascade,
  store_id              uuid        not null,
  -- Data LOCAL. Um feriado nao e um instante UTC: 21/04 em Manaus e em
  -- Noronha comecam com tres horas de diferenca e ambos sao "o dia 21".
  local_date            date        not null,
  kind                  text        not null check (kind in ('blackout','override_playlist','special_hours')),
  label                 text        not null,
  override_playlist_id  uuid,
  start_local_time      time,
  end_local_time        time,
  created_by            uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade,
  foreign key (override_playlist_id, organization_id) references playlists (id, organization_id) on delete cascade,
  check (kind <> 'override_playlist' or override_playlist_id is not null),
  check (kind <> 'special_hours' or (start_local_time is not null and end_local_time is not null))
);
create unique index schedule_exceptions_store_date_kind_key on schedule_exceptions (store_id, local_date, kind);
create index schedule_exceptions_date_idx on schedule_exceptions (organization_id, local_date);

create table campaigns (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid        not null references organizations(id) on delete cascade,
  name                       text        not null check (length(name) between 1 and 180),
  objective                  text,
  status                     text        not null default 'draft'
                               check (status in ('draft','scheduled','running','paused','finished','cancelled')),
  starts_at                  timestamptz not null,
  ends_at                    timestamptz not null,
  priority                   smallint    not null default 10 check (priority between 0 and 100),
  max_plays_per_day_per_store integer    check (max_plays_per_day_per_store is null or max_plays_per_day_per_store > 0),
  created_by                 uuid references users(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (id, organization_id),
  check (ends_at > starts_at)
);
create index campaigns_org_status_idx on campaigns (organization_id, status, starts_at desc);
-- Varredura do job que inicia e encerra campanhas na virada da vigencia.
create index campaigns_window_idx on campaigns (starts_at, ends_at) where status in ('scheduled','running');

create table campaign_stores (
  campaign_id     uuid not null,
  store_id        uuid not null,
  organization_id uuid not null references organizations(id) on delete cascade,
  primary key (campaign_id, store_id),
  foreign key (campaign_id, organization_id) references campaigns (id, organization_id) on delete cascade,
  foreign key (store_id, organization_id)    references stores    (id, organization_id) on delete cascade
);
create index campaign_stores_store_idx on campaign_stores (store_id);

create table campaign_announcements (
  campaign_id     uuid not null,
  announcement_id uuid not null,
  organization_id uuid not null references organizations(id) on delete cascade,
  priority        smallint not null default 10 check (priority between 0 and 100),
  primary key (campaign_id, announcement_id),
  foreign key (campaign_id, organization_id)     references campaigns     (id, organization_id) on delete cascade,
  foreign key (announcement_id, organization_id) references announcements (id, organization_id) on delete cascade
);
create index campaign_announcements_announcement_idx on campaign_announcements (announcement_id);
`;
