import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  slugify,
  zCreateStoreInput,
  zCreateZoneInput,
  zUpdateStoreInput,
  zUpdateZoneInput,
  type Store,
  type Zone,
} from '@castwave/contracts';
import { assertWithinQuota } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit';
import { authorize, authorizeStore, created, type AppServices } from '../../http/context';
import { idOf, parseBody, parseParams } from '../../http/validate';
import { loadUsage } from '../billing/usage';

/**
 * Lojas e zonas de audio.
 *
 * Toda listagem aplica dois filtros: organizacao (sempre) e escopo de loja
 * (quando o papel do usuario for restrito). Um operador de loja consulta a
 * mesma rota que o owner e recebe apenas o que lhe cabe -- a rota nao tem
 * versao "de operador".
 */

function mapStore(row: Record<string, unknown>): Store {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    slug: row.slug as string,
    timezone: row.timezone as string,
    city: (row.city as string | null) ?? null,
    state: (row.state as string | null) ?? null,
    status: row.status as Store['status'],
    openingHours: (row.opening_hours as Store['openingHours']) ?? [],
    zoneCount: Number(row.zone_count ?? 0),
    deviceCount: Number(row.device_count ?? 0),
    onlineDeviceCount: Number(row.online_device_count ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function mapZone(row: Record<string, unknown>): Zone {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    storeId: row.store_id as string,
    storeName: (row.store_name as string | undefined) ?? undefined,
    name: row.name as string,
    defaultVolume: Number(row.default_volume),
    status: row.status as Zone['status'],
    deviceCount: Number(row.device_count ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/** Projecao de loja com contadores. Reusada em listagem e item. */
const STORE_SELECT = `
  select s.id, s.organization_id, s.name, s.slug, s.timezone, s.city, s.state, s.status,
         s.opening_hours, s.created_at,
         (select count(*) from audio_zones z    where z.store_id = s.id and z.status = 'active')   as zone_count,
         (select count(*) from player_devices d where d.store_id = s.id and d.status <> 'revoked') as device_count,
         (select count(*) from player_devices d where d.store_id = s.id and d.status = 'active')   as online_device_count
    from stores s`;

export function registerStoreRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  // -------------------------------------------------------------------------
  // Lojas
  // -------------------------------------------------------------------------

  server.get('/api/v1/stores', async (req) => {
    const principal = authorize(req, 'stores:read');
    const { rows } = await db.query(
      `${STORE_SELECT}
        where s.organization_id = $1
          and ($2::uuid[] is null or s.id = any($2::uuid[]))
          and s.status <> 'archived'
        order by s.name`,
      [principal.organizationId, principal.scopedStoreIds ?? null],
    );
    return { stores: rows.map(mapStore) };
  });

  server.get('/api/v1/stores/:id', async (req) => {
    const principal = authorize(req, 'stores:read');
    const storeId = idOf(req);
    authorizeStore(req, 'stores:read', storeId);

    const { rows } = await db.query(`${STORE_SELECT} where s.id = $1 and s.organization_id = $2`, [
      storeId,
      principal.organizationId,
    ]);
    if (!rows[0]) throw new DomainError('not_found', 'Loja nao encontrada.');
    return { store: mapStore(rows[0]) };
  });

  server.post('/api/v1/stores', async (req, reply) => {
    const principal = authorize(req, 'stores:manage');
    const input = parseBody(req, zCreateStoreInput);

    // Limite do plano aplicado no servidor, antes de escrever.
    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('stores', usage.quotas, usage.snapshot);

    const slug = input.slug ?? slugify(input.name);
    const taken = await db.query('select 1 from stores where organization_id = $1 and slug = $2', [
      principal.organizationId,
      slug,
    ]);
    if (taken.rowCount > 0) {
      throw new DomainError('already_exists', 'Ja existe uma loja com este identificador.');
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into stores (organization_id, name, slug, timezone, city, state, opening_hours)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning id`,
      [
        principal.organizationId,
        input.name,
        slug,
        input.timezone,
        input.city ?? null,
        input.state ?? null,
        JSON.stringify(input.openingHours ?? []),
      ],
    );
    const storeId = rows[0]!.id;

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.storeCreated,
      resourceType: 'store',
      resourceId: storeId,
      requestId: req.id,
      metadata: { timezone: input.timezone },
      ip: req.ip,
    });

    const full = await db.query(`${STORE_SELECT} where s.id = $1`, [storeId]);
    return created(reply, { store: mapStore(full.rows[0]!) });
  });

  server.patch('/api/v1/stores/:id', async (req) => {
    const principal = authorize(req, 'stores:manage');
    const storeId = idOf(req);
    authorizeStore(req, 'stores:manage', storeId);
    const input = parseBody(req, zUpdateStoreInput);

    const { rowCount } = await db.query(
      `update stores set
         name          = coalesce($3, name),
         slug          = coalesce($4, slug),
         timezone      = coalesce($5, timezone),
         city          = coalesce($6, city),
         state         = coalesce($7, state),
         status        = coalesce($8, status),
         opening_hours = coalesce($9::jsonb, opening_hours),
         updated_at    = now()
       where id = $1 and organization_id = $2`,
      [
        storeId,
        principal.organizationId,
        input.name ?? null,
        input.slug ?? null,
        input.timezone ?? null,
        input.city ?? null,
        input.state ?? null,
        input.status ?? null,
        input.openingHours ? JSON.stringify(input.openingHours) : null,
      ],
    );
    // `where organization_id` + rowCount 0 = nao e sua, ou nao existe. 404 nos
    // dois casos: nao confirmamos a existencia de loja de terceiro.
    if (rowCount === 0) throw new DomainError('not_found', 'Loja nao encontrada.');

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.storeUpdated,
      resourceType: 'store',
      resourceId: storeId,
      requestId: req.id,
      metadata: { fields: Object.keys(input) },
      ip: req.ip,
    });

    const full = await db.query(`${STORE_SELECT} where s.id = $1`, [storeId]);
    return { store: mapStore(full.rows[0]!) };
  });

  /**
   * Arquivamento, nunca DELETE.
   *
   * Apagar a loja levaria junto o historico de reproducao que o lojista pode
   * precisar meses depois. Arquivar tira da operacao e preserva o passado.
   */
  server.delete('/api/v1/stores/:id', async (req) => {
    const principal = authorize(req, 'stores:manage');
    const storeId = idOf(req);
    authorizeStore(req, 'stores:manage', storeId);

    const result = await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `update stores set status = 'archived', archived_at = now(), updated_at = now()
          where id = $1 and organization_id = $2 and status <> 'archived'`,
        [storeId, principal.organizationId],
      );
      if (rowCount === 0) throw new DomainError('not_found', 'Loja nao encontrada.');

      // Players da loja arquivada perdem a credencial: parariam de tocar de
      // qualquer forma, e deixa-los ativos confundiria o painel de operacao.
      const devices = await tx.query(
        `update player_devices set status = 'revoked', revoked_at = now(), updated_at = now()
          where store_id = $1 and status <> 'revoked'`,
        [storeId],
      );
      return { revokedDevices: devices.rowCount };
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.storeArchived,
      resourceType: 'store',
      resourceId: storeId,
      requestId: req.id,
      metadata: result,
      ip: req.ip,
    });

    return { archived: true, ...result };
  });

  // -------------------------------------------------------------------------
  // Zonas
  // -------------------------------------------------------------------------

  const zStoreParam = z.object({ id: z.uuid() });

  server.get('/api/v1/stores/:id/zones', async (req) => {
    const principal = authorize(req, 'stores:read');
    const storeId = parseParams(req, zStoreParam).id;
    authorizeStore(req, 'stores:read', storeId);

    const { rows } = await db.query(
      `select z.id, z.organization_id, z.store_id, z.name, z.default_volume, z.status, z.created_at,
              (select count(*) from player_devices d where d.zone_id = z.id and d.status <> 'revoked') as device_count
         from audio_zones z
        where z.store_id = $1 and z.organization_id = $2 and z.status = 'active'
        order by z.name`,
      [storeId, principal.organizationId],
    );
    return { zones: rows.map(mapZone) };
  });

  server.post('/api/v1/stores/:id/zones', async (req, reply) => {
    const principal = authorize(req, 'zones:manage');
    const storeId = parseParams(req, zStoreParam).id;
    authorizeStore(req, 'zones:manage', storeId);
    const input = parseBody(req, zCreateZoneInput);

    const store = await db.query('select 1 from stores where id = $1 and organization_id = $2', [
      storeId,
      principal.organizationId,
    ]);
    if (store.rowCount === 0) throw new DomainError('not_found', 'Loja nao encontrada.');

    const duplicate = await db.query(
      "select 1 from audio_zones where store_id = $1 and lower(name) = lower($2) and status = 'active'",
      [storeId, input.name],
    );
    if (duplicate.rowCount > 0) {
      throw new DomainError('already_exists', 'Ja existe uma zona com este nome nesta loja.');
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into audio_zones (organization_id, store_id, name, default_volume)
       values ($1,$2,$3,$4) returning id`,
      [principal.organizationId, storeId, input.name, input.defaultVolume],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.zoneCreated,
      resourceType: 'zone',
      resourceId: rows[0]!.id,
      requestId: req.id,
      metadata: { storeId },
      ip: req.ip,
    });

    const full = await db.query(
      `select z.id, z.organization_id, z.store_id, z.name, z.default_volume, z.status, z.created_at, 0 as device_count
         from audio_zones z where z.id = $1`,
      [rows[0]!.id],
    );
    return created(reply, { zone: mapZone(full.rows[0]!) });
  });

  server.patch('/api/v1/zones/:id', async (req) => {
    const principal = authorize(req, 'zones:manage');
    const zoneId = idOf(req);
    const input = parseBody(req, zUpdateZoneInput);

    const owner = await db.query<{ store_id: string }>(
      'select store_id from audio_zones where id = $1 and organization_id = $2',
      [zoneId, principal.organizationId],
    );
    if (!owner.rows[0]) throw new DomainError('not_found', 'Zona nao encontrada.');
    authorizeStore(req, 'zones:manage', owner.rows[0].store_id);

    await db.query(
      `update audio_zones set
         name           = coalesce($3, name),
         default_volume = coalesce($4, default_volume),
         status         = coalesce($5, status),
         updated_at     = now()
       where id = $1 and organization_id = $2`,
      [zoneId, principal.organizationId, input.name ?? null, input.defaultVolume ?? null, input.status ?? null],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.zoneUpdated,
      resourceType: 'zone',
      resourceId: zoneId,
      requestId: req.id,
      metadata: { fields: Object.keys(input) },
      ip: req.ip,
    });

    const full = await db.query(
      `select z.id, z.organization_id, z.store_id, z.name, z.default_volume, z.status, z.created_at,
              (select count(*) from player_devices d where d.zone_id = z.id and d.status <> 'revoked') as device_count
         from audio_zones z where z.id = $1`,
      [zoneId],
    );
    return { zone: mapZone(full.rows[0]!) };
  });
}
