export const id = '0005_playback_analytics';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Eventos de reproducao e agregacoes.
--
-- playback_events e o ledger bruto: imutavel e a unica fonte de verdade.
-- analytics_daily e cache derivado, sempre reconstruivel a partir dele --
-- se a agregacao divergir, truncamos e recalculamos, sem perder historico.
-- ---------------------------------------------------------------------------

create table playback_events (
  -- PK e o event_id gerado pelo PLAYER, nao pelo servidor. E isso que torna o
  -- reenvio apos reconexao naturalmente idempotente: a segunda insercao viola
  -- a chave primaria e vira "duplicado aceito", nunca uma contagem a mais.
  event_id              uuid primary key,
  organization_id       uuid        not null references organizations(id) on delete cascade,
  store_id              uuid        not null,
  zone_id               uuid        not null,
  device_id             uuid        not null,
  slot_id               text        not null,
  media_asset_id        uuid,
  announcement_id       uuid,
  campaign_id           uuid,
  item_type             text        not null check (item_type in ('music','promo_spot','operational_notice','jingle')),
  event_type            text        not null check (event_type in ('started','completed','failed','skipped')),
  -- Relogio do dispositivo: pode estar errado, pode chegar fora de ordem.
  occurred_at_device    timestamptz not null,
  -- Relogio do servidor: e com este que medimos atraso e latencia de sincronia.
  received_at_server    timestamptz not null default now(),
  played_ms             integer     not null default 0 check (played_ms >= 0),
  error_code            text,
  -- Data LOCAL da loja no momento do evento, calculada no servidor com o fuso
  -- da loja. Desnormalizada de proposito: e a chave de agregacao de todo
  -- relatorio, e recalcula-la a cada consulta seria caro e sujeito a drift.
  local_date            date        not null,
  created_at            timestamptz not null default now(),
  foreign key (store_id, organization_id)        references stores         (id, organization_id) on delete cascade,
  foreign key (zone_id, organization_id)         references audio_zones    (id, organization_id) on delete cascade,
  foreign key (device_id, organization_id)       references player_devices (id, organization_id) on delete cascade,
  foreign key (media_asset_id, organization_id)  references media_assets   (id, organization_id) on delete set null,
  foreign key (announcement_id, organization_id) references announcements  (id, organization_id) on delete set null,
  foreign key (campaign_id, organization_id)     references campaigns      (id, organization_id) on delete set null,
  check (event_type <> 'failed' or error_code is not null)
);
create index playback_events_org_date_idx on playback_events (organization_id, local_date desc);
create index playback_events_store_date_idx on playback_events (store_id, local_date desc);
create index playback_events_device_idx on playback_events (device_id, occurred_at_device desc);
create index playback_events_campaign_idx on playback_events (campaign_id, local_date) where campaign_id is not null;
create index playback_events_announcement_idx on playback_events (announcement_id, local_date) where announcement_id is not null;
-- Fila do rollup: eventos ainda nao agregados.
create index playback_events_rollup_idx on playback_events (organization_id, received_at_server);

create table analytics_daily (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid        not null references organizations(id) on delete cascade,
  local_date       date        not null,
  store_id         uuid        not null,
  announcement_id  uuid,
  campaign_id      uuid,
  item_type        text        not null,
  started_count    integer     not null default 0 check (started_count >= 0),
  completed_count  integer     not null default 0 check (completed_count >= 0),
  failed_count     integer     not null default 0 check (failed_count >= 0),
  skipped_count    integer     not null default 0 check (skipped_count >= 0),
  total_played_ms  bigint      not null default 0 check (total_played_ms >= 0),
  computed_at      timestamptz not null default now(),
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade
);
-- coalesce porque NULL nao participa de UNIQUE: sem isso teriamos linhas
-- duplicadas para musica (sem anuncio e sem campanha).
create unique index analytics_daily_grain_key on analytics_daily (
  organization_id, local_date, store_id, item_type,
  coalesce(announcement_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(campaign_id,     '00000000-0000-0000-0000-000000000000'::uuid)
);
create index analytics_daily_org_date_idx on analytics_daily (organization_id, local_date desc);

-- Heartbeats mantidos por janela curta: alimentam o grafico de disponibilidade
-- e sao podados pelo job de retencao. Nao sao historico contabil.
create table device_heartbeats (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations(id) on delete cascade,
  device_id       uuid        not null,
  received_at     timestamptz not null default now(),
  online          boolean     not null default true,
  buffer_depth    integer,
  cached_items    integer,
  pending_events  integer,
  app_version     text,
  error_code      text,
  foreign key (device_id, organization_id) references player_devices (id, organization_id) on delete cascade
);
create index device_heartbeats_device_time_idx on device_heartbeats (device_id, received_at desc);
create index device_heartbeats_retention_idx on device_heartbeats (received_at);
`;
