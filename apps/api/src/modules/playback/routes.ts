import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DomainError,
  zHeartbeatInput,
  zPlaybackEventBatch,
  type ManifestItem,
  type PlayerManifest,
} from '@castwave/contracts';
import {
  buildRotation,
  localDateString,
  resolveProgram,
  signUrlToken,
} from '@castwave/core';
import { DEFAULT_ROTATION_RULES, zRotationRules } from '@castwave/contracts';
import { requireDevice, type AppServices } from '../../http/context';
import { parseBody } from '../../http/validate';
import { toRotationCandidates } from '../playlists/routes';
import { loadStoreScheduleContext } from '../schedules/routes';

/**
 * API do player.
 *
 * Tudo aqui e autenticado por token de dispositivo -- nunca por sessao humana
 * -- e o escopo e o menor possivel: o player so enxerga a propria loja e zona.
 * O manifesto nao carrega roteiro, nome de usuario nem nada da organizacao
 * alem do necessario para tocar e reportar.
 */

const MANIFEST_TTL_SECONDS = 600;
const HEARTBEAT_INTERVAL_SECONDS = 45;

/**
 * Horizonte do manifesto.
 *
 * Longo o bastante para sobreviver a uma queda de internet de alguns minutos
 * com o cache local, curto o bastante para que uma revogacao ou uma troca de
 * campanha entrem em vigor rapidamente.
 */
const HORIZON_MS = 30 * 60_000;
const MAX_ITEMS = 40;

const PLAYER_POLICY: PlayerManifest['policy'] = {
  heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  manifestRefreshSeconds: 300,
  // Teto honesto: o navegador nao garante mais que isso de forma confiavel.
  maxCacheBytes: 512 * 1024 * 1024,
  maxPrefetchItems: 12,
  eventBatchMaxSize: 200,
};

export function registerPlaybackRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, config, audit } = services;

  /**
   * Manifesto de reproducao.
   *
   * Resolve agenda -> playlist -> rotacao, com o MESMO motor que o painel usa
   * na previa. O player nao decide nada sozinho: recebe uma lista pronta com
   * posicao no tempo, e so reporta o que aconteceu.
   */
  server.get('/api/v1/player/manifest', async (req) => {
    const device = requireDevice(req);

    const info = await db.query<{
      device_name: string;
      store_name: string;
      zone_name: string;
      zone_volume: number;
      timezone: string;
    }>(
      `select d.name as device_name, s.name as store_name, z.name as zone_name,
              z.default_volume as zone_volume, s.timezone
         from player_devices d
         join stores s      on s.id = d.store_id
         join audio_zones z on z.id = d.zone_id
        where d.id = $1`,
      [device.deviceId],
    );
    const meta = info.rows[0];
    if (!meta) throw new DomainError('not_found', 'Dispositivo nao encontrado.');

    const ctx = await loadStoreScheduleContext(services, device.organizationId, device.storeId);
    const now = new Date();
    const resolved = resolveProgram(ctx, device.zoneId, now);

    const baseManifest = {
      generatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MANIFEST_TTL_SECONDS * 1000).toISOString(),
      device: {
        id: device.deviceId,
        name: meta.device_name,
        storeName: meta.store_name,
        zoneName: meta.zone_name,
        timezone: meta.timezone,
        volume: Number(meta.zone_volume),
      },
      policy: PLAYER_POLICY,
    };

    // Sem programacao: devolvemos o motivo, e o player exibe isso em vez de
    // fingir que esta tocando.
    if (!resolved.playing || !resolved.playlistId) {
      const empty: PlayerManifest = {
        ...baseManifest,
        revision: 'idle',
        program: null,
        items: [],
        idleReason: resolved.idleReason ?? 'no_schedule',
      };
      return empty;
    }

    const playlist = await db.query<{ name: string; rotation_rules: object }>(
      'select name, rotation_rules from playlists where id = $1 and organization_id = $2',
      [resolved.playlistId, device.organizationId],
    );
    if (!playlist.rows[0]) {
      return {
        ...baseManifest,
        revision: 'idle',
        program: null,
        items: [],
        idleReason: 'no_schedule',
      } satisfies PlayerManifest;
    }

    /*
     * Execucoes de hoje, por item, no fuso da loja. Sem isso o teto diario
     * reiniciaria a cada manifesto e um spot com limite de 5 tocaria 50 vezes.
     */
    const localDate = localDateString(now, ctx.timezone);
    const playsTodayRows = await db.query<{ playlist_item_id: string; n: string }>(
      `select i.id as playlist_item_id, count(*)::text as n
         from playback_events e
         join playlist_items i
           on (i.media_asset_id = e.media_asset_id or i.announcement_id = e.announcement_id)
          and i.playlist_id = $1
        where e.zone_id = $2 and e.local_date = $3::date and e.event_type = 'completed'
        group by i.id`,
      [resolved.playlistId, device.zoneId, localDate],
    );
    const playsToday = new Map(playsTodayRows.rows.map((r) => [r.playlist_item_id, Number(r.n)]));

    /*
     * Itens elegiveis.
     *
     * A clausula de campanha e o que faz conteudo vencido parar sozinho: a
     * vigencia e avaliada AGORA, a cada manifesto. Nao depende de job, nao
     * tem janela de atraso.
     */
    const itemRows = await db.query<Record<string, unknown>>(
      `select i.id, i.playlist_id, i.item_type, i.sort_order, i.media_asset_id, i.announcement_id,
              i.priority, i.weight, i.active_from, i.active_until, i.max_plays_per_day, i.enabled,
              coalesce(m.title, a.title)                      as title,
              coalesce(m.duration_ms, vm.duration_ms)         as duration_ms,
              coalesce(m.id, vm.id)                           as resolved_media_id,
              coalesce(m.size_bytes, vm.size_bytes)           as size_bytes,
              coalesce(m.checksum_sha256, vm.checksum_sha256) as checksum,
              coalesce(m.storage_key, vm.storage_key)         as storage_key,
              a.status      as announcement_status,
              a.valid_from  as announcement_valid_from,
              a.valid_until as announcement_valid_until,
              v.id          as announcement_version_id,
              (select c.id from campaign_announcements ca
                 join campaigns c on c.id = ca.campaign_id
                 join campaign_stores cs on cs.campaign_id = c.id and cs.store_id = $3
                where ca.announcement_id = a.id
                  and c.status in ('scheduled','running')
                  and c.starts_at <= now() and c.ends_at > now()
                order by c.priority desc limit 1) as campaign_id
         from playlist_items i
         left join media_assets m          on m.id = i.media_asset_id and m.status = 'ready'
         left join announcements a         on a.id = i.announcement_id
         left join announcement_versions v on v.id = a.current_version_id
         left join media_assets vm         on vm.id = v.media_asset_id and vm.status = 'ready'
        where i.playlist_id = $1 and i.organization_id = $2
        order by i.sort_order, i.id`,
      [resolved.playlistId, device.organizationId, device.storeId],
    );

    /*
     * Anuncio com alvo de loja explicito so entra se ESTA loja estiver na
     * lista. Sem alvo, vale para toda a organizacao. A consulta ja devolveu
     * `campaign_id` apenas quando a campanha cobre esta loja e esta vigente
     * agora -- e por isso que conteudo vencido para de tocar sozinho, sem
     * depender de job.
     */
    const targetedRows = await db.query<{ announcement_id: string }>(
      `select announcement_id from announcement_stores
        where organization_id = $1 and store_id <> $2
          and announcement_id not in (
            select announcement_id from announcement_stores
             where organization_id = $1 and store_id = $2)`,
      [device.organizationId, device.storeId],
    );
    const excludedAnnouncements = new Set(targetedRows.rows.map((r) => r.announcement_id));
    const eligible = itemRows.rows.filter(
      (row) => !row.announcement_id || !excludedAnnouncements.has(row.announcement_id as string),
    );

    const rules = zRotationRules.parse({
      ...DEFAULT_ROTATION_RULES,
      ...(playlist.rows[0].rotation_rules),
    });

    const rotation = buildRotation({
      rules,
      candidates: toRotationCandidates(eligible, playsToday),
      timezone: ctx.timezone,
      startAt: now,
      horizonMs: Math.min(HORIZON_MS, resolved.windowEndsAt.getTime() - now.getTime() || HORIZON_MS),
      maxItems: MAX_ITEMS,
    });

    const storageKeyById = new Map(
      itemRows.rows
        .filter((r) => r.resolved_media_id && r.storage_key)
        .map((r) => [r.resolved_media_id as string, r.storage_key as string]),
    );

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const items: ManifestItem[] = rotation.slots.flatMap((slot) => {
      const key = storageKeyById.get(slot.candidate.mediaAssetId);
      if (!key) return [];
      return [
        {
          slotId: slot.slotId,
          itemType: slot.candidate.itemType,
          mediaAssetId: slot.candidate.mediaAssetId,
          announcementVersionId: slot.candidate.announcementVersionId,
          campaignId: slot.candidate.campaignId,
          title: slot.candidate.title,
          durationMs: slot.candidate.durationMs,
          // URL assinada, TTL curto, amarrada A ESTE dispositivo: um link
          // vazado nao serve a nenhum outro player.
          url: `/api/v1/media/stream?token=${encodeURIComponent(
            signUrlToken(
              {
                key,
                expiresAt: nowSeconds + MANIFEST_TTL_SECONDS + 300,
                audience: `device:${device.deviceId}`,
              },
              config.MEDIA_URL_SECRET,
            ),
          )}`,
          checksumSha256: slot.candidate.checksumSha256,
          sizeBytes: slot.candidate.sizeBytes,
          gain: slot.candidate.gain,
          startsAfterMs: slot.startsAfterMs,
        },
      ];
    });

    /*
     * Revisao = hash do CONTEUDO, sem as URLs (que mudam a cada emissao por
     * causa do token). Assim o player so re-baixa quando a programacao muda
     * de verdade, em vez de a cada refresh.
     */
    const revision = createHash('sha256')
      .update(
        JSON.stringify(
          items.map((i) => [i.slotId, i.mediaAssetId, i.durationMs, i.startsAfterMs, i.campaignId]),
        ),
      )
      .digest('hex')
      .slice(0, 16);

    const manifest: PlayerManifest = {
      ...baseManifest,
      revision,
      program: {
        playlistId: resolved.playlistId,
        playlistName: playlist.rows[0].name,
        scheduleId: resolved.scheduleId,
        scheduleName: resolved.scheduleName,
        windowEndsAt: resolved.windowEndsAt.toISOString(),
      },
      items,
      idleReason: items.length === 0 ? (rotation.excluded.length > 0 ? 'no_ready_media' : 'empty_playlist') : null,
    };
    return manifest;
  });

  /**
   * Heartbeat.
   *
   * Barato de proposito: um UPDATE. E o unico sinal confiavel de que o player
   * esta vivo -- o navegador nao avisa quando a aba congela.
   */
  server.post('/api/v1/player/heartbeat', async (req) => {
    const device = requireDevice(req);
    const input = parseBody(req, zHeartbeatInput);

    const { rows } = await db.query<{ last_manifest_rev: string | null }>(
      `update player_devices set
          status = case when status = 'offline' then 'active' else status end,
          last_seen_at = now(),
          app_version = coalesce($2, app_version),
          buffer_depth = $3,
          cached_items = $4,
          cached_bytes = $5,
          pending_events = $6,
          current_item_label = $7,
          last_error_code = $8,
          last_error_at = case when $8::text is not null then now() else last_error_at end,
          updated_at = now()
        where id = $1
        returning last_manifest_rev`,
      [
        device.deviceId,
        input.appVersion ?? null,
        input.bufferDepth ?? null,
        input.cachedItems ?? null,
        input.cachedBytes ?? null,
        input.pendingEvents ?? null,
        input.currentSlotId ?? null,
        input.lastErrorCode ?? null,
      ],
    );

    await db.query(
      `insert into device_heartbeats
         (organization_id, device_id, online, buffer_depth, cached_items, pending_events, app_version, error_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        device.organizationId,
        device.deviceId,
        input.online,
        input.bufferDepth ?? null,
        input.cachedItems ?? null,
        input.pendingEvents ?? null,
        input.appVersion ?? null,
        input.lastErrorCode ?? null,
      ],
    );

    // O servidor confere a revisao: o player nao precisa baixar o manifesto
    // inteiro para descobrir que nada mudou.
    const stale = input.manifestRevision !== rows[0]?.last_manifest_rev;

    return {
      serverTime: new Date().toISOString(),
      manifestStale: stale,
      nextHeartbeatInSeconds: HEARTBEAT_INTERVAL_SECONDS,
      commands: [],
    };
  });

  /**
   * Eventos de reproducao.
   *
   * Idempotencia por `event_id` gerado no PLAYER: reenviar o buffer apos uma
   * reconexao nao duplica contagem, porque a chave primaria da tabela e esse
   * id. O `on conflict do nothing` transforma reenvio em sucesso silencioso,
   * que e o que o player precisa para limpar o buffer local com seguranca.
   */
  server.post('/api/v1/player/events', async (req) => {
    const device = requireDevice(req);
    const { events } = parseBody(req, zPlaybackEventBatch);

    const info = await db.query<{ timezone: string }>(
      'select s.timezone from stores s where s.id = $1',
      [device.storeId],
    );
    const timezone = info.rows[0]?.timezone ?? 'UTC';

    let accepted = 0;
    let duplicates = 0;
    const rejected: { eventId: string; reason: string }[] = [];

    await db.transaction(async (tx) => {
      for (const event of events) {
        /*
         * A data LOCAL e calculada aqui, com o fuso da loja, a partir do
         * instante informado pelo player. Deixar o player decidir a data
         * bagunçaria o relatorio de uma rede multi-fuso.
         */
        const occurredAt = new Date(event.occurredAt);
        const localDate = localDateString(occurredAt, timezone);

        /*
         * SAVEPOINT por evento.
         *
         * No Postgres, uma violacao de constraint aborta a transacao inteira:
         * sem isto, um unico evento malformado derrubaria todos os seguintes
         * do mesmo lote e o player nunca conseguiria drenar o buffer.
         */
        const savepoint = `ev_${accepted + duplicates + rejected.length}`;
        await tx.query(`savepoint ${savepoint}`);
        try {
          const { rowCount } = await tx.query(
            `insert into playback_events
               (event_id, organization_id, store_id, zone_id, device_id, slot_id,
                media_asset_id, announcement_id, campaign_id, item_type, event_type,
                occurred_at_device, played_ms, error_code, local_date)
             select $1,$2,$3,$4,$5,$6,$7,
                    (select announcement_id from announcement_versions where id = $8),
                    $9,
                    -- Tipo derivado do conteudo: um spot reportado como
                    -- musica estragaria todo relatorio por tipo de item.
                    coalesce(
                      (select case a.type
                                when 'operational_notice' then 'operational_notice'
                                when 'jingle'             then 'jingle'
                                else 'promo_spot' end
                         from announcement_versions av
                         join announcements a on a.id = av.announcement_id
                        where av.id = $8),
                      'music'),
                    $10,$11,$12,$13,$14::date
             on conflict (event_id) do nothing`,
            [
              event.eventId,
              device.organizationId,
              device.storeId,
              device.zoneId,
              device.deviceId,
              event.slotId,
              event.mediaAssetId,
              event.announcementVersionId ?? null,
              event.campaignId ?? null,
              event.eventType,
              occurredAt,
              event.playedMs,
              event.errorCode ?? null,
              localDate,
            ],
          );
          await tx.query(`release savepoint ${savepoint}`);
          if (rowCount > 0) accepted += 1;
          else duplicates += 1;
        } catch (error) {
          await tx.query(`rollback to savepoint ${savepoint}`);
          // Um evento ruim nao derruba o lote inteiro: o player precisa
          // conseguir drenar o buffer.
          rejected.push({
            eventId: event.eventId,
            reason: error instanceof Error ? error.message.slice(0, 120) : 'erro desconhecido',
          });
        }
      }
    });

    return { accepted, duplicates, rejected };
  });

  void audit;
}
