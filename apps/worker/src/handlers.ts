import type { JobQueue } from '@castwave/contracts';
import { localDateString } from '@castwave/core';
import type { JobHandler } from './runner';

/**
 * Handlers das filas.
 *
 * Cada um e idempotente: reprocessar o mesmo job nao duplica efeito. As filas
 * `media-process`, `announcement-ai` e `billing-events` dependem de codigo que
 * ainda nao existe (pipeline de upload, adapters de IA e gateway); elas estao
 * registradas com uma falha EXPLICITA em vez de um `return` silencioso -- um
 * job que "passa" sem fazer nada e pior que um job que falha, porque esconde
 * o buraco no painel de operacao.
 */

const notImplemented =
  (what: string, when: string): JobHandler =>
  () => {
    throw new Error(`${what} ainda nao implementado. ${when}`);
  };

/**
 * Marca como offline o player sem heartbeat dentro da janela.
 *
 * O estado vem do RELOGIO DO SERVIDOR, nao do navegador dizer que caiu: um
 * player congelado ou com a aba suspensa nao avisa nada, e e exatamente esse
 * o caso que o lojista precisa enxergar.
 */
export const markOfflineDevices =
  (offlineAfterSeconds: number): JobHandler =>
  async (_payload, ctx) => {
    const { rowCount } = await ctx.db.query(
      `update player_devices
          set status = 'offline', updated_at = now()
        where status in ('active','degraded')
          and (last_seen_at is null or last_seen_at < now() - make_interval(secs => $1))`,
      [offlineAfterSeconds],
    );
    if (rowCount > 0) ctx.log('players marcados como offline', { count: rowCount });
  };

/**
 * Agrega `playback_events` em `analytics_daily`.
 *
 * Recalcula o dia inteiro em vez de somar incrementos: `analytics_daily` e
 * cache derivado, e recomputar e sempre correto, mesmo com evento atrasado
 * chegando horas depois pelo buffer offline de um player. Somar incremento
 * daria numero errado no primeiro reenvio duplicado.
 */
export const rollupAnalytics: JobHandler = async (payload, ctx) => {
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId : null;
  const localDate =
    typeof payload.localDate === 'string' ? payload.localDate : localDateString(new Date(), 'UTC');

  const { rowCount } = await ctx.db.query(
    `insert into analytics_daily (
        organization_id, local_date, store_id, announcement_id, campaign_id, item_type,
        started_count, completed_count, failed_count, skipped_count, total_played_ms, computed_at)
     select e.organization_id, e.local_date, e.store_id, e.announcement_id, e.campaign_id, e.item_type,
            count(*) filter (where e.event_type = 'started'),
            count(*) filter (where e.event_type = 'completed'),
            count(*) filter (where e.event_type = 'failed'),
            count(*) filter (where e.event_type = 'skipped'),
            coalesce(sum(e.played_ms), 0),
            now()
       from playback_events e
      where e.local_date = $1::date
        and ($2::uuid is null or e.organization_id = $2::uuid)
      group by e.organization_id, e.local_date, e.store_id, e.announcement_id, e.campaign_id, e.item_type
     on conflict (organization_id, local_date, store_id, item_type,
                  coalesce(announcement_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(campaign_id,     '00000000-0000-0000-0000-000000000000'::uuid))
     do update set started_count   = excluded.started_count,
                   completed_count = excluded.completed_count,
                   failed_count    = excluded.failed_count,
                   skipped_count   = excluded.skipped_count,
                   total_played_ms = excluded.total_played_ms,
                   computed_at     = excluded.computed_at`,
    [localDate, organizationId],
  );
  ctx.log('agregacao diaria recalculada', { localDate, rows: rowCount });
};

/**
 * Aplica a virada de vigencia das campanhas.
 *
 * Conteudo vencido deixa de ser elegivel automaticamente, sem ninguem clicar
 * em nada -- requisito central do blueprint.
 */
export const publishSchedules: JobHandler = async (_payload, ctx) => {
  const started = await ctx.db.query(
    `update campaigns set status = 'running', updated_at = now()
      where status = 'scheduled' and starts_at <= now() and ends_at > now()`,
  );
  const finished = await ctx.db.query(
    `update campaigns set status = 'finished', updated_at = now()
      where status in ('scheduled','running','paused') and ends_at <= now()`,
  );
  const expired = await ctx.db.query(
    `update announcements set status = 'expired', updated_at = now()
      where status in ('scheduled','active','paused')
        and valid_until is not null and valid_until <= now()`,
  );

  if (started.rowCount || finished.rowCount || expired.rowCount) {
    ctx.log('vigencias aplicadas', {
      campanhasIniciadas: started.rowCount,
      campanhasEncerradas: finished.rowCount,
      anunciosExpirados: expired.rowCount,
    });
  }
};

/** Entrega interna. Sem SMTP, a notificacao fica no app e isso e registrado. */
export const deliverNotification: JobHandler = async (payload, ctx) => {
  const id = typeof payload.notificationId === 'string' ? payload.notificationId : null;
  if (!id) throw new Error('notificationId ausente no payload.');
  const { rowCount } = await ctx.db.query('select 1 from notifications where id = $1', [id]);
  if (rowCount === 0) {
    // Notificacao apagada antes da entrega nao e falha: nao reprocessa.
    ctx.log('notificacao inexistente, ignorada', { notificationId: id });
    return;
  }
  ctx.log('notificacao disponivel no app', { notificationId: id, email: 'not_configured' });
};

/** Remove heartbeats antigos. Historico contabil vive em playback_events. */
export const pruneHeartbeats =
  (retentionDays: number): JobHandler =>
  async (_payload, ctx) => {
    const { rowCount } = await ctx.db.query(
      `delete from device_heartbeats where received_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    if (rowCount > 0) ctx.log('heartbeats antigos removidos', { count: rowCount, retentionDays });
  };

export interface HandlerOptions {
  readonly deviceOfflineAfterSeconds: number;
  readonly heartbeatRetentionDays?: number;
}

export function buildHandlers(options: HandlerOptions): Partial<Record<JobQueue, JobHandler>> {
  const offline = markOfflineDevices(options.deviceOfflineAfterSeconds);
  const prune = pruneHeartbeats(options.heartbeatRetentionDays ?? 14);

  return {
    'schedule-publish': async (payload, ctx) => {
      await publishSchedules(payload, ctx);
      await offline(payload, ctx);
      await prune(payload, ctx);
    },
    'analytics-rollup': rollupAnalytics,
    'notification-delivery': deliverNotification,
    'media-process': notImplemented(
      'Processamento de midia',
      'Depende do pipeline de upload (Fase 4 do roadmap).',
    ),
    'announcement-ai': notImplemented(
      'Geracao por IA',
      'Nenhum provedor configurado; o adapter concreto entra na Fase 9.',
    ),
    'billing-events': notImplemented(
      'Processamento de evento de pagamento',
      'Nenhum gateway conectado; o adapter entra na Fase 10.',
    ),
  };
}
