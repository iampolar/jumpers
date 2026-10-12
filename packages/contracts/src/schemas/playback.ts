import { z } from 'zod';
import { PLAYBACK_EVENT_TYPES, PLAYLIST_ITEM_TYPES } from '../enums';
import { zId, zIsoDateTime } from './common';

/**
 * Manifesto de reproducao.
 *
 * E a unica coisa que o player conhece. Nao carrega texto de roteiro, nome de
 * usuario nem qualquer dado da organizacao alem do necessario para tocar e
 * reportar. URLs de audio sao assinadas e curtas.
 */

export const zManifestItem = z.object({
  /** Identidade do *slot*: estavel para deduplicar eventos reenviados. */
  slotId: z.string(),
  itemType: z.enum(PLAYLIST_ITEM_TYPES),
  mediaAssetId: zId,
  announcementVersionId: zId.nullable(),
  campaignId: zId.nullable(),
  title: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** URL assinada, TTL curto. Nunca uma URL publica permanente. */
  url: z.string(),
  checksumSha256: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Ganho relativo 0..100 aplicado sobre o volume da zona. */
  gain: z.number().int().min(0).max(100),
  /** Posicao planejada. O player pode atrasar, nunca antecipar. */
  startsAfterMs: z.number().int().nonnegative(),
});
export type ManifestItem = z.infer<typeof zManifestItem>;

export const zPlayerManifest = z.object({
  /** Hash do conteudo do manifesto: o player so re-baixa quando muda. */
  revision: z.string(),
  generatedAt: zIsoDateTime,
  /** Instante ate o qual este manifesto e valido. Revogacao expira junto. */
  expiresAt: zIsoDateTime,
  device: z.object({
    id: zId,
    name: z.string(),
    storeName: z.string(),
    zoneName: z.string(),
    timezone: z.string(),
    volume: z.number().int().min(0).max(100),
  }),
  /** `null` quando nao ha programacao valida agora -- o player diz isso na tela. */
  program: z
    .object({
      playlistId: zId,
      playlistName: z.string(),
      scheduleId: zId.nullable(),
      scheduleName: z.string().nullable(),
      /** Fim da janela local atual, em UTC. O player re-sincroniza aqui. */
      windowEndsAt: zIsoDateTime,
    })
    .nullable(),
  items: z.array(zManifestItem),
  /** Motivo legivel quando `items` esta vazio. A UI do player mostra isso. */
  idleReason: z
    .enum(['no_schedule', 'outside_opening_hours', 'blackout', 'empty_playlist', 'no_ready_media'])
    .nullable(),
  policy: z.object({
    heartbeatIntervalSeconds: z.number().int().positive(),
    manifestRefreshSeconds: z.number().int().positive(),
    /** Teto do cache local. O player poda o mais antigo ao estourar. */
    maxCacheBytes: z.number().int().positive(),
    maxPrefetchItems: z.number().int().positive(),
    eventBatchMaxSize: z.number().int().positive(),
  }),
});
export type PlayerManifest = z.infer<typeof zPlayerManifest>;

export const zHeartbeatInput = z.object({
  appVersion: z.string().max(40).optional(),
  /** Revisao do manifesto em uso: o servidor responde se ha nova. */
  manifestRevision: z.string().max(80).nullish(),
  currentSlotId: z.string().max(120).nullish(),
  bufferDepth: z.number().int().min(0).max(1000).optional(),
  cachedItems: z.number().int().min(0).max(10_000).optional(),
  cachedBytes: z.number().int().min(0).optional(),
  online: z.boolean().default(true),
  lastErrorCode: z.string().max(60).nullish(),
  /** Quantos eventos aguardam envio no buffer local. Alimenta o alerta de drift. */
  pendingEvents: z.number().int().min(0).max(100_000).optional(),
});
export type HeartbeatInput = z.infer<typeof zHeartbeatInput>;

export const zHeartbeatResult = z.object({
  serverTime: zIsoDateTime,
  /** `true` -> o player busca `GET /player/manifest` em seguida. */
  manifestStale: z.boolean(),
  nextHeartbeatInSeconds: z.number().int().positive(),
  /** Comandos do painel entregues no heartbeat (sem canal aberto). */
  commands: z.array(z.enum(['refresh_manifest', 'clear_cache', 'reload_app'])).default([]),
});

export const zPlaybackEventInput = z.object({
  /**
   * Gerado pelo player (UUID). Chave de idempotencia: reenviar o mesmo evento
   * apos reconexao nao duplica contagem.
   */
  eventId: z.uuid(),
  slotId: z.string().max(120),
  mediaAssetId: zId,
  announcementVersionId: zId.nullish(),
  campaignId: zId.nullish(),
  eventType: z.enum(PLAYBACK_EVENT_TYPES),
  /** Relogio do dispositivo. Guardado separado de `received_at_server`. */
  occurredAt: z.iso.datetime({ offset: true }),
  playedMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).default(0),
  errorCode: z.string().max(60).nullish(),
});
export type PlaybackEventInput = z.infer<typeof zPlaybackEventInput>;

export const zPlaybackEventBatch = z.object({
  events: z.array(zPlaybackEventInput).min(1).max(500),
});

export const zPlaybackEventBatchResult = z.object({
  accepted: z.number().int().nonnegative(),
  /** Reenvios. Contam como sucesso para o player limpar o buffer. */
  duplicates: z.number().int().nonnegative(),
  rejected: z.array(z.object({ eventId: z.string(), reason: z.string() })),
});
export type PlaybackEventBatchResult = z.infer<typeof zPlaybackEventBatchResult>;
