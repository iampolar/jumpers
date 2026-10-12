import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, type OverviewMetrics } from '@castwave/contracts';
import { eachLocalDate, localDateString, safeDownloadFilename, toCsv } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, type AppServices } from '../../http/context.js';
import { parseQuery } from '../../http/validate.js';

/**
 * Relatorios.
 *
 * Todo numero vem de `playback_events`, que e o ledger bruto e imutavel. A
 * tabela agregada e cache reconstruivel; se divergir, recalcula.
 *
 * Duas honestidades que o produto mantem:
 *  - o recorte (periodo, fuso) acompanha o resultado, para que ninguem leia
 *    "1.200 execucoes" sem saber de quando nem em que fuso;
 *  - "execucao confirmada pelo player" nunca e apresentada como "pessoa que
 *    ouviu". O produto nao mede audiencia e nao finge medir.
 */

const zPeriod = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  storeId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  announcementId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
});

/** Filtro comum, com escopo de loja do usuario sempre aplicado. */
function scopeClause(paramOffset: number): string {
  return `
    e.organization_id = $1
    and e.local_date between $2::date and $3::date
    and ($${paramOffset}::uuid[] is null or e.store_id = any($${paramOffset}::uuid[]))
    and ($${paramOffset + 1}::uuid is null or e.store_id = $${paramOffset + 1}::uuid)
    and ($${paramOffset + 2}::uuid is null or e.campaign_id = $${paramOffset + 2}::uuid)
    and ($${paramOffset + 3}::uuid is null or e.announcement_id = $${paramOffset + 3}::uuid)
    and ($${paramOffset + 4}::uuid is null or e.device_id = $${paramOffset + 4}::uuid)`;
}

export function registerAnalyticsRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  server.get('/api/v1/analytics/overview', async (req) => {
    const principal = authorize(req, 'analytics:read');
    const q = parseQuery(req, zPeriod);
    if (q.from > q.to) throw new DomainError('validation_failed', 'A data final deve ser posterior a inicial.');

    const args = [
      principal.organizationId,
      q.from,
      q.to,
      principal.scopedStoreIds ?? null,
      q.storeId ?? null,
      q.campaignId ?? null,
      q.announcementId ?? null,
      q.deviceId ?? null,
    ];

    const totals = await db.query<Record<string, string>>(
      `select
         count(*) filter (where e.event_type = 'started')::text   as started,
         count(*) filter (where e.event_type = 'completed')::text as completed,
         count(*) filter (where e.event_type = 'failed')::text    as failed,
         count(*) filter (where e.event_type = 'skipped')::text   as skipped,
         coalesce(sum(e.played_ms), 0)::text                      as played
       from playback_events e where ${scopeClause(4)}`,
      args,
    );

    const daily = await db.query<Record<string, string>>(
      `select e.local_date::text as date,
              count(*) filter (where e.event_type = 'started')::text   as started,
              count(*) filter (where e.event_type = 'completed')::text as completed,
              count(*) filter (where e.event_type = 'failed')::text    as failed,
              count(*) filter (where e.item_type <> 'music')::text     as spots,
              count(*) filter (where e.item_type = 'music')::text      as music
         from playback_events e where ${scopeClause(4)}
        group by e.local_date order by e.local_date`,
      args,
    );

    const top = await db.query<Record<string, string>>(
      `select e.announcement_id::text as id, a.title,
              count(*) filter (where e.event_type = 'completed')::text as completed,
              coalesce(sum(e.played_ms), 0)::text as played
         from playback_events e join announcements a on a.id = e.announcement_id
        where ${scopeClause(4)} and e.announcement_id is not null
        group by e.announcement_id, a.title
        order by count(*) filter (where e.event_type = 'completed') desc
        limit 10`,
      args,
    );

    const stores = await db.query<Record<string, string>>(
      `select s.id::text, s.name, s.timezone,
              (select count(*) from playback_events e
                where e.store_id = s.id and e.event_type = 'completed'
                  and e.local_date between $2::date and $3::date)::text as completed,
              (select count(*) from playback_events e
                where e.store_id = s.id and e.event_type = 'failed'
                  and e.local_date between $2::date and $3::date)::text as failed,
              (select count(*) from player_devices d
                where d.store_id = s.id and d.status = 'active')::text  as online_devices,
              (select count(*) from player_devices d
                where d.store_id = s.id and d.status <> 'revoked')::text as total_devices
         from stores s
        where s.organization_id = $1 and s.status <> 'archived'
          and ($4::uuid[] is null or s.id = any($4::uuid[]))
        order by s.name`,
      [principal.organizationId, q.from, q.to, principal.scopedStoreIds ?? null],
    );

    const counts = await db.query<Record<string, string>>(
      `select
         (select count(*) from stores where organization_id = $1 and status <> 'archived')::text as stores_total,
         (select count(*) from stores where organization_id = $1 and status = 'active')::text    as stores_active,
         (select count(*) from player_devices where organization_id = $1 and status <> 'revoked')::text as dev_total,
         (select count(*) from player_devices where organization_id = $1 and status = 'active')::text   as dev_online,
         (select count(*) from player_devices where organization_id = $1 and status = 'offline')::text  as dev_offline,
         (select count(*) from player_devices where organization_id = $1 and status = 'degraded')::text as dev_degraded,
         (select count(*) from player_devices where organization_id = $1 and status = 'revoked')::text  as dev_revoked,
         (select count(*) from campaigns where organization_id = $1 and status = 'running')::text   as camp_running,
         (select count(*) from campaigns where organization_id = $1 and status = 'scheduled')::text as camp_scheduled,
         (select count(*) from campaigns where organization_id = $1 and status = 'finished')::text  as camp_finished,
         (select count(*) from media_assets where organization_id = $1 and status = 'ready')::text      as media_ready,
         (select count(*) from media_assets where organization_id = $1 and status = 'processing')::text as media_processing,
         (select count(*) from media_assets where organization_id = $1 and status = 'failed')::text     as media_failed,
         (select coalesce(sum(size_bytes),0) from media_assets where organization_id = $1 and status <> 'archived')::text as media_bytes`,
      [principal.organizationId],
    );

    const org = await db.query<{ timezone: string }>('select timezone from organizations where id = $1', [
      principal.organizationId,
    ]);

    const t = totals.rows[0]!;
    const c = counts.rows[0]!;
    const started = Number(t.started);

    // Serie DENSA: dias sem evento entram como zero. Um grafico com buracos
    // sugere "sem dado" quando o correto e "nada tocou".
    const byDate = new Map(daily.rows.map((r) => [r.date!, r]));
    const dense = eachLocalDate(q.from, q.to, 400).map((date) => {
      const row = byDate.get(date);
      return {
        date,
        started: Number(row?.started ?? 0),
        completed: Number(row?.completed ?? 0),
        failed: Number(row?.failed ?? 0),
        spots: Number(row?.spots ?? 0),
        music: Number(row?.music ?? 0),
      };
    });

    const metrics: OverviewMetrics = {
      period: { from: q.from, to: q.to, timezone: org.rows[0]!.timezone },
      stores: { total: Number(c.stores_total), active: Number(c.stores_active) },
      devices: {
        total: Number(c.dev_total),
        online: Number(c.dev_online),
        offline: Number(c.dev_offline),
        degraded: Number(c.dev_degraded),
        revoked: Number(c.dev_revoked),
      },
      playback: {
        started,
        completed: Number(t.completed),
        failed: Number(t.failed),
        skipped: Number(t.skipped),
        totalPlayedMs: Number(t.played),
        // `null` quando nao houve execucao: 0% seria uma afirmacao falsa.
        completionRate: started > 0 ? Number(t.completed) / started : null,
      },
      campaigns: {
        running: Number(c.camp_running),
        scheduled: Number(c.camp_scheduled),
        finishedInPeriod: Number(c.camp_finished),
      },
      media: {
        ready: Number(c.media_ready),
        processing: Number(c.media_processing),
        failed: Number(c.media_failed),
        storageBytes: Number(c.media_bytes),
      },
      daily: dense,
      topAnnouncements: top.rows.map((r) => ({
        announcementId: r.id!,
        title: r.title!,
        completed: Number(r.completed),
        totalPlayedMs: Number(r.played),
      })),
      storeBreakdown: stores.rows.map((r) => ({
        storeId: r.id!,
        storeName: r.name!,
        timezone: r.timezone!,
        completed: Number(r.completed),
        failed: Number(r.failed),
        onlineDevices: Number(r.online_devices),
        totalDevices: Number(r.total_devices),
      })),
    };
    return metrics;
  });

  /** Linhas cruas de execucao, com hora LOCAL de cada loja. */
  server.get('/api/v1/analytics/playback', async (req) => {
    const principal = authorize(req, 'analytics:read');
    const q = parseQuery(req, zPeriod.extend({ limit: z.coerce.number().int().min(1).max(1000).default(200) }));

    const { rows } = await db.query<Record<string, unknown>>(
      `select e.occurred_at_device, e.local_date, e.event_type, e.played_ms, e.error_code, e.item_type,
              s.name as store_name, s.timezone, z.name as zone_name, d.name as device_name,
              coalesce(m.title, a.title) as title, c.name as campaign_name
         from playback_events e
         join stores s        on s.id = e.store_id
         join audio_zones z   on z.id = e.zone_id
         join player_devices d on d.id = e.device_id
         left join media_assets m   on m.id = e.media_asset_id
         left join announcements a  on a.id = e.announcement_id
         left join campaigns c      on c.id = e.campaign_id
        where ${scopeClause(4)}
        order by e.occurred_at_device desc
        limit $9`,
      [
        principal.organizationId,
        q.from,
        q.to,
        principal.scopedStoreIds ?? null,
        q.storeId ?? null,
        q.campaignId ?? null,
        q.announcementId ?? null,
        q.deviceId ?? null,
        q.limit,
      ],
    );

    return {
      period: { from: q.from, to: q.to },
      rows: rows.map((r) => ({
        occurredAt: new Date(r.occurred_at_device as string).toISOString(),
        localTime: new Intl.DateTimeFormat('pt-BR', {
          timeZone: r.timezone as string,
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(new Date(r.occurred_at_device as string)),
        storeName: r.store_name as string,
        zoneName: r.zone_name as string,
        deviceName: r.device_name as string,
        itemType: r.item_type as string,
        title: (r.title as string | null) ?? 'Sem titulo',
        campaignName: (r.campaign_name as string | null) ?? null,
        eventType: r.event_type as string,
        playedMs: Number(r.played_ms),
        errorCode: (r.error_code as string | null) ?? null,
      })),
    };
  });

  /**
   * Exportacao CSV.
   *
   * Respeita escopo e filtros, e cada celula passa pelo escape que neutraliza
   * formula do Excel -- um nome de playlist como `=HYPERLINK(...)` nao vira
   * execucao de codigo na maquina de quem abre o relatorio.
   */
  server.get('/api/v1/analytics/export.csv', async (req, reply) => {
    const principal = authorize(req, 'analytics:export');
    const q = parseQuery(req, zPeriod);

    const { rows } = await db.query<Record<string, unknown>>(
      `select e.occurred_at_device, e.local_date, e.event_type, e.played_ms, e.error_code, e.item_type,
              s.name as store_name, s.timezone, z.name as zone_name, d.name as device_name,
              coalesce(m.title, a.title) as title, c.name as campaign_name
         from playback_events e
         join stores s        on s.id = e.store_id
         join audio_zones z   on z.id = e.zone_id
         join player_devices d on d.id = e.device_id
         left join media_assets m  on m.id = e.media_asset_id
         left join announcements a on a.id = e.announcement_id
         left join campaigns c     on c.id = e.campaign_id
        where ${scopeClause(4)}
        order by e.occurred_at_device desc
        limit 50000`,
      [
        principal.organizationId,
        q.from,
        q.to,
        principal.scopedStoreIds ?? null,
        q.storeId ?? null,
        q.campaignId ?? null,
        q.announcementId ?? null,
        q.deviceId ?? null,
      ],
    );

    const csv = toCsv(rows, [
      { header: 'Data local', value: (r) => localDateString(new Date(r.occurred_at_device as string), r.timezone as string) },
      {
        header: 'Hora local',
        value: (r) =>
          new Intl.DateTimeFormat('pt-BR', { timeZone: r.timezone as string, timeStyle: 'medium' }).format(
            new Date(r.occurred_at_device as string),
          ),
      },
      { header: 'Fuso', value: (r) => r.timezone },
      { header: 'Loja', value: (r) => r.store_name },
      { header: 'Zona', value: (r) => r.zone_name },
      { header: 'Player', value: (r) => r.device_name },
      { header: 'Tipo', value: (r) => r.item_type },
      { header: 'Titulo', value: (r) => r.title ?? '' },
      { header: 'Campanha', value: (r) => r.campaign_name ?? '' },
      { header: 'Evento', value: (r) => r.event_type },
      { header: 'Tocado (s)', value: (r) => Math.round(Number(r.played_ms) / 1000) },
      { header: 'Erro', value: (r) => r.error_code ?? '' },
    ]);

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.reportExported,
      resourceType: 'analytics',
      requestId: req.id,
      metadata: { from: q.from, to: q.to, rows: rows.length },
      ip: req.ip,
    });

    const filename = safeDownloadFilename(`castwave-execucoes-${q.from}-a-${q.to}`, 'csv');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}
