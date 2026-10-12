import { DomainError, type PlanQuotas, type UsageMeter, type UsageMetric } from '@castwave/contracts';

/**
 * Limites de plano.
 *
 * Aplicados no servidor, antes da escrita, mesmo sem gateway conectado -- um
 * tenant nao degrada o servico dos outros so porque a cobranca ainda nao
 * existe. A UI usa os mesmos medidores para avisar antes de o usuario esbarrar.
 */

export interface UsageSnapshot {
  readonly storesActive: number;
  readonly devicesActive: number;
  readonly users: number;
  readonly storageBytes: number;
  readonly activeCampaigns: number;
  readonly aiCopyGenerationsThisPeriod: number;
  readonly aiTtsSecondsThisPeriod: number;
}

const METER_LABELS: Record<UsageMetric, string> = {
  stores_active: 'Lojas ativas',
  devices_active: 'Players pareados',
  media_storage_bytes: 'Armazenamento de audio',
  ai_copy_generations: 'Roteiros gerados por IA',
  ai_tts_seconds: 'Locucao sintetizada',
  playback_events: 'Eventos de reproducao',
};

export function buildMeters(quotas: PlanQuotas, usage: UsageSnapshot): UsageMeter[] {
  const meter = (
    metric: UsageMetric,
    used: number,
    limit: number | null,
    unit: 'count' | 'bytes' | 'seconds',
  ): UsageMeter => ({
    metric,
    label: METER_LABELS[metric],
    used,
    limit,
    unit,
    ratio: limit && limit > 0 ? Math.min(1, used / limit) : null,
    exceeded: limit !== null && used > limit,
  });

  return [
    meter('stores_active', usage.storesActive, quotas.maxStores, 'count'),
    meter('devices_active', usage.devicesActive, quotas.maxDevices, 'count'),
    meter('media_storage_bytes', usage.storageBytes, quotas.maxStorageBytes, 'bytes'),
    meter('ai_copy_generations', usage.aiCopyGenerationsThisPeriod, quotas.monthlyAiCopyGenerations, 'count'),
    meter('ai_tts_seconds', usage.aiTtsSecondsThisPeriod, quotas.monthlyAiTtsSeconds, 'seconds'),
  ];
}

export type QuotaKey = 'stores' | 'devices' | 'users' | 'storage' | 'campaigns' | 'ai_copy' | 'ai_tts';

const QUOTA_MESSAGES: Record<QuotaKey, string> = {
  stores: 'O plano atual nao permite mais lojas.',
  devices: 'O plano atual nao permite mais players pareados.',
  users: 'O plano atual nao permite mais usuarios.',
  storage: 'O armazenamento de audio do plano foi atingido.',
  campaigns: 'O plano atual nao permite mais campanhas ativas simultaneas.',
  ai_copy: 'A cota mensal de geracao de roteiro foi atingida.',
  ai_tts: 'A cota mensal de locucao foi atingida.',
};

/**
 * Checagem antes da escrita. Lanca 403 `plan_limit_reached` com a acao
 * acionavel -- nunca um 500 generico depois de meio recurso criado.
 */
export function assertWithinQuota(
  key: QuotaKey,
  quotas: PlanQuotas,
  usage: UsageSnapshot,
  increment = 1,
): void {
  const checks: Record<QuotaKey, { used: number; limit: number }> = {
    stores: { used: usage.storesActive, limit: quotas.maxStores },
    devices: { used: usage.devicesActive, limit: quotas.maxDevices },
    users: { used: usage.users, limit: quotas.maxUsers },
    storage: { used: usage.storageBytes, limit: quotas.maxStorageBytes },
    campaigns: { used: usage.activeCampaigns, limit: quotas.maxActiveCampaigns },
    ai_copy: { used: usage.aiCopyGenerationsThisPeriod, limit: quotas.monthlyAiCopyGenerations },
    ai_tts: { used: usage.aiTtsSecondsThisPeriod, limit: quotas.monthlyAiTtsSeconds },
  };

  const { used, limit } = checks[key];
  if (used + increment > limit) {
    throw new DomainError('plan_limit_reached', QUOTA_MESSAGES[key], {
      action: 'Arquive itens que nao usa mais ou fale com a Jumpers para avaliar um plano maior.',
      logContext: { quota: key, used, limit, increment },
    });
  }
}

/** Formata bytes para a UI sem depender de Intl no servidor. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
