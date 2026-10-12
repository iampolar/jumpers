import type { FastifyInstance } from 'fastify';
import {
  DomainError,
  zCheckoutInput,
  type IntegrationState,
  type Plan,
  type Subscription,
} from '@castwave/contracts';
import { buildMeters } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, type AppServices } from '../../http/context.js';
import { parseBody } from '../../http/validate.js';
import { loadUsage } from './usage.js';

/**
 * Planos, assinatura e consumo.
 *
 * Tudo funciona com `PAYMENTS_PROVIDER=disabled`: catalogo, limites aplicados
 * no servidor, medidores de uso, estado da assinatura e historico. A unica
 * coisa que falta e cobrar -- e o checkout recusa com motivo acionavel em vez
 * de simular sucesso.
 *
 * Preco e moeda SEMPRE vem do catalogo no servidor. O navegador nunca os
 * informa, nem para "conferencia".
 */

function mapPlan(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    priceCents: Number(row.price_cents),
    currency: row.currency as Plan['currency'],
    interval: row.interval as Plan['interval'],
    quotas: row.quotas as Plan['quotas'],
    features: (row.features as string[]) ?? [],
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order),
  };
}

export function registerBillingRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, config, audit } = services;

  /** Catalogo publico: a pagina de planos nao exige sessao. */
  server.get('/api/v1/billing/plans', async () => {
    const { rows } = await db.query(
      `select id, code, name, description, price_cents, currency, interval, quotas, features, active, sort_order
         from plans where active order by sort_order`,
    );
    return { plans: rows.map(mapPlan) };
  });

  server.get('/api/v1/billing/subscription', async (req) => {
    const principal = authorize(req, 'billing:read');
    const usage = await loadUsage(db, principal.organizationId);

    const { rows } = await db.query<Record<string, unknown>>(
      `select s.id, s.organization_id, s.status, s.current_period_start, s.current_period_end,
              s.trial_ends_at, s.cancel_at_period_end, s.provider, s.created_at,
              p.id as plan_id, p.code, p.name, p.description, p.price_cents, p.currency,
              p.interval, p.quotas, p.features, p.active, p.sort_order
         from subscriptions s join plans p on p.id = s.plan_id
        where s.organization_id = $1
        order by s.created_at desc limit 1`,
      [principal.organizationId],
    );
    const s = rows[0];
    if (!s) throw new DomainError('not_found', 'Assinatura nao encontrada.');

    const providerState: IntegrationState =
      config.PAYMENTS_PROVIDER === 'disabled' ? 'not_configured' : 'configured';

    const subscription: Subscription = {
      id: s.id as string,
      organizationId: s.organization_id as string,
      plan: mapPlan({ ...s, id: s.plan_id }),
      status: s.status as Subscription['status'],
      currentPeriodStart: new Date(s.current_period_start as string).toISOString(),
      currentPeriodEnd: new Date(s.current_period_end as string).toISOString(),
      trialEndsAt: s.trial_ends_at ? new Date(s.trial_ends_at as string).toISOString() : null,
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
      provider: s.provider as string,
      providerState,
      meters: buildMeters(usage.quotas, usage.snapshot),
      createdAt: new Date(s.created_at as string).toISOString(),
    };
    return { subscription };
  });

  server.get('/api/v1/usage', async (req) => {
    const principal = authorize(req, 'billing:read');
    const usage = await loadUsage(db, principal.organizationId);
    return {
      planCode: usage.planCode,
      planName: usage.planName,
      subscriptionStatus: usage.subscriptionStatus,
      periodStart: usage.periodStart.toISOString(),
      periodEnd: usage.periodEnd.toISOString(),
      meters: buildMeters(usage.quotas, usage.snapshot),
    };
  });

  /**
   * Checkout.
   *
   * Com o gateway desligado -- que e o padrao -- devolve 503 com codigo
   * estavel e instrucao do que fazer. Jamais 200 com um "sucesso" falso, e
   * jamais marca a assinatura como paga.
   */
  server.post('/api/v1/billing/checkout', async (req) => {
    const principal = authorize(req, 'billing:manage');
    const input = parseBody(req, zCheckoutInput);

    const plan = await db.query<{ id: string; price_cents: number; currency: string }>(
      'select id, price_cents, currency from plans where code = $1 and active',
      [input.planCode],
    );
    if (!plan.rows[0]) throw new DomainError('not_found', 'Plano nao encontrado.');

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.checkoutAttempted,
      resourceType: 'subscription',
      requestId: req.id,
      outcome: config.PAYMENTS_PROVIDER === 'disabled' ? 'denied' : 'success',
      metadata: { planCode: input.planCode, provider: config.PAYMENTS_PROVIDER },
      ip: req.ip,
    });

    if (config.PAYMENTS_PROVIDER === 'disabled') {
      throw new DomainError(
        'payments_not_configured',
        'O pagamento online ainda nao esta disponivel nesta instalacao.',
        {
          action:
            'Fale com a Jumpers para ajustar o plano. Seus limites e seu conteudo continuam funcionando normalmente.',
        },
      );
    }

    // Quando um adapter concreto existir, ele entra aqui -- recebendo preco e
    // moeda do catalogo, nunca do corpo da requisicao.
    throw new DomainError('payments_not_configured', 'Nenhum adapter de pagamento implementado.', {
      action: 'Implemente o PaymentProvider do gateway escolhido e configure PAYMENTS_PROVIDER.',
    });
  });

  /**
   * Troca de plano sem gateway.
   *
   * Existe para que a Jumpers ajuste o plano de um cliente durante a
   * implantacao. Fica auditado e nao movimenta dinheiro -- o estado de
   * cobranca continua `disabled`.
   */
  server.post('/api/v1/billing/change-plan', async (req) => {
    const principal = authorize(req, 'billing:manage');
    const input = parseBody(req, zCheckoutInput);

    if (config.PAYMENTS_PROVIDER !== 'disabled') {
      throw new DomainError('conflict', 'Com gateway conectado, a troca de plano passa pelo checkout.');
    }

    const plan = await db.query<{ id: string; name: string }>(
      'select id, name from plans where code = $1 and active',
      [input.planCode],
    );
    if (!plan.rows[0]) throw new DomainError('not_found', 'Plano nao encontrado.');

    const current = await loadUsage(db, principal.organizationId);

    const { rowCount } = await db.query(
      `update subscriptions set plan_id = $2, updated_at = now()
        where organization_id = $1
          and status in ('trialing','active','past_due','paused','incomplete')`,
      [principal.organizationId, plan.rows[0].id],
    );
    if (rowCount === 0) throw new DomainError('conflict', 'Nao ha assinatura ativa para alterar.');

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.planChanged,
      resourceType: 'subscription',
      requestId: req.id,
      metadata: { from: current.planCode, to: input.planCode, billed: false },
      ip: req.ip,
    });

    const updated = await loadUsage(db, principal.organizationId);
    return {
      planCode: updated.planCode,
      planName: updated.planName,
      meters: buildMeters(updated.quotas, updated.snapshot),
      // Explicito para nao haver duvida de que nada foi cobrado.
      billed: false,
      note: 'Plano alterado internamente. Nenhuma cobranca foi processada.',
    };
  });
}
