import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  zCreateExceptionInput,
  zCreateScheduleInput,
  type Schedule,
  type ScheduleException,
} from '@castwave/contracts';
import {
  buildDayTimeline,
  eachLocalDate,
  localDateString,
  resolveProgram,
  type OpeningHoursRule,
  type ScheduleExceptionRule,
  type ScheduleWindow,
  type StoreScheduleContext,
} from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit';
import { authorize, authorizeStore, created, noContent, type AppServices } from '../../http/context';
import { idOf, parseBody, parseQuery } from '../../http/validate';

/**
 * Agenda.
 *
 * A API nao reimplementa nenhuma regra de horario: carrega o estado da loja e
 * entrega ao resolvedor em `@castwave/core`, o mesmo que o player consome. O
 * calendario do painel e, por construcao, o que vai tocar.
 */

/** `time` do Postgres chega como `HH:MM:SS`; a regra trabalha com `HH:MM`. */
const toHm = (value: string): string => value.slice(0, 5);

function mapSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    storeId: row.store_id as string,
    storeName: (row.store_name as string | undefined) ?? undefined,
    storeTimezone: (row.store_timezone as string | undefined) ?? undefined,
    zoneId: (row.zone_id as string | null) ?? null,
    zoneName: (row.zone_name as string | null) ?? null,
    playlistId: row.playlist_id as string,
    playlistName: (row.playlist_name as string | undefined) ?? undefined,
    name: row.name as string,
    weekdays: (row.weekdays as number[]).map(Number),
    startLocalTime: toHm(row.start_local_time as string),
    endLocalTime: toHm(row.end_local_time as string),
    effectiveFrom: row.effective_from ? localDateString(new Date(row.effective_from as string), 'UTC') : null,
    effectiveUntil: row.effective_until ? localDateString(new Date(row.effective_until as string), 'UTC') : null,
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

const SCHEDULE_SELECT = `
  select sc.id, sc.organization_id, sc.store_id, sc.zone_id, sc.playlist_id, sc.name, sc.weekdays,
         sc.start_local_time, sc.end_local_time, sc.effective_from, sc.effective_until,
         sc.priority, sc.enabled, sc.created_at,
         st.name as store_name, st.timezone as store_timezone,
         z.name  as zone_name, pl.name as playlist_name
    from schedules sc
    join stores st     on st.id = sc.store_id
    join playlists pl  on pl.id = sc.playlist_id
    left join audio_zones z on z.id = sc.zone_id`;

/**
 * Monta o contexto que o resolvedor precisa para uma loja.
 *
 * Exportado porque o player usa exatamente esta funcao: uma unica leitura do
 * estado alimenta tanto o calendario do painel quanto o manifesto.
 */
export async function loadStoreScheduleContext(
  services: AppServices,
  organizationId: string,
  storeId: string,
): Promise<StoreScheduleContext> {
  const { db } = services;

  const store = await db.query<{ timezone: string; opening_hours: OpeningHoursRule[] }>(
    'select timezone, opening_hours from stores where id = $1 and organization_id = $2',
    [storeId, organizationId],
  );
  if (!store.rows[0]) throw new DomainError('not_found', 'Loja nao encontrada.');

  const schedules = await db.query<Record<string, unknown>>(
    `select id, playlist_id, name, zone_id, weekdays, start_local_time, end_local_time,
            effective_from, effective_until, priority, enabled, created_at
       from schedules where store_id = $1 and organization_id = $2`,
    [storeId, organizationId],
  );

  const exceptions = await db.query<Record<string, unknown>>(
    `select id, local_date, kind, label, override_playlist_id, start_local_time, end_local_time
       from schedule_exceptions where store_id = $1 and organization_id = $2`,
    [storeId, organizationId],
  );

  const windows: ScheduleWindow[] = schedules.rows.map((r) => ({
    id: r.id as string,
    playlistId: r.playlist_id as string,
    name: r.name as string,
    zoneId: (r.zone_id as string | null) ?? null,
    weekdays: (r.weekdays as number[]).map(Number),
    startLocalTime: toHm(r.start_local_time as string),
    endLocalTime: toHm(r.end_local_time as string),
    effectiveFrom: r.effective_from ? localDateString(new Date(r.effective_from as string), 'UTC') : null,
    effectiveUntil: r.effective_until ? localDateString(new Date(r.effective_until as string), 'UTC') : null,
    priority: Number(r.priority),
    enabled: Boolean(r.enabled),
    createdAt: new Date(r.created_at as string).toISOString(),
  }));

  const rules: ScheduleExceptionRule[] = exceptions.rows.map((r) => ({
    id: r.id as string,
    localDate: localDateString(new Date(r.local_date as string), 'UTC'),
    kind: r.kind as ScheduleExceptionRule['kind'],
    label: r.label as string,
    overridePlaylistId: (r.override_playlist_id as string | null) ?? null,
    startLocalTime: r.start_local_time ? toHm(r.start_local_time as string) : null,
    endLocalTime: r.end_local_time ? toHm(r.end_local_time as string) : null,
  }));

  return {
    storeId,
    timezone: store.rows[0].timezone,
    openingHours: store.rows[0].opening_hours ?? [],
    schedules: windows,
    exceptions: rules,
  };
}

export function registerScheduleRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  server.get('/api/v1/schedules', async (req) => {
    const principal = authorize(req, 'schedules:read');
    const query = parseQuery(req, z.object({ storeId: z.uuid().optional() }));

    const { rows } = await db.query<Record<string, unknown>>(
      `${SCHEDULE_SELECT}
        where sc.organization_id = $1
          and ($2::uuid[] is null or sc.store_id = any($2::uuid[]))
          and ($3::uuid is null or sc.store_id = $3::uuid)
        order by st.name, sc.priority desc, sc.start_local_time`,
      [principal.organizationId, principal.scopedStoreIds ?? null, query.storeId ?? null],
    );
    return { schedules: rows.map(mapSchedule) };
  });

  server.post('/api/v1/schedules', async (req, reply) => {
    const principal = authorize(req, 'schedules:write');
    const input = parseBody(req, zCreateScheduleInput);
    authorizeStore(req, 'schedules:write', input.storeId);

    const playlist = await db.query(
      "select 1 from playlists where id = $1 and organization_id = $2 and status <> 'archived'",
      [input.playlistId, principal.organizationId],
    );
    if (playlist.rowCount === 0) throw new DomainError('not_found', 'Playlist nao encontrada.');

    if (input.zoneId) {
      const zone = await db.query(
        'select 1 from audio_zones where id = $1 and store_id = $2 and organization_id = $3',
        [input.zoneId, input.storeId, principal.organizationId],
      );
      if (zone.rowCount === 0) {
        throw new DomainError('validation_failed', 'A zona precisa pertencer a loja informada.');
      }
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into schedules
         (organization_id, store_id, zone_id, playlist_id, name, weekdays,
          start_local_time, end_local_time, effective_from, effective_until, priority, enabled)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        principal.organizationId,
        input.storeId,
        input.zoneId ?? null,
        input.playlistId,
        input.name,
        input.weekdays,
        input.startLocalTime,
        input.endLocalTime,
        input.effectiveFrom ?? null,
        input.effectiveUntil ?? null,
        input.priority,
        input.enabled,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.scheduleUpdated,
      resourceType: 'schedule',
      resourceId: rows[0]!.id,
      requestId: req.id,
      metadata: { storeId: input.storeId, created: true },
      ip: req.ip,
    });

    const full = await db.query(`${SCHEDULE_SELECT} where sc.id = $1`, [rows[0]!.id]);
    return created(reply, { schedule: mapSchedule(full.rows[0]!) });
  });

  server.patch('/api/v1/schedules/:id', async (req) => {
    const principal = authorize(req, 'schedules:write');
    const scheduleId = idOf(req);
    const input = parseBody(req, zCreateScheduleInput.partial());

    const current = await db.query<{ store_id: string }>(
      'select store_id from schedules where id = $1 and organization_id = $2',
      [scheduleId, principal.organizationId],
    );
    if (!current.rows[0]) throw new DomainError('not_found', 'Agenda nao encontrada.');
    authorizeStore(req, 'schedules:write', current.rows[0].store_id);

    await db.query(
      `update schedules set
         name             = coalesce($3, name),
         playlist_id      = coalesce($4, playlist_id),
         weekdays         = coalesce($5, weekdays),
         start_local_time = coalesce($6, start_local_time),
         end_local_time   = coalesce($7, end_local_time),
         effective_from   = coalesce($8, effective_from),
         effective_until  = coalesce($9, effective_until),
         priority         = coalesce($10, priority),
         enabled          = coalesce($11, enabled),
         updated_at       = now()
       where id = $1 and organization_id = $2`,
      [
        scheduleId,
        principal.organizationId,
        input.name ?? null,
        input.playlistId ?? null,
        input.weekdays ?? null,
        input.startLocalTime ?? null,
        input.endLocalTime ?? null,
        input.effectiveFrom ?? null,
        input.effectiveUntil ?? null,
        input.priority ?? null,
        input.enabled ?? null,
      ],
    );

    const full = await db.query(`${SCHEDULE_SELECT} where sc.id = $1`, [scheduleId]);
    return { schedule: mapSchedule(full.rows[0]!) };
  });

  server.delete('/api/v1/schedules/:id', async (req, reply) => {
    const principal = authorize(req, 'schedules:write');
    const { rowCount } = await db.query(
      'delete from schedules where id = $1 and organization_id = $2',
      [idOf(req), principal.organizationId],
    );
    if (rowCount === 0) throw new DomainError('not_found', 'Agenda nao encontrada.');
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // Excecoes
  // -------------------------------------------------------------------------

  server.get('/api/v1/schedules/exceptions', async (req) => {
    const principal = authorize(req, 'schedules:read');
    const query = parseQuery(req, z.object({ storeId: z.uuid().optional() }));

    const { rows } = await db.query<Record<string, unknown>>(
      `select e.id, e.organization_id, e.store_id, e.local_date, e.kind, e.label,
              e.override_playlist_id, e.start_local_time, e.end_local_time, e.created_at,
              s.name as store_name, p.name as override_playlist_name
         from schedule_exceptions e
         join stores s on s.id = e.store_id
         left join playlists p on p.id = e.override_playlist_id
        where e.organization_id = $1
          and ($2::uuid[] is null or e.store_id = any($2::uuid[]))
          and ($3::uuid is null or e.store_id = $3::uuid)
        order by e.local_date desc limit 365`,
      [principal.organizationId, principal.scopedStoreIds ?? null, query.storeId ?? null],
    );

    const exceptions: ScheduleException[] = rows.map((r) => ({
      id: r.id as string,
      organizationId: r.organization_id as string,
      storeId: r.store_id as string,
      storeName: (r.store_name as string | undefined) ?? undefined,
      localDate: localDateString(new Date(r.local_date as string), 'UTC'),
      kind: r.kind as ScheduleException['kind'],
      label: r.label as string,
      overridePlaylistId: (r.override_playlist_id as string | null) ?? null,
      overridePlaylistName: (r.override_playlist_name as string | null) ?? null,
      startLocalTime: r.start_local_time ? toHm(r.start_local_time as string) : null,
      endLocalTime: r.end_local_time ? toHm(r.end_local_time as string) : null,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
    return { exceptions };
  });

  server.post('/api/v1/schedules/exceptions', async (req, reply) => {
    const principal = authorize(req, 'schedules:write');
    const input = parseBody(req, zCreateExceptionInput);
    authorizeStore(req, 'schedules:write', input.storeId);

    const store = await db.query('select 1 from stores where id = $1 and organization_id = $2', [
      input.storeId,
      principal.organizationId,
    ]);
    if (store.rowCount === 0) throw new DomainError('not_found', 'Loja nao encontrada.');

    const { rows } = await db.query<{ id: string }>(
      `insert into schedule_exceptions
         (organization_id, store_id, local_date, kind, label, override_playlist_id,
          start_local_time, end_local_time, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (store_id, local_date, kind)
       do update set label = excluded.label,
                     override_playlist_id = excluded.override_playlist_id,
                     start_local_time = excluded.start_local_time,
                     end_local_time = excluded.end_local_time
       returning id`,
      [
        principal.organizationId,
        input.storeId,
        input.localDate,
        input.kind,
        input.label,
        input.overridePlaylistId ?? null,
        input.startLocalTime ?? null,
        input.endLocalTime ?? null,
        principal.userId,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.scheduleUpdated,
      resourceType: 'schedule_exception',
      resourceId: rows[0]!.id,
      requestId: req.id,
      metadata: { storeId: input.storeId, kind: input.kind, localDate: input.localDate },
      ip: req.ip,
    });

    return created(reply, { exceptionId: rows[0]!.id });
  });

  server.delete('/api/v1/schedules/exceptions/:id', async (req, reply) => {
    const principal = authorize(req, 'schedules:write');
    const { rowCount } = await db.query(
      'delete from schedule_exceptions where id = $1 and organization_id = $2',
      [idOf(req), principal.organizationId],
    );
    if (rowCount === 0) throw new DomainError('not_found', 'Excecao nao encontrada.');
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // Calendario
  // -------------------------------------------------------------------------

  /**
   * Grade resolvida de uma loja, dia a dia.
   *
   * Cada bloco sai do mesmo resolvedor que o player obedece, no fuso IANA da
   * loja. Uma rede com lojas em fusos diferentes ve grades diferentes para o
   * mesmo "dia", que e precisamente a realidade.
   */
  server.get('/api/v1/schedules/calendar', async (req) => {
    const principal = authorize(req, 'schedules:read');
    const query = parseQuery(
      req,
      z.object({
        storeId: z.uuid(),
        zoneId: z.uuid().optional(),
        from: z.iso.date(),
        to: z.iso.date(),
      }),
    );
    authorizeStore(req, 'schedules:read', query.storeId);

    const ctx = await loadStoreScheduleContext(services, principal.organizationId, query.storeId);
    const dates = eachLocalDate(query.from, query.to, 62);

    const playlists = await db.query<{ id: string; name: string }>(
      'select id, name from playlists where organization_id = $1',
      [principal.organizationId],
    );
    const nameOf = new Map(playlists.rows.map((p) => [p.id, p.name]));

    return {
      timezone: ctx.timezone,
      days: dates.map((localDate) => ({
        localDate,
        blocks: buildDayTimeline(ctx, query.zoneId ?? null, localDate).map((b) => ({
          ...b,
          playlistName: b.playlistId ? (nameOf.get(b.playlistId) ?? null) : null,
        })),
      })),
    };
  });

  /** O que esta tocando agora, segundo o servidor. Alimenta a visao geral. */
  server.get('/api/v1/schedules/now', async (req) => {
    const principal = authorize(req, 'schedules:read');
    const query = parseQuery(req, z.object({ storeId: z.uuid() }));
    authorizeStore(req, 'schedules:read', query.storeId);

    const ctx = await loadStoreScheduleContext(services, principal.organizationId, query.storeId);
    const resolved = resolveProgram(ctx, null, new Date());

    const playlistName = resolved.playlistId
      ? (
          await db.query<{ name: string }>('select name from playlists where id = $1', [
            resolved.playlistId,
          ])
        ).rows[0]?.name ?? null
      : null;

    return {
      playing: resolved.playing,
      playlistId: resolved.playlistId,
      playlistName,
      scheduleName: resolved.scheduleName,
      idleReason: resolved.idleReason,
      appliedException: resolved.appliedException,
      windowEndsAt: resolved.windowEndsAt.toISOString(),
      localDate: resolved.localDate,
      localTime: resolved.localTime,
      timezone: ctx.timezone,
    };
  });
}
