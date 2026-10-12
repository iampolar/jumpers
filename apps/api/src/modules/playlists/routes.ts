import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_ROTATION_RULES,
  DomainError,
  zAddPlaylistItemInput,
  zCreatePlaylistInput,
  zReorderItemsInput,
  zRotationRules,
  zUpdatePlaylistInput,
  type Playlist,
  type PlaylistItem,
} from '@castwave/contracts';
import { buildRotation, type RotationCandidate } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit';
import { authorize, created, noContent, type AppServices } from '../../http/context';
import { idOf, parseBody, parseParams, parseQuery } from '../../http/validate';

/**
 * Playlists.
 *
 * A playlist e uma *fonte* de itens; o que toca de fato e calculado pelo motor
 * de rotacao em `@castwave/core`. A rota `/preview` chama exatamente o mesmo
 * motor que o player vai usar -- a previa nao e uma segunda implementacao que
 * poderia divergir do resultado real.
 */

function mapItem(row: Record<string, unknown>): PlaylistItem {
  return {
    id: row.id as string,
    playlistId: row.playlist_id as string,
    itemType: row.item_type as PlaylistItem['itemType'],
    sortOrder: Number(row.sort_order),
    mediaAssetId: (row.media_asset_id as string | null) ?? null,
    announcementId: (row.announcement_id as string | null) ?? null,
    title: (row.title as string | null) ?? 'Sem titulo',
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    priority: Number(row.priority),
    weight: Number(row.weight),
    activeFrom: row.active_from ? new Date(row.active_from as string).toISOString() : null,
    activeUntil: row.active_until ? new Date(row.active_until as string).toISOString() : null,
    maxPlaysPerDay: row.max_plays_per_day === null ? null : Number(row.max_plays_per_day),
    enabled: Boolean(row.enabled),
  };
}

/**
 * Itens com titulo e duracao resolvidos.
 *
 * Para um spot, a duracao que vale e a do audio da versao ATUAL do anuncio --
 * nao a estimativa do texto. Se ainda nao houver audio, a duracao e nula e o
 * motor exclui o item com motivo, em vez de agendar silencio.
 */
const ITEM_SELECT = `
  select i.id, i.playlist_id, i.item_type, i.sort_order, i.media_asset_id, i.announcement_id,
         i.priority, i.weight, i.active_from, i.active_until, i.max_plays_per_day, i.enabled,
         coalesce(m.title, a.title)                as title,
         coalesce(m.duration_ms, vm.duration_ms)   as duration_ms,
         coalesce(m.id, vm.id)                     as resolved_media_id,
         coalesce(m.size_bytes, vm.size_bytes)     as size_bytes,
         coalesce(m.checksum_sha256, vm.checksum_sha256) as checksum,
         a.status                                  as announcement_status,
         a.valid_from                              as announcement_valid_from,
         a.valid_until                             as announcement_valid_until,
         v.id                                      as announcement_version_id
    from playlist_items i
    left join media_assets m          on m.id = i.media_asset_id
    left join announcements a         on a.id = i.announcement_id
    left join announcement_versions v on v.id = a.current_version_id
    left join media_assets vm         on vm.id = v.media_asset_id`;

async function loadPlaylist(
  services: AppServices,
  organizationId: string,
  playlistId: string,
): Promise<Playlist> {
  const { db } = services;
  const head = await db.query<Record<string, unknown>>(
    `select id, organization_id, name, description, status, rotation_rules, created_at, updated_at
       from playlists where id = $1 and organization_id = $2`,
    [playlistId, organizationId],
  );
  const p = head.rows[0];
  if (!p) throw new DomainError('not_found', 'Playlist nao encontrada.');

  const items = await db.query<Record<string, unknown>>(
    `${ITEM_SELECT} where i.playlist_id = $1 order by i.sort_order, i.id`,
    [playlistId],
  );
  const mapped = items.rows.map(mapItem);

  // Regras gravadas podem ser parciais (schema evoluiu); o parse completa com
  // os padroes em vez de deixar o motor receber `undefined`.
  const rules = zRotationRules.parse({ ...DEFAULT_ROTATION_RULES, ...(p.rotation_rules as object) });

  return {
    id: p.id as string,
    organizationId: p.organization_id as string,
    name: p.name as string,
    description: (p.description as string | null) ?? null,
    status: p.status as Playlist['status'],
    rotationRules: rules,
    items: mapped,
    musicCount: mapped.filter((i) => i.itemType === 'music').length,
    spotCount: mapped.filter((i) => i.itemType !== 'music').length,
    totalDurationMs: mapped.reduce((sum, i) => sum + (i.durationMs ?? 0), 0),
    createdAt: new Date(p.created_at as string).toISOString(),
    updatedAt: new Date(p.updated_at as string).toISOString(),
  };
}

/** Converte linhas do banco nos candidatos que o motor de rotacao entende. */
export function toRotationCandidates(
  rows: readonly Record<string, unknown>[],
  playsToday: ReadonlyMap<string, number> = new Map(),
): RotationCandidate[] {
  return rows.map((row) => ({
    id: row.id as string,
    itemType: row.item_type as RotationCandidate['itemType'],
    mediaAssetId: (row.resolved_media_id as string | null) ?? '',
    announcementId: (row.announcement_id as string | null) ?? null,
    announcementVersionId: (row.announcement_version_id as string | null) ?? null,
    campaignId: (row.campaign_id as string | null) ?? null,
    title: (row.title as string | null) ?? 'Sem titulo',
    durationMs: row.duration_ms ? Number(row.duration_ms) : 0,
    priority: Number(row.priority ?? 0),
    weight: Number(row.weight ?? 1),
    sortOrder: Number(row.sort_order ?? 0),
    activeFrom: row.active_from
      ? new Date(row.active_from as string)
      : row.announcement_valid_from
        ? new Date(row.announcement_valid_from as string)
        : null,
    activeUntil: row.active_until
      ? new Date(row.active_until as string)
      : row.announcement_valid_until
        ? new Date(row.announcement_valid_until as string)
        : null,
    maxPlaysPerDay: row.max_plays_per_day === null || row.max_plays_per_day === undefined ? null : Number(row.max_plays_per_day),
    playsToday: playsToday.get(row.id as string) ?? 0,
    /*
     * Um spot so e elegivel se o anuncio estiver publicado E tiver audio
     * pronto. Sem isso o player receberia um item sem arquivo e falharia na
     * loja, em vez de simplesmente nao tocar.
     */
    enabled:
      Boolean(row.enabled) &&
      Boolean(row.resolved_media_id) &&
      (row.announcement_id === null ||
        ['scheduled', 'active'].includes(row.announcement_status as string)),
    sizeBytes: Number(row.size_bytes ?? 0),
    checksumSha256: (row.checksum as string | null) ?? null,
    gain: 100,
  }));
}

export function registerPlaylistRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  server.get('/api/v1/playlists', async (req) => {
    const principal = authorize(req, 'playlists:read');
    const { rows } = await db.query<{ id: string }>(
      `select id from playlists
        where organization_id = $1 and status <> 'archived'
        order by updated_at desc limit 200`,
      [principal.organizationId],
    );
    const playlists = await Promise.all(
      rows.map((r) => loadPlaylist(services, principal.organizationId, r.id)),
    );
    return { playlists };
  });

  server.get('/api/v1/playlists/:id', async (req) => {
    const principal = authorize(req, 'playlists:read');
    return { playlist: await loadPlaylist(services, principal.organizationId, idOf(req)) };
  });

  server.post('/api/v1/playlists', async (req, reply) => {
    const principal = authorize(req, 'playlists:write');
    const input = parseBody(req, zCreatePlaylistInput);
    const rules = zRotationRules.parse({ ...DEFAULT_ROTATION_RULES, ...(input.rotationRules ?? {}) });

    const { rows } = await db.query<{ id: string }>(
      `insert into playlists (organization_id, name, description, rotation_rules, created_by)
       values ($1,$2,$3,$4::jsonb,$5) returning id`,
      [
        principal.organizationId,
        input.name,
        input.description ?? null,
        JSON.stringify(rules),
        principal.userId,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.playlistUpdated,
      resourceType: 'playlist',
      resourceId: rows[0]!.id,
      requestId: req.id,
      metadata: { created: true },
      ip: req.ip,
    });

    return created(reply, {
      playlist: await loadPlaylist(services, principal.organizationId, rows[0]!.id),
    });
  });

  server.patch('/api/v1/playlists/:id', async (req) => {
    const principal = authorize(req, 'playlists:write');
    const playlistId = idOf(req);
    const input = parseBody(req, zUpdatePlaylistInput);

    const current = await loadPlaylist(services, principal.organizationId, playlistId);
    const rules = input.rotationRules
      ? zRotationRules.parse({ ...current.rotationRules, ...input.rotationRules })
      : null;

    await db.query(
      `update playlists set
         name           = coalesce($3, name),
         description    = coalesce($4, description),
         status         = coalesce($5, status),
         rotation_rules = coalesce($6::jsonb, rotation_rules),
         updated_at     = now()
       where id = $1 and organization_id = $2`,
      [
        playlistId,
        principal.organizationId,
        input.name ?? null,
        input.description ?? null,
        input.status ?? null,
        rules ? JSON.stringify(rules) : null,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.playlistUpdated,
      resourceType: 'playlist',
      resourceId: playlistId,
      requestId: req.id,
      metadata: { fields: Object.keys(input) },
      ip: req.ip,
    });

    return { playlist: await loadPlaylist(services, principal.organizationId, playlistId) };
  });

  // -------------------------------------------------------------------------
  // Itens
  // -------------------------------------------------------------------------

  const zPlaylistParam = z.object({ id: z.uuid() });

  server.post('/api/v1/playlists/:id/items', async (req, reply) => {
    const principal = authorize(req, 'playlists:write');
    const playlistId = parseParams(req, zPlaylistParam).id;
    const input = parseBody(req, zAddPlaylistItemInput);

    await loadPlaylist(services, principal.organizationId, playlistId); // valida tenant

    // Confere que a origem pertence a esta organizacao antes de inserir. A FK
    // composta tambem barra no banco; aqui damos erro legivel.
    if (input.mediaAssetId) {
      const { rows } = await db.query<{ status: string }>(
        'select status from media_assets where id = $1 and organization_id = $2',
        [input.mediaAssetId, principal.organizationId],
      );
      if (!rows[0]) throw new DomainError('not_found', 'Audio nao encontrado na biblioteca.');
      if (rows[0].status !== 'ready') {
        throw new DomainError('conflict', 'Este audio ainda nao esta pronto para tocar.');
      }
    }
    if (input.announcementId) {
      const { rowCount } = await db.query(
        'select 1 from announcements where id = $1 and organization_id = $2',
        [input.announcementId, principal.organizationId],
      );
      if (rowCount === 0) throw new DomainError('not_found', 'Anuncio nao encontrado.');
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into playlist_items
         (organization_id, playlist_id, item_type, sort_order, media_asset_id, announcement_id,
          priority, weight, active_from, active_until, max_plays_per_day)
       values ($1,$2,$3,
               (select coalesce(max(sort_order), 0) + 10 from playlist_items where playlist_id = $2),
               $4,$5,$6,$7,$8,$9,$10)
       returning id`,
      [
        principal.organizationId,
        playlistId,
        input.itemType,
        input.mediaAssetId ?? null,
        input.announcementId ?? null,
        input.priority,
        input.weight,
        input.activeFrom ?? null,
        input.activeUntil ?? null,
        input.maxPlaysPerDay ?? null,
      ],
    );
    void rows;

    await db.query('update playlists set updated_at = now() where id = $1', [playlistId]);
    return created(reply, {
      playlist: await loadPlaylist(services, principal.organizationId, playlistId),
    });
  });

  server.patch('/api/v1/playlists/:playlistId/items/:itemId', async (req) => {
    const principal = authorize(req, 'playlists:write');
    const params = parseParams(req, z.object({ playlistId: z.uuid(), itemId: z.uuid() }));
    const input = parseBody(
      req,
      z.object({
        priority: z.number().int().min(0).max(100).optional(),
        weight: z.number().int().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        maxPlaysPerDay: z.number().int().positive().nullish(),
        activeFrom: z.iso.datetime({ offset: true }).nullish(),
        activeUntil: z.iso.datetime({ offset: true }).nullish(),
      }),
    );

    const { rowCount } = await db.query(
      `update playlist_items set
         priority          = coalesce($4, priority),
         weight            = coalesce($5, weight),
         enabled           = coalesce($6, enabled),
         max_plays_per_day = $7,
         active_from       = coalesce($8, active_from),
         active_until      = coalesce($9, active_until)
       where id = $1 and playlist_id = $2 and organization_id = $3`,
      [
        params.itemId,
        params.playlistId,
        principal.organizationId,
        input.priority ?? null,
        input.weight ?? null,
        input.enabled ?? null,
        input.maxPlaysPerDay ?? null,
        input.activeFrom ?? null,
        input.activeUntil ?? null,
      ],
    );
    if (rowCount === 0) throw new DomainError('not_found', 'Item nao encontrado na playlist.');

    return { playlist: await loadPlaylist(services, principal.organizationId, params.playlistId) };
  });

  server.delete('/api/v1/playlists/:playlistId/items/:itemId', async (req, reply) => {
    const principal = authorize(req, 'playlists:write');
    const params = parseParams(req, z.object({ playlistId: z.uuid(), itemId: z.uuid() }));

    const { rowCount } = await db.query(
      'delete from playlist_items where id = $1 and playlist_id = $2 and organization_id = $3',
      [params.itemId, params.playlistId, principal.organizationId],
    );
    if (rowCount === 0) throw new DomainError('not_found', 'Item nao encontrado na playlist.');
    await db.query('update playlists set updated_at = now() where id = $1', [params.playlistId]);
    return noContent(reply);
  });

  server.post('/api/v1/playlists/:id/reorder', async (req) => {
    const principal = authorize(req, 'playlists:write');
    const playlistId = parseParams(req, zPlaylistParam).id;
    const { itemIds } = parseBody(req, zReorderItemsInput);

    await db.transaction(async (tx) => {
      for (const [index, itemId] of itemIds.entries()) {
        const { rowCount } = await tx.query(
          'update playlist_items set sort_order = $4 where id = $1 and playlist_id = $2 and organization_id = $3',
          [itemId, playlistId, principal.organizationId, (index + 1) * 10],
        );
        if (rowCount === 0) {
          throw new DomainError('validation_failed', 'A lista enviada contem um item que nao e desta playlist.');
        }
      }
      await tx.query('update playlists set updated_at = now() where id = $1', [playlistId]);
    });

    return { playlist: await loadPlaylist(services, principal.organizationId, playlistId) };
  });

  /**
   * Previa da rotacao.
   *
   * Roda o MESMO motor que o player usa, com a mesma semente, para que a
   * sequencia mostrada no painel seja a que vai ao ar. Tambem devolve o que
   * ficou de fora e por que -- "o spot nao entrou" deixa de ser misterio.
   */
  server.get('/api/v1/playlists/:id/preview', async (req) => {
    const principal = authorize(req, 'playlists:read');
    const playlistId = parseParams(req, zPlaylistParam).id;
    const query = parseQuery(
      req,
      z.object({
        minutes: z.coerce.number().int().min(5).max(480).default(60),
        timezone: z.string().optional(),
      }),
    );

    const playlist = await loadPlaylist(services, principal.organizationId, playlistId);
    const rowsResult = await db.query<Record<string, unknown>>(
      `${ITEM_SELECT} where i.playlist_id = $1 order by i.sort_order, i.id`,
      [playlistId],
    );

    const org = await db.query<{ timezone: string }>('select timezone from organizations where id = $1', [
      principal.organizationId,
    ]);

    const result = buildRotation({
      rules: playlist.rotationRules,
      candidates: toRotationCandidates(rowsResult.rows),
      timezone: query.timezone ?? org.rows[0]!.timezone,
      startAt: new Date(),
      horizonMs: query.minutes * 60_000,
      maxItems: 400,
    });

    return {
      slots: result.slots.map((s) => ({
        slotId: s.slotId,
        title: s.candidate.title,
        itemType: s.candidate.itemType,
        durationMs: s.candidate.durationMs,
        startsAfterMs: s.startsAfterMs,
        startsAt: s.startsAt.toISOString(),
      })),
      totalDurationMs: result.totalDurationMs,
      // Diagnostico honesto em vez de silencio.
      excluded: result.excluded,
    };
  });
}
