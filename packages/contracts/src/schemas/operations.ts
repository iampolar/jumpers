import { z } from 'zod';
import {
  INTEGRATION_KEYS,
  INTEGRATION_STATES,
  JOB_QUEUES,
  JOB_STATUSES,
  NOTIFICATION_SEVERITIES,
  SUBSCRIPTION_STATUSES,
  USAGE_METRICS,
} from '../enums.js';
import { zCurrency, zId, zIsoDate, zIsoDateTime, zMoneyCents, zSafeText } from './common.js';

// --------------------------------------------------------------------------
// Analytics
// --------------------------------------------------------------------------

export const zAnalyticsFilters = z.object({
  from: zIsoDate,
  to: zIsoDate,
  storeId: zId.optional(),
  campaignId: zId.optional(),
  announcementId: zId.optional(),
  deviceId: zId.optional(),
});
export type AnalyticsFilters = z.infer<typeof zAnalyticsFilters>;

export const zOverviewMetrics = z.object({
  /** Periodo e fuso sao devolvidos para a UI nao "inventar" o recorte. */
  period: z.object({ from: zIsoDate, to: zIsoDate, timezone: z.string() }),
  stores: z.object({ total: z.number().int(), active: z.number().int() }),
  devices: z.object({
    total: z.number().int(),
    online: z.number().int(),
    offline: z.number().int(),
    degraded: z.number().int(),
    revoked: z.number().int(),
  }),
  playback: z.object({
    started: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    totalPlayedMs: z.number().int(),
    /** completed / started. `null` quando nao houve execucao no periodo. */
    completionRate: z.number().nullable(),
  }),
  campaigns: z.object({ running: z.number().int(), scheduled: z.number().int(), finishedInPeriod: z.number().int() }),
  media: z.object({ ready: z.number().int(), processing: z.number().int(), failed: z.number().int(), storageBytes: z.number().int() }),
  /** Serie diaria para o grafico principal. Sempre densa (dias sem evento = 0). */
  daily: z.array(
    z.object({
      date: z.string(),
      started: z.number().int(),
      completed: z.number().int(),
      failed: z.number().int(),
      spots: z.number().int(),
      music: z.number().int(),
    }),
  ),
  topAnnouncements: z.array(
    z.object({ announcementId: zId, title: z.string(), completed: z.number().int(), totalPlayedMs: z.number().int() }),
  ),
  storeBreakdown: z.array(
    z.object({
      storeId: zId,
      storeName: z.string(),
      timezone: z.string(),
      completed: z.number().int(),
      failed: z.number().int(),
      onlineDevices: z.number().int(),
      totalDevices: z.number().int(),
    }),
  ),
});
export type OverviewMetrics = z.infer<typeof zOverviewMetrics>;

export const zPlaybackReportRow = z.object({
  occurredAt: zIsoDateTime,
  localTime: z.string(),
  storeName: z.string(),
  zoneName: z.string(),
  deviceName: z.string(),
  itemType: z.string(),
  title: z.string(),
  campaignName: z.string().nullable(),
  eventType: z.string(),
  playedMs: z.number().int(),
  errorCode: z.string().nullable(),
});
export type PlaybackReportRow = z.infer<typeof zPlaybackReportRow>;

// --------------------------------------------------------------------------
// Planos, assinatura e uso
// --------------------------------------------------------------------------

export const zPlanQuotas = z.object({
  maxStores: z.number().int().positive(),
  maxDevices: z.number().int().positive(),
  maxUsers: z.number().int().positive(),
  maxStorageBytes: z.number().int().positive(),
  maxActiveCampaigns: z.number().int().positive(),
  /** Quotas de IA existem desde ja para o dia em que o provider entrar. */
  monthlyAiCopyGenerations: z.number().int().nonnegative(),
  monthlyAiTtsSeconds: z.number().int().nonnegative(),
});
export type PlanQuotas = z.infer<typeof zPlanQuotas>;

export const zPlan = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Preco e moeda vem sempre do servidor. O browser nunca os informa. */
  priceCents: zMoneyCents,
  currency: zCurrency,
  interval: z.enum(['month', 'year']),
  quotas: zPlanQuotas,
  features: z.array(z.string()),
  active: z.boolean(),
  sortOrder: z.number().int(),
});
export type Plan = z.infer<typeof zPlan>;

export const zUsageMeter = z.object({
  metric: z.enum(USAGE_METRICS),
  label: z.string(),
  used: z.number(),
  limit: z.number().nullable(),
  unit: z.enum(['count', 'bytes', 'seconds']),
  /** `used / limit`, limitado a 1. `null` quando ilimitado. */
  ratio: z.number().nullable(),
  exceeded: z.boolean(),
});
export type UsageMeter = z.infer<typeof zUsageMeter>;

export const zSubscription = z.object({
  id: zId,
  organizationId: zId,
  plan: zPlan,
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: zIsoDateTime,
  currentPeriodEnd: zIsoDateTime,
  trialEndsAt: zIsoDateTime.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  provider: z.string(),
  /** Estado do gateway. `not_configured` bloqueia checkout com motivo. */
  providerState: z.enum(INTEGRATION_STATES),
  meters: z.array(zUsageMeter),
  createdAt: zIsoDateTime,
});
export type Subscription = z.infer<typeof zSubscription>;

export const zCheckoutInput = z.object({ planCode: z.string().min(2).max(40) });

// --------------------------------------------------------------------------
// Integracoes, saude e operacao
// --------------------------------------------------------------------------

export const zIntegrationStatus = z.object({
  key: z.enum(INTEGRATION_KEYS),
  label: z.string(),
  state: z.enum(INTEGRATION_STATES),
  /** Nome do driver ativo. Nunca um valor de ambiente ou segredo. */
  driver: z.string(),
  message: z.string(),
  /** O que o operador faz para habilitar. Vazio quando ja esta configurado. */
  action: z.string().nullable(),
  /** Funcionalidades desligadas enquanto esta integracao nao existir. */
  disabledFeatures: z.array(z.string()),
});
export type IntegrationStatus = z.infer<typeof zIntegrationStatus>;

export const zHealthReport = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'degraded', 'down']),
      latencyMs: z.number().nullable(),
      detail: z.string().nullable(),
      /** `false` = dependencia opcional; nao derruba o readiness. */
      required: z.boolean(),
    }),
  ),
});
export type HealthReport = z.infer<typeof zHealthReport>;

export const zJobRecord = z.object({
  id: zId,
  queue: z.enum(JOB_QUEUES),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  organizationId: zId.nullable(),
  organizationName: z.string().nullable(),
  /** Payload minimizado: ids, nunca roteiro, token ou dado pessoal. */
  payloadSummary: z.string(),
  lastError: z.string().nullable(),
  runAt: zIsoDateTime,
  startedAt: zIsoDateTime.nullable(),
  finishedAt: zIsoDateTime.nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: zIsoDateTime,
});
export type JobRecord = z.infer<typeof zJobRecord>;

export const zNotification = z.object({
  id: zId,
  severity: z.enum(NOTIFICATION_SEVERITIES),
  title: z.string(),
  body: z.string(),
  /** Rota interna para a tela que resolve o problema. */
  href: z.string().nullable(),
  readAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});
export type Notification = z.infer<typeof zNotification>;

export const zAuditLogEntry = z.object({
  id: zId,
  actorName: z.string().nullable(),
  actorType: z.enum(['user', 'device', 'system', 'platform']),
  organizationId: zId.nullable(),
  organizationName: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  outcome: z.enum(['success', 'denied', 'error']),
  requestId: z.string().nullable(),
  /** IP truncado (/24 e /48) por minimizacao de dado pessoal. */
  ipPrefix: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: zIsoDateTime,
});
export type AuditLogEntry = z.infer<typeof zAuditLogEntry>;

export const zSupportTicketInput = z.object({
  subject: zSafeText(4, 160),
  body: zSafeText(10, 4000),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  /** Anexado automaticamente: ajuda o suporte sem expor dados do cliente. */
  diagnostics: z.record(z.string(), z.string()).optional(),
});
