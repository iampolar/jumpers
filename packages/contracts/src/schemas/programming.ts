import { z } from 'zod';
import {
  CAMPAIGN_STATUSES,
  MUSIC_ORDERS,
  PLAYLIST_ITEM_TYPES,
  PLAYLIST_STATUSES,
  SCHEDULE_EXCEPTION_KINDS,
  SPOT_INSERTION_MODES,
} from '../enums';
import { zId, zIsoDate, zIsoDateTime, zLocalTime, zSafeText, zWeekday } from './common';

// --------------------------------------------------------------------------
// Playlists
// --------------------------------------------------------------------------

/**
 * Regras de rotacao. Sao o contrato do motor em `@castwave/core/rotation`:
 * cada campo aqui tem um teste unitario correspondente.
 */
export const zRotationRules = z.object({
  insertionMode: z.enum(SPOT_INSERTION_MODES).default('every_n_tracks'),
  /** Quantas musicas entre blocos de spot (modo `every_n_tracks`). */
  everyNTracks: z.number().int().min(1).max(50).default(3),
  /** Intervalo minimo entre blocos de spot (modo `every_n_minutes`). */
  everyNMinutes: z.number().int().min(1).max(240).default(15),
  /** Quantos spots por bloco. Mais de 1 cria "bloco comercial". */
  spotsPerBreak: z.number().int().min(1).max(5).default(1),
  musicOrder: z.enum(MUSIC_ORDERS).default('shuffle'),
  /** Teto de execucoes do mesmo spot por hora, por zona. */
  maxSpotPlaysPerHour: z.number().int().min(1).max(60).default(6),
  /** Impede o mesmo spot duas vezes seguidas. */
  avoidBackToBackSameSpot: z.boolean().default(true),
  /** Janelas locais em que nenhum spot toca (ex.: fechamento). */
  quietWindows: z
    .array(z.object({ from: zLocalTime, to: zLocalTime, label: zSafeText(1, 60).optional() }))
    .max(12)
    .default([]),
  /** Semente opcional: torna o shuffle reproduzivel em teste e auditoria. */
  shuffleSeed: z.number().int().nullish(),
});
export type RotationRules = z.infer<typeof zRotationRules>;

export const DEFAULT_ROTATION_RULES: RotationRules = zRotationRules.parse({});

export const zPlaylistItem = z.object({
  id: zId,
  playlistId: zId,
  itemType: z.enum(PLAYLIST_ITEM_TYPES),
  sortOrder: z.number().int(),
  mediaAssetId: zId.nullable(),
  announcementId: zId.nullable(),
  title: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** 0 = normal. Maior vence na disputa por um slot de spot. */
  priority: z.number().int().min(0).max(100),
  weight: z.number().int().min(1).max(100),
  activeFrom: zIsoDateTime.nullable(),
  activeUntil: zIsoDateTime.nullable(),
  maxPlaysPerDay: z.number().int().positive().nullable(),
  enabled: z.boolean(),
});
export type PlaylistItem = z.infer<typeof zPlaylistItem>;

export const zPlaylist = z.object({
  id: zId,
  organizationId: zId,
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(PLAYLIST_STATUSES),
  rotationRules: zRotationRules,
  items: z.array(zPlaylistItem),
  musicCount: z.number().int().nonnegative(),
  spotCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});
export type Playlist = z.infer<typeof zPlaylist>;

export const zCreatePlaylistInput = z.object({
  name: zSafeText(2, 120),
  description: zSafeText(0, 400).nullish(),
  rotationRules: zRotationRules.partial().optional(),
});

export const zUpdatePlaylistInput = zCreatePlaylistInput.partial().extend({
  status: z.enum(PLAYLIST_STATUSES).optional(),
});

export const zAddPlaylistItemInput = z
  .object({
    itemType: z.enum(PLAYLIST_ITEM_TYPES),
    mediaAssetId: zId.nullish(),
    announcementId: zId.nullish(),
    priority: z.number().int().min(0).max(100).default(0),
    weight: z.number().int().min(1).max(100).default(1),
    activeFrom: z.iso.datetime({ offset: true }).nullish(),
    activeUntil: z.iso.datetime({ offset: true }).nullish(),
    maxPlaysPerDay: z.number().int().positive().nullish(),
  })
  .refine((v) => Boolean(v.mediaAssetId) !== Boolean(v.announcementId), {
    message: 'Informe exatamente um entre mediaAssetId e announcementId.',
  })
  .refine((v) => v.itemType !== 'music' || Boolean(v.mediaAssetId), {
    message: 'Item musical precisa apontar para um arquivo da biblioteca.',
    path: ['mediaAssetId'],
  });

export const zReorderItemsInput = z.object({ itemIds: z.array(zId).min(1).max(500) });

// --------------------------------------------------------------------------
// Agenda
// --------------------------------------------------------------------------

export const zSchedule = z
  .object({
    id: zId,
    organizationId: zId,
    storeId: zId,
    storeName: z.string().optional(),
    storeTimezone: z.string().optional(),
    /** `null` = vale para todas as zonas da loja. */
    zoneId: zId.nullable(),
    zoneName: z.string().nullable(),
    playlistId: zId,
    playlistName: z.string().optional(),
    name: z.string(),
    weekdays: z.array(zWeekday).min(1).max(7),
    startLocalTime: z.string(),
    endLocalTime: z.string(),
    effectiveFrom: zIsoDate.nullable(),
    effectiveUntil: zIsoDate.nullable(),
    /** Desempata sobreposicoes. Maior vence; empate resolve pelo mais recente. */
    priority: z.number().int().min(0).max(100),
    enabled: z.boolean(),
    createdAt: zIsoDateTime,
  })
  .describe('Janela recorrente resolvida no fuso IANA da loja, com DST.');
export type Schedule = z.infer<typeof zSchedule>;

export const zCreateScheduleInput = z
  .object({
    name: zSafeText(2, 120),
    storeId: zId,
    zoneId: zId.nullish(),
    playlistId: zId,
    weekdays: z.array(zWeekday).min(1).max(7),
    startLocalTime: zLocalTime,
    endLocalTime: zLocalTime,
    effectiveFrom: zIsoDate.nullish(),
    effectiveUntil: zIsoDate.nullish(),
    priority: z.number().int().min(0).max(100).default(0),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.startLocalTime !== v.endLocalTime, {
    message: 'Inicio e fim nao podem ser iguais.',
    path: ['endLocalTime'],
  })
  .refine((v) => !v.effectiveFrom || !v.effectiveUntil || v.effectiveFrom <= v.effectiveUntil, {
    message: 'A vigencia final deve ser posterior a inicial.',
    path: ['effectiveUntil'],
  });
export type CreateScheduleInput = z.infer<typeof zCreateScheduleInput>;

export const zScheduleException = z.object({
  id: zId,
  organizationId: zId,
  storeId: zId,
  storeName: z.string().optional(),
  /** Data *local* da loja. Feriado nao e um instante UTC. */
  localDate: z.string(),
  kind: z.enum(SCHEDULE_EXCEPTION_KINDS),
  label: z.string(),
  overridePlaylistId: zId.nullable(),
  overridePlaylistName: z.string().nullable(),
  startLocalTime: z.string().nullable(),
  endLocalTime: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type ScheduleException = z.infer<typeof zScheduleException>;

export const zCreateExceptionInput = z
  .object({
    storeId: zId,
    localDate: zIsoDate,
    kind: z.enum(SCHEDULE_EXCEPTION_KINDS),
    label: zSafeText(2, 120),
    overridePlaylistId: zId.nullish(),
    startLocalTime: zLocalTime.nullish(),
    endLocalTime: zLocalTime.nullish(),
  })
  .refine((v) => v.kind !== 'override_playlist' || Boolean(v.overridePlaylistId), {
    message: 'Substituicao de playlist exige uma playlist.',
    path: ['overridePlaylistId'],
  })
  .refine((v) => v.kind !== 'special_hours' || (v.startLocalTime && v.endLocalTime), {
    message: 'Horario especial exige inicio e fim.',
    path: ['startLocalTime'],
  });

// --------------------------------------------------------------------------
// Campanhas
// --------------------------------------------------------------------------

export const zCampaign = z.object({
  id: zId,
  organizationId: zId,
  name: z.string(),
  objective: z.string().nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
  startsAt: zIsoDateTime,
  endsAt: zIsoDateTime,
  storeIds: z.array(zId),
  storeNames: z.array(z.string()),
  announcementIds: z.array(zId),
  announcementCount: z.number().int().nonnegative(),
  priority: z.number().int().min(0).max(100),
  maxPlaysPerDayPerStore: z.number().int().positive().nullable(),
  availableActions: z.array(z.string()),
  /** Preenchido em `GET /campaigns/:id/report`. */
  stats: z
    .object({
      started: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      totalPlayedMs: z.number().int().nonnegative(),
    })
    .nullable(),
  createdAt: zIsoDateTime,
});
export type Campaign = z.infer<typeof zCampaign>;

export const zCreateCampaignInput = z
  .object({
    name: zSafeText(2, 140),
    objective: zSafeText(0, 300).nullish(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    storeIds: z.array(zId).min(1).max(500),
    announcementIds: z.array(zId).max(200).default([]),
    priority: z.number().int().min(0).max(100).default(10),
    maxPlaysPerDayPerStore: z.number().int().positive().nullish(),
  })
  .refine((v) => v.startsAt < v.endsAt, {
    message: 'O fim da campanha deve ser posterior ao inicio.',
    path: ['endsAt'],
  });
export type CreateCampaignInput = z.infer<typeof zCreateCampaignInput>;

export const zCampaignActionInput = z.object({
  action: z.enum(['publish', 'start', 'pause', 'resume', 'finish', 'cancel']),
});
