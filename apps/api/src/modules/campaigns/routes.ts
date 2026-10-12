import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  campaignMachine,
  DomainError,
  zCampaignActionInput,
  zCreateCampaignInput,
  type Campaign,
  type CampaignStatus,
} from '@castwave/contracts';
import { assertWithinQuota } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, created, type AppServices } from '../../http/context.js';
import { idOf, parseBody, parseQuery } from '../../http/validate.js';
import { loadUsage } from '../billing/usage.js';

/**
 * Campanhas.
 *
 * Uma campanha e uma janela de vigencia com lojas-alvo e anuncios. Ela nao
 * "empurra" conteudo: o motor de rotacao consulta a vigencia na hora de montar
 * o manifesto, e por isso conteudo vencido deixa de tocar sozinho, sem job,
 * sem clique, sem janela de atraso.
 *
 * O worker apenas atualiza o STATUS visivel no painel -- a elegibilidade real
 * ja e calculada por data em cada manifesto.
 */

async function loadCampaign(
  services: AppServices,
  organizationId: string,
  campaignId: string,
  withStats = false,
): Promise<Campaign> {
  const { db } = services;
  const { rows } = await db.query<Record<string, unknown>>(
    `select c.id, c.organization_id, c.name, c.objective, c.status, c.starts_at, c.ends_at,
            c.priority, c.max_plays_per_day_per_store, c.created_at,
            (select coalesce(array_agg(cs.store_id), '{}') from campaign_stores cs where cs.campaign_id = c.id) as store_ids,
            (select coalesce(array_agg(s.name order by s.name), '{}')
               from campaign_stores cs join stores s on s.id = cs.store_id
              where cs.campaign_id = c.id) as store_names,
            (select coalesce(array_agg(ca.announcement_id), '{}')
               from campaign_announcements ca where ca.campaign_id = c.id) as announcement_ids
       from campaigns c
      where c.id = $1 and c.organization_id = $2`,
    [campaignId, organizationId],
  );
  const c = rows[0];
  if (!c) throw new DomainError('not_found', 'Campanha nao encontrada.');

  let stats: Campaign['stats'] = null;
  if (withStats) {
    const agg = await db.query<{
      started: string;
      completed: string;
      failed: string;
      skipped: string;
      played: string;
    }>(
      `select count(*) filter (where event_type = 'started')::text   as started,
              count(*) filter (where event_type = 'completed')::text as completed,
              count(*) filter (where event_type = 'failed')::text    as failed,
              count(*) filter (where event_type = 'skipped')::text   as skipped,
              coalesce(sum(played_ms), 0)::text                      as played
         from playback_events
        where campaign_id = $1 and organization_id = $2`,
      [campaignId, organizationId],
    );
    const a = agg.rows[0]!;
    stats = {
      started: Number(a.started),
      completed: Number(a.completed),
      failed: Number(a.failed),
      skipped: Number(a.skipped),
      totalPlayedMs: Number(a.played),
    };
  }

  const status = c.status as CampaignStatus;
  const announcementIds = (c.announcement_ids as string[]) ?? [];

  return {
    id: c.id as string,
    organizationId: c.organization_id as string,
    name: c.name as string,
    objective: (c.objective as string | null) ?? null,
    status,
    startsAt: new Date(c.starts_at as string).toISOString(),
    endsAt: new Date(c.ends_at as string).toISOString(),
    storeIds: (c.store_ids as string[]) ?? [],
    storeNames: (c.store_names as string[]) ?? [],
    announcementIds,
    announcementCount: announcementIds.length,
    priority: Number(c.priority),
    maxPlaysPerDayPerStore:
      c.max_plays_per_day_per_store === null ? null : Number(c.max_plays_per_day_per_store),
    availableActions: campaignMachine.actionsFrom(status),
    stats,
    createdAt: new Date(c.created_at as string).toISOString(),
  };
}

export function registerCampaignRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  server.get('/api/v1/campaigns', async (req) => {
    const principal = authorize(req, 'campaigns:read');
    const query = parseQuery(req, z.object({ status: z.string().max(40).optional() }));

    const { rows } = await db.query<{ id: string }>(
      `select id from campaigns
        where organization_id = $1 and ($2::text is null or status = $2::text)
        order by starts_at desc limit 300`,
      [principal.organizationId, query.status ?? null],
    );
    const campaigns = await Promise.all(
      rows.map((r) => loadCampaign(services, principal.organizationId, r.id)),
    );
    return { campaigns };
  });

  server.get('/api/v1/campaigns/:id', async (req) => {
    const principal = authorize(req, 'campaigns:read');
    return { campaign: await loadCampaign(services, principal.organizationId, idOf(req), true) };
  });

  server.get('/api/v1/campaigns/:id/report', async (req) => {
    const principal = authorize(req, 'analytics:read');
    const campaign = await loadCampaign(services, principal.organizationId, idOf(req), true);

    const byStore = await db.query<{ store_name: string; completed: string; failed: string }>(
      `select s.name as store_name,
              count(*) filter (where e.event_type = 'completed')::text as completed,
              count(*) filter (where e.event_type = 'failed')::text    as failed
         from playback_events e join stores s on s.id = e.store_id
        where e.campaign_id = $1 and e.organization_id = $2
        group by s.name order by s.name`,
      [campaign.id, principal.organizationId],
    );

    return {
      campaign,
      byStore: byStore.rows.map((r) => ({
        storeName: r.store_name,
        completed: Number(r.completed),
        failed: Number(r.failed),
      })),
      // O relatorio conta execucoes, nao audiencia. Dizer o contrario seria
      // prometer atribuicao que o produto nao mede.
      disclaimer:
        'Os numeros refletem execucoes confirmadas pelos players, nao quantas pessoas ouviram.',
    };
  });

  server.post('/api/v1/campaigns', async (req, reply) => {
    const principal = authorize(req, 'campaigns:write');
    const input = parseBody(req, zCreateCampaignInput);

    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('campaigns', usage.quotas, usage.snapshot);

    const stores = await db.query(
      "select 1 from stores where organization_id = $1 and id = any($2::uuid[]) and status <> 'archived'",
      [principal.organizationId, input.storeIds],
    );
    if (stores.rowCount !== input.storeIds.length) {
      throw new DomainError('validation_failed', 'Uma ou mais lojas informadas nao existem.');
    }

    if (input.announcementIds.length > 0) {
      const anns = await db.query(
        'select 1 from announcements where organization_id = $1 and id = any($2::uuid[])',
        [principal.organizationId, input.announcementIds],
      );
      if (anns.rowCount !== input.announcementIds.length) {
        throw new DomainError('validation_failed', 'Um ou mais anuncios informados nao existem.');
      }
    }

    const campaignId = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into campaigns
           (organization_id, name, objective, starts_at, ends_at, priority, max_plays_per_day_per_store, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          principal.organizationId,
          input.name,
          input.objective ?? null,
          input.startsAt,
          input.endsAt,
          input.priority,
          input.maxPlaysPerDayPerStore ?? null,
          principal.userId,
        ],
      );
      const id = rows[0]!.id;

      for (const storeId of input.storeIds) {
        await tx.query(
          'insert into campaign_stores (campaign_id, store_id, organization_id) values ($1,$2,$3)',
          [id, storeId, principal.organizationId],
        );
      }
      for (const announcementId of input.announcementIds) {
        await tx.query(
          `insert into campaign_announcements (campaign_id, announcement_id, organization_id, priority)
           values ($1,$2,$3,$4)`,
          [id, announcementId, principal.organizationId, input.priority],
        );
      }
      return id;
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.campaignTransitioned,
      resourceType: 'campaign',
      resourceId: campaignId,
      requestId: req.id,
      metadata: { created: true, stores: input.storeIds.length, announcements: input.announcementIds.length },
      ip: req.ip,
    });

    return created(reply, { campaign: await loadCampaign(services, principal.organizationId, campaignId) });
  });

  server.patch('/api/v1/campaigns/:id', async (req) => {
    const principal = authorize(req, 'campaigns:write');
    const campaignId = idOf(req);
    const input = parseBody(req, zCreateCampaignInput.partial());

    const current = await loadCampaign(services, principal.organizationId, campaignId);
    if (campaignMachine.isTerminal(current.status)) {
      throw new DomainError('invalid_state_transition', 'Campanha encerrada nao pode ser editada.');
    }

    await db.transaction(async (tx) => {
      await tx.query(
        `update campaigns set
           name      = coalesce($3, name),
           objective = coalesce($4, objective),
           starts_at = coalesce($5, starts_at),
           ends_at   = coalesce($6, ends_at),
           priority  = coalesce($7, priority),
           max_plays_per_day_per_store = coalesce($8, max_plays_per_day_per_store),
           updated_at = now()
         where id = $1 and organization_id = $2`,
        [
          campaignId,
          principal.organizationId,
          input.name ?? null,
          input.objective ?? null,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.priority ?? null,
          input.maxPlaysPerDayPerStore ?? null,
        ],
      );

      if (input.storeIds) {
        const valid = await tx.query(
          'select 1 from stores where organization_id = $1 and id = any($2::uuid[])',
          [principal.organizationId, input.storeIds],
        );
        if (valid.rowCount !== input.storeIds.length) {
          throw new DomainError('validation_failed', 'Uma ou mais lojas informadas nao existem.');
        }
        await tx.query('delete from campaign_stores where campaign_id = $1', [campaignId]);
        for (const storeId of input.storeIds) {
          await tx.query(
            'insert into campaign_stores (campaign_id, store_id, organization_id) values ($1,$2,$3)',
            [campaignId, storeId, principal.organizationId],
          );
        }
      }

      if (input.announcementIds) {
        const valid = await tx.query(
          'select 1 from announcements where organization_id = $1 and id = any($2::uuid[])',
          [principal.organizationId, input.announcementIds],
        );
        if (valid.rowCount !== input.announcementIds.length) {
          throw new DomainError('validation_failed', 'Um ou mais anuncios informados nao existem.');
        }
        await tx.query('delete from campaign_announcements where campaign_id = $1', [campaignId]);
        for (const announcementId of input.announcementIds) {
          await tx.query(
            `insert into campaign_announcements (campaign_id, announcement_id, organization_id, priority)
             values ($1,$2,$3,$4)`,
            [campaignId, announcementId, principal.organizationId, input.priority ?? current.priority],
          );
        }
      }
    });

    return { campaign: await loadCampaign(services, principal.organizationId, campaignId) };
  });

  /** Transicao por acao, validada pela maquina de estados. */
  server.post('/api/v1/campaigns/:id/actions', async (req) => {
    const principal = authorize(req, 'campaigns:write');
    const campaignId = idOf(req);
    const { action } = parseBody(req, zCampaignActionInput);

    const current = await loadCampaign(services, principal.organizationId, campaignId);
    const nextStatus = campaignMachine.apply(current.status, action);

    await db.query(
      'update campaigns set status = $3, updated_at = now() where id = $1 and organization_id = $2',
      [campaignId, principal.organizationId, nextStatus],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.campaignTransitioned,
      resourceType: 'campaign',
      resourceId: campaignId,
      requestId: req.id,
      metadata: { from: current.status, to: nextStatus, operation: action },
      ip: req.ip,
    });

    return { campaign: await loadCampaign(services, principal.organizationId, campaignId) };
  });
}
