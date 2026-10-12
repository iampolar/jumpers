import { z } from 'zod';
import {
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TYPES,
  MEDIA_KINDS,
  MEDIA_STATUSES,
} from '../enums';
import { zId, zIsoDateTime, zSafeText } from './common';

// --------------------------------------------------------------------------
// Biblioteca de audio
// --------------------------------------------------------------------------

/** Formatos aceitos no upload. Validados por magic bytes, nao pela extensao. */
export const ACCEPTED_AUDIO_MIME = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/aac',
] as const;

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_TRACK_DURATION_MS = 20 * 60 * 1000; // 20 min
export const MAX_SPOT_DURATION_MS = 3 * 60 * 1000; // 3 min

export const zMediaAsset = z.object({
  id: zId,
  organizationId: zId,
  kind: z.enum(MEDIA_KINDS),
  title: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** SHA-256 do conteudo. Deduplica upload e verifica download no player. */
  checksumSha256: z.string().nullable(),
  sampleRate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  bitrateKbps: z.number().int().positive().nullable(),
  /** LUFS integrado quando o worker consegue medir. `null` sem FFmpeg. */
  loudnessLufs: z.number().nullable(),
  status: z.enum(MEDIA_STATUSES),
  processingError: z.string().nullable(),
  /** Quem declarou possuir os direitos de execucao, e quando. */
  rightsAttestedAt: zIsoDateTime.nullable(),
  rightsAttestedBy: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type MediaAsset = z.infer<typeof zMediaAsset>;

export const zCreateUploadInput = z.object({
  filename: zSafeText(1, 200),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  kind: z.enum(MEDIA_KINDS),
  title: zSafeText(1, 160).optional(),
  /**
   * O lojista e responsavel pelo licenciamento do que envia (blueprint 16).
   * Sem isso o upload nao abre.
   */
  rightsAttested: z.literal(true, {
    message: 'Confirme que a organizacao possui direitos de execucao deste audio.',
  }),
});
export type CreateUploadInput = z.infer<typeof zCreateUploadInput>;

export const zUploadTicket = z.object({
  mediaAssetId: zId,
  uploadUrl: z.string(),
  /** Enviar como header `x-castwave-upload-token`. Escopo e TTL curtos. */
  uploadToken: z.string(),
  expiresAt: zIsoDateTime,
  maxBytes: z.number().int(),
});
export type UploadTicket = z.infer<typeof zUploadTicket>;

// --------------------------------------------------------------------------
// Anuncios
// --------------------------------------------------------------------------

export const MAX_SCRIPT_CHARS = 1200;

/** Dicionario de pronuncia: "CastWave" -> "quéste uêive". */
export const zPronunciationDictionary = z
  .array(z.object({ term: zSafeText(1, 60), pronunciation: zSafeText(1, 120) }))
  .max(40)
  .default([]);

export const zAnnouncementVersion = z.object({
  id: zId,
  announcementId: zId,
  versionNumber: z.number().int().positive(),
  scriptText: z.string(),
  locale: z.string(),
  pronunciationDictionary: zPronunciationDictionary,
  mediaAssetId: zId.nullable(),
  mediaTitle: z.string().nullable(),
  mediaDurationMs: z.number().int().nullable(),
  /** Estimativa a partir do texto (~2.6 palavras/s em pt-BR). */
  estimatedDurationMs: z.number().int().nonnegative(),
  /** SHA-256 do conteudo publicado: prova que a versao aprovada nao mudou. */
  contentHash: z.string(),
  source: z.enum(['manual', 'template', 'ai_copy']),
  createdByName: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type AnnouncementVersion = z.infer<typeof zAnnouncementVersion>;

export const zAnnouncement = z.object({
  id: zId,
  organizationId: zId,
  title: z.string(),
  type: z.enum(ANNOUNCEMENT_TYPES),
  status: z.enum(ANNOUNCEMENT_STATUSES),
  currentVersion: zAnnouncementVersion.nullable(),
  versionCount: z.number().int().nonnegative(),
  validFrom: zIsoDateTime.nullable(),
  validUntil: zIsoDateTime.nullable(),
  /** Vazio = todas as lojas da organizacao. */
  storeIds: z.array(zId),
  createdByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: zIsoDateTime.nullable(),
  rejectionReason: z.string().nullable(),
  /** Acoes validas agora, direto da maquina de estados. A UI desabilita o resto. */
  availableActions: z.array(z.string()),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});
export type Announcement = z.infer<typeof zAnnouncement>;

export const zCreateAnnouncementInput = z
  .object({
    title: zSafeText(2, 160),
    type: z.enum(ANNOUNCEMENT_TYPES).default('promo_spot'),
    scriptText: zSafeText(1, MAX_SCRIPT_CHARS),
    locale: z.string().default('pt-BR'),
    pronunciationDictionary: zPronunciationDictionary.optional(),
    mediaAssetId: zId.nullish(),
    validFrom: z.iso.datetime({ offset: true }).nullish(),
    validUntil: z.iso.datetime({ offset: true }).nullish(),
    storeIds: z.array(zId).max(500).default([]),
    source: z.enum(['manual', 'template']).default('manual'),
  })
  .refine((v) => !v.validFrom || !v.validUntil || v.validFrom < v.validUntil, {
    message: 'O fim da vigencia deve ser posterior ao inicio.',
    path: ['validUntil'],
  });
export type CreateAnnouncementInput = z.infer<typeof zCreateAnnouncementInput>;

export const zCreateVersionInput = z.object({
  scriptText: zSafeText(1, MAX_SCRIPT_CHARS),
  pronunciationDictionary: zPronunciationDictionary.optional(),
  mediaAssetId: zId.nullish(),
  source: z.enum(['manual', 'template', 'ai_copy']).default('manual'),
});

export const zAnnouncementActionInput = z.object({
  action: z.enum([
    'submit_approval',
    'approve',
    'reject',
    'schedule',
    'activate',
    'pause',
    'resume',
    'cancel',
    'reopen',
  ]),
  reason: zSafeText(3, 400).optional(),
});

export const zAnnouncementTemplate = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ANNOUNCEMENT_TYPES),
  description: z.string(),
  /** Placeholders `{{produto}}` resolvidos no cliente antes de salvar. */
  body: z.string(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), example: z.string() })),
});
export type AnnouncementTemplate = z.infer<typeof zAnnouncementTemplate>;
