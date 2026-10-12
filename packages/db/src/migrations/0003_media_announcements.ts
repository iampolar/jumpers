export const id = '0003_media_announcements';

export const sql = /* sql */ `
-- ---------------------------------------------------------------------------
-- Biblioteca de audio e anuncios versionados.
-- ---------------------------------------------------------------------------

create table media_assets (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid        not null references organizations(id) on delete cascade,
  kind               text        not null check (kind in ('music','voice_over','jingle','operational_notice')),
  title              text        not null check (length(title) between 1 and 200),
  -- Nome saneado na entrada; guardado so para exibicao e download.
  original_filename  text        not null,
  -- Chave no storage de objetos. O binario nunca mora no Postgres.
  storage_key        text,
  -- MIME detectado por magic bytes, nao o que o cliente declarou.
  mime_type          text,
  size_bytes         bigint      not null default 0 check (size_bytes >= 0),
  duration_ms        integer     check (duration_ms is null or duration_ms >= 0),
  checksum_sha256    text,
  sample_rate        integer     check (sample_rate is null or sample_rate > 0),
  channels           smallint    check (channels is null or channels > 0),
  bitrate_kbps       integer     check (bitrate_kbps is null or bitrate_kbps > 0),
  loudness_lufs      numeric(5,2),
  probed_by          text,
  status             text        not null default 'uploading'
                       check (status in ('uploading','processing','ready','failed','archived')),
  processing_error   text,
  -- Declaracao de direitos de execucao: obrigatoria no upload (blueprint 16).
  rights_attested_at timestamptz,
  rights_attested_by uuid references users(id) on delete set null,
  uploaded_by        uuid references users(id) on delete set null,
  upload_token_hash  text,
  upload_expires_at  timestamptz,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, organization_id),
  -- Nada vira 'ready' sem duracao e checksum medidos de verdade.
  check (status <> 'ready' or (duration_ms is not null and checksum_sha256 is not null and storage_key is not null))
);
create index media_assets_org_status_idx on media_assets (organization_id, status, created_at desc);
create index media_assets_org_kind_idx on media_assets (organization_id, kind) where status = 'ready';
-- Deduplica upload do mesmo arquivo dentro da organizacao.
create unique index media_assets_org_checksum_key on media_assets (organization_id, checksum_sha256)
  where checksum_sha256 is not null and status <> 'archived';

create table announcements (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid        not null references organizations(id) on delete cascade,
  title              text        not null check (length(title) between 1 and 200),
  type               text        not null default 'promo_spot'
                       check (type in ('promo_spot','operational_notice','jingle','institutional')),
  status             text        not null default 'draft'
                       check (status in ('draft','pending_approval','approved','scheduled','active',
                                         'paused','rejected','cancelled','expired','completed','failed')),
  current_version_id uuid,
  valid_from         timestamptz,
  valid_until        timestamptz,
  created_by         uuid references users(id) on delete set null,
  approved_by        uuid references users(id) on delete set null,
  approved_at        timestamptz,
  rejection_reason   text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, organization_id),
  check (valid_until is null or valid_from is null or valid_until > valid_from)
);
create index announcements_org_status_idx on announcements (organization_id, status, updated_at desc);
create index announcements_validity_idx on announcements (organization_id, valid_from, valid_until)
  where status in ('scheduled','active');

-- Versao e imutavel apos criada: publicar gera snapshot auditavel.
create table announcement_versions (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid        not null references organizations(id) on delete cascade,
  announcement_id           uuid        not null,
  version_number            integer     not null check (version_number > 0),
  script_text               text        not null check (length(script_text) between 1 and 1200),
  locale                    text        not null default 'pt-BR',
  pronunciation_dictionary  jsonb       not null default '[]'::jsonb,
  media_asset_id            uuid,
  estimated_duration_ms     integer     not null default 0 check (estimated_duration_ms >= 0),
  -- SHA-256 de (texto + dicionario + audio). Prova de integridade na auditoria.
  content_hash              text        not null,
  source                    text        not null default 'manual' check (source in ('manual','template','ai_copy')),
  created_by                uuid references users(id) on delete set null,
  created_at                timestamptz not null default now(),
  unique (id, organization_id),
  unique (announcement_id, version_number),
  foreign key (announcement_id, organization_id) references announcements (id, organization_id) on delete cascade,
  foreign key (media_asset_id, organization_id) references media_assets (id, organization_id) on delete restrict
);
create index announcement_versions_announcement_idx on announcement_versions (announcement_id, version_number desc);

alter table announcements
  add constraint announcements_current_version_fk
  foreign key (current_version_id, organization_id)
  references announcement_versions (id, organization_id) on delete set null;

-- Alvo do anuncio. Sem linhas = todas as lojas da organizacao.
create table announcement_stores (
  announcement_id uuid not null,
  store_id        uuid not null,
  organization_id uuid not null references organizations(id) on delete cascade,
  primary key (announcement_id, store_id),
  foreign key (announcement_id, organization_id) references announcements (id, organization_id) on delete cascade,
  foreign key (store_id, organization_id) references stores (id, organization_id) on delete cascade
);
create index announcement_stores_store_idx on announcement_stores (store_id);
`;
