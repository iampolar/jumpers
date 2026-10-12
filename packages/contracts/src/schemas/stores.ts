import { z } from 'zod';
import { DEVICE_STATUSES, STORE_STATUSES, ZONE_STATUSES } from '../enums';
import { zId, zIsoDateTime, zLocalTime, zSafeText, zSlug, zTimezone, zWeekday } from './common';

export const zOpeningHours = z
  .array(
    z.object({
      weekday: zWeekday,
      opensAt: zLocalTime,
      closesAt: zLocalTime,
      closed: z.boolean().default(false),
    }),
  )
  .max(7)
  .default([])
  .describe('Horario de funcionamento local. Fecha o manifesto fora da janela.');
export type OpeningHours = z.infer<typeof zOpeningHours>;

export const zStore = z.object({
  id: zId,
  organizationId: zId,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  status: z.enum(STORE_STATUSES),
  openingHours: zOpeningHours,
  zoneCount: z.number().int().nonnegative(),
  deviceCount: z.number().int().nonnegative(),
  onlineDeviceCount: z.number().int().nonnegative(),
  createdAt: zIsoDateTime,
});
export type Store = z.infer<typeof zStore>;

export const zCreateStoreInput = z.object({
  name: zSafeText(2, 120),
  slug: zSlug.optional(),
  timezone: zTimezone,
  city: zSafeText(1, 80).nullish(),
  state: z.string().trim().length(2).toUpperCase().nullish(),
  openingHours: zOpeningHours.optional(),
});
export type CreateStoreInput = z.infer<typeof zCreateStoreInput>;

export const zUpdateStoreInput = zCreateStoreInput.partial().extend({
  status: z.enum(STORE_STATUSES).optional(),
});

export const zZone = z.object({
  id: zId,
  organizationId: zId,
  storeId: zId,
  storeName: z.string().optional(),
  name: z.string(),
  /** 0..100. O player multiplica o ganho do item por este valor. */
  defaultVolume: z.number().int().min(0).max(100),
  status: z.enum(ZONE_STATUSES),
  deviceCount: z.number().int().nonnegative(),
  createdAt: zIsoDateTime,
});
export type Zone = z.infer<typeof zZone>;

export const zCreateZoneInput = z.object({
  name: zSafeText(1, 80),
  defaultVolume: z.number().int().min(0).max(100).default(80),
});

export const zUpdateZoneInput = zCreateZoneInput.partial().extend({
  status: z.enum(ZONE_STATUSES).optional(),
});

// --------------------------------------------------------------------------
// Dispositivos
// --------------------------------------------------------------------------

export const zDevice = z.object({
  id: zId,
  organizationId: zId,
  storeId: zId,
  storeName: z.string(),
  zoneId: zId,
  zoneName: z.string(),
  name: z.string(),
  status: z.enum(DEVICE_STATUSES),
  lastSeenAt: zIsoDateTime.nullable(),
  /** Segundos desde o ultimo heartbeat aceito. `null` se nunca sincronizou. */
  secondsSinceLastSeen: z.number().int().nullable(),
  appVersion: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: zIsoDateTime.nullable(),
  /** Itens no cache local informados pelo proprio player no heartbeat. */
  cachedItems: z.number().int().nonnegative().nullable(),
  bufferDepth: z.number().int().nonnegative().nullable(),
  currentItemLabel: z.string().nullable(),
  pairedAt: zIsoDateTime.nullable(),
  revokedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});
export type Device = z.infer<typeof zDevice>;

export const zCreatePairingCodeInput = z.object({
  storeId: zId,
  zoneId: zId,
  deviceName: zSafeText(2, 80),
  /** TTL curto por padrao (blueprint 6.3). Maximo defensivo de 30 min. */
  ttlSeconds: z.number().int().min(60).max(1800).default(300),
});

export const zPairingCodeIssued = z.object({
  /** Mostrado uma unica vez. O banco guarda apenas o hash SHA-256. */
  code: z.string(),
  expiresAt: zIsoDateTime,
  storeId: zId,
  zoneId: zId,
  deviceName: z.string(),
});
export type PairingCodeIssued = z.infer<typeof zPairingCodeIssued>;

export const zPairDeviceInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().length(8, 'O codigo tem 8 caracteres.')),
  userAgent: z.string().max(400).optional(),
});

export const zDeviceCredential = z.object({
  deviceId: zId,
  /** Entregue uma unica vez, no pareamento. Persistido apenas como hash. */
  deviceToken: z.string(),
  storeName: z.string(),
  zoneName: z.string(),
  deviceName: z.string(),
  organizationName: z.string(),
  timezone: z.string(),
});
export type DeviceCredential = z.infer<typeof zDeviceCredential>;

export const zUpdateDeviceInput = z.object({
  name: zSafeText(2, 80).optional(),
  zoneId: zId.optional(),
});
