import { DomainError, type PlanQuotas } from '@castwave/contracts';
import type { UsageSnapshot } from '@castwave/core';
import type { SqlClient } from '@castwave/db';

/**
 * Consumo atual da organizacao.
 *
 * Medido a partir do estado real (contagem de lojas, players, bytes), nao de
 * um contador incremental que pode divergir. O `usage_ledger` guarda apenas o
 * que e cumulativo por periodo e nao da para recontar -- geracoes de IA, por
 * exemplo.
 */

export interface OrganizationUsage {
  readonly planCode: string;
  readonly planName: string;
  readonly quotas: PlanQuotas;
  readonly snapshot: UsageSnapshot;
  readonly subscriptionStatus: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export async function loadUsage(db: SqlClient, organizationId: string): Promise<OrganizationUsage> {
  const { rows } = await db.query<{
    code: string;
    name: string;
    quotas: PlanQuotas;
    status: string;
    current_period_start: Date;
    current_period_end: Date;
  }>(
    `select p.code, p.name, p.quotas, s.status, s.current_period_start, s.current_period_end
       from subscriptions s
       join plans p on p.id = s.plan_id
      where s.organization_id = $1
        and s.status in ('trialing','active','past_due','paused','incomplete')
      order by s.created_at desc
      limit 1`,
    [organizationId],
  );

  const subscription = rows[0];
  if (!subscription) {
    throw new DomainError('conflict', 'Esta organizacao nao tem uma assinatura ativa.', {
      action: 'Fale com a Jumpers para reativar a conta.',
      logContext: { organizationId },
    });
  }

  const counts = await db.query<{
    stores: string;
    devices: string;
    users: string;
    storage_bytes: string;
    campaigns: string;
    ai_copy: string;
    ai_tts: string;
  }>(
    `select
       (select count(*) from stores         where organization_id = $1 and status <> 'archived')::text as stores,
       (select count(*) from player_devices where organization_id = $1 and status <> 'revoked')::text  as devices,
       (select count(*) from organization_memberships where organization_id = $1 and status <> 'suspended')::text as users,
       (select coalesce(sum(size_bytes),0) from media_assets where organization_id = $1 and status <> 'archived')::text as storage_bytes,
       (select count(*) from campaigns      where organization_id = $1 and status in ('scheduled','running'))::text as campaigns,
       (select coalesce(sum(quantity),0) from usage_ledger
          where organization_id = $1 and metric = 'ai_copy_generations' and period_start >= $2)::text as ai_copy,
       (select coalesce(sum(quantity),0) from usage_ledger
          where organization_id = $1 and metric = 'ai_tts_seconds' and period_start >= $2)::text as ai_tts`,
    [organizationId, subscription.current_period_start],
  );

  const c = counts.rows[0]!;
  return {
    planCode: subscription.code,
    planName: subscription.name,
    quotas: subscription.quotas,
    subscriptionStatus: subscription.status,
    periodStart: new Date(subscription.current_period_start),
    periodEnd: new Date(subscription.current_period_end),
    snapshot: {
      storesActive: Number(c.stores),
      devicesActive: Number(c.devices),
      users: Number(c.users),
      storageBytes: Number(c.storage_bytes),
      activeCampaigns: Number(c.campaigns),
      aiCopyGenerationsThisPeriod: Number(c.ai_copy),
      aiTtsSecondsThisPeriod: Number(c.ai_tts),
    },
  };
}

/**
 * Registra consumo cumulativo de forma idempotente.
 *
 * A chave impede que um retry de job contabilize duas vezes -- o caso que,
 * com IA conectada, viraria cobranca dobrada.
 */
export async function recordUsage(
  db: SqlClient,
  input: {
    organizationId: string;
    metric: 'ai_copy_generations' | 'ai_tts_seconds' | 'playback_events';
    quantity: number;
    periodStart: Date;
    source: string;
    idempotencyKey: string;
  },
): Promise<{ recorded: boolean }> {
  const { rowCount } = await db.query(
    `insert into usage_ledger (organization_id, metric, quantity, period_start, source, idempotency_key)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (organization_id, metric, idempotency_key) do nothing`,
    [
      input.organizationId,
      input.metric,
      input.quantity,
      input.periodStart,
      input.source,
      input.idempotencyKey,
    ],
  );
  return { recorded: rowCount > 0 };
}
