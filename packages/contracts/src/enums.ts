/**
 * Enumeracoes canonicas do dominio CastWave.
 *
 * Toda constante aqui e espelhada por um CHECK constraint ou tipo no banco
 * (ver packages/db/src/migrations). Alterar um valor exige migration.
 */

export const ORGANIZATION_ROLES = [
  'owner',
  'admin',
  'content_editor',
  'store_operator',
  'viewer_finance',
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Papel global da Jumpers. Vive em `users.platform_role`, fora do tenant. */
export const PLATFORM_ROLES = ['none', 'support', 'superadmin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ORGANIZATION_STATUSES = ['active', 'suspended', 'archived'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const STORE_STATUSES = ['active', 'paused', 'archived'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const ZONE_STATUSES = ['active', 'archived'] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];

/** `PAIRING -> ACTIVE -> DEGRADED/OFFLINE -> REVOKED` (blueprint 7.2). */
export const DEVICE_STATUSES = ['pairing', 'active', 'degraded', 'offline', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const MEDIA_KINDS = ['music', 'voice_over', 'jingle', 'operational_notice'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** `DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED -> ACTIVE -> COMPLETED/EXPIRED` */
export const ANNOUNCEMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'active',
  'paused',
  'rejected',
  'cancelled',
  'expired',
  'completed',
  'failed',
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const ANNOUNCEMENT_TYPES = ['promo_spot', 'operational_notice', 'jingle', 'institutional'] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const PLAYLIST_ITEM_TYPES = ['music', 'promo_spot', 'operational_notice', 'jingle'] as const;
export type PlaylistItemType = (typeof PLAYLIST_ITEM_TYPES)[number];

export const PLAYLIST_STATUSES = ['draft', 'active', 'archived'] as const;
export type PlaylistStatus = (typeof PLAYLIST_STATUSES)[number];

/** Como os spots entram na rotacao musical. */
export const SPOT_INSERTION_MODES = ['every_n_tracks', 'every_n_minutes'] as const;
export type SpotInsertionMode = (typeof SPOT_INSERTION_MODES)[number];

export const MUSIC_ORDERS = ['sequential', 'shuffle'] as const;
export type MusicOrder = (typeof MUSIC_ORDERS)[number];

export const SCHEDULE_EXCEPTION_KINDS = ['blackout', 'override_playlist', 'special_hours'] as const;
export type ScheduleExceptionKind = (typeof SCHEDULE_EXCEPTION_KINDS)[number];

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'finished', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const PLAYBACK_EVENT_TYPES = ['started', 'completed', 'failed', 'skipped'] as const;
export type PlaybackEventType = (typeof PLAYBACK_EVENT_TYPES)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'expired',
  'incomplete',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const USAGE_METRICS = [
  'stores_active',
  'devices_active',
  'media_storage_bytes',
  'ai_copy_generations',
  'ai_tts_seconds',
  'playback_events',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const JOB_QUEUES = [
  'media-process',
  'announcement-ai',
  'schedule-publish',
  'analytics-rollup',
  'notification-delivery',
  'billing-events',
] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const INTEGRATION_KEYS = ['ai_copy', 'ai_tts', 'payments', 'email', 'storage', 'ffmpeg'] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export const INTEGRATION_STATES = ['not_configured', 'configured', 'degraded', 'error'] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const SUPPORT_TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS_PT: Record<Weekday, string> = {
  0: 'Domingo',
  1: 'Segunda',
  2: 'Terca',
  3: 'Quarta',
  4: 'Quinta',
  5: 'Sexta',
  6: 'Sabado',
};

export const WEEKDAY_SHORT_PT: Record<Weekday, string> = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sab',
};
