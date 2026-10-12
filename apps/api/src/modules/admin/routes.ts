import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, type AuditLogEntry, type JobRecord } from '@castwave/contracts';
import { AUDIT_ACTIONS } from '../../audit';
import { authorize, authorizePlatform, type AppServices } from '../../http/context';
import { idOf, parseQuery } from '../../http/validate';
import { describeIntegrations } from '../../health';

/**
 * Painel Jumpers.
 *
 * Area de operacao, separada por prefixo, guard e layout. Para um cliente ela
 * simplesmente NAO EXISTE: `requirePlatformRole` responde 404, nao 403, de
 * modo que nem a existencia das rotas vaza.
 *
 * O que a Jumpers ve aqui e metadado operacional -- contagens, estados de
 * job, saude. Conteudo do cliente (roteiro, audio, relatorio comercial) nao
 * aparece: suporte legitimo nao precisa disso, e acesso excepcional exigiria
 * um fluxo proprio com motivo registrado.
 */

export function registerAdminRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, config, audit } = services;

  server.get('/api/v1/jumpers/overview', async (req) => {
    const principal = authorizePlatform(req, 'support');

    const counts = await db.query<Record<string, string>>(
      `select
         (select count(*) from organizations where status = 'active')::text  as orgs_active,
         (select count(*) from organizations where status = 'suspended')::text as orgs_suspended,
         (select count(*) from users where status = 'active')::text           as users_active,
         (select count(*) from stores where status <> 'archived')::text       as stores,
         (select count(*) from player_devices where status = 'active')::text  as devices_online,
         (select count(*) from player_devices where status = 'offline')::text as devices_offline,
         (select count(*) from jobs where status = 'pending')::text           as jobs_pending,
         (select count(*) from jobs where status = 'failed')::text            as jobs_failed,
         (select count(*) from jobs where status = 'dead')::text              as jobs_dead,
         (select count(*) from media_assets where status = 'failed')::text    as media_failed,
         (select count(*) from support_tickets where status in ('open','pending'))::text as tickets_open,
         (select count(*) from payment_webhook_events where signature_valid = false)::text as webhooks_invalid`,
    );

    await audit.write({
      organizationId: null,
      actorType: 'platform',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.platformAccessed,
      resourceType: 'platform_overview',
      requestId: req.id,
      ip: req.ip,
    });

    const c = counts.rows[0]!;
    return {
      organizations: { active: Number(c.orgs_active), suspended: Number(c.orgs_suspended) },
      users: { active: Number(c.users_active) },
      stores: Number(c.stores),
      devices: { online: Number(c.devices_online), offline: Number(c.devices_offline) },
      jobs: { pending: Number(c.jobs_pending), failed: Number(c.jobs_failed), dead: Number(c.jobs_dead) },
      media: { failed: Number(c.media_failed) },
      support: { open: Number(c.tickets_open) },
      webhooks: { invalidSignatures: Number(c.webhooks_invalid) },
      integrations: describeIntegrations(config),
    };
  });

  server.get('/api/v1/jumpers/organizations', async (req) => {
    authorizePlatform(req, 'support');
    const q = parseQuery(req, z.object({ search: z.string().trim().max(120).optional() }));

    const { rows } = await db.query<Record<string, unknown>>(
      `select o.id, o.name, o.slug, o.status, o.timezone, o.created_at,
              p.code as plan_code, s.status as subscription_status,
              (select count(*) from stores st where st.organization_id = o.id and st.status <> 'archived') as stores,
              (select count(*) from player_devices d where d.organization_id = o.id and d.status <> 'revoked') as devices,
              (select count(*) from organization_memberships m where m.organization_id = o.id) as members,
              (select coalesce(sum(size_bytes),0) from media_assets m where m.organization_id = o.id) as storage_bytes
         from organizations o
         left join subscriptions s on s.organization_id = o.id
              and s.status in ('trialing','active','past_due','paused','incomplete')
         left join plans p on p.id = s.plan_id
        where ($1::text is null or o.name ilike '%' || $1::text || '%' or o.slug ilike '%' || $1::text || '%')
        order by o.created_at desc limit 200`,
      [q.search ?? null],
    );

    return {
      organizations: rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        slug: r.slug as string,
        status: r.status as string,
        timezone: r.timezone as string,
        planCode: (r.plan_code as string | null) ?? null,
        subscriptionStatus: (r.subscription_status as string | null) ?? null,
        stores: Number(r.stores),
        devices: Number(r.devices),
        members: Number(r.members),
        storageBytes: Number(r.storage_bytes),
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
    };
  });

  /** Fila de jobs. Payload aparece resumido, nunca inteiro. */
  server.get('/api/v1/jumpers/jobs', async (req) => {
    authorizePlatform(req, 'support');
    const q = parseQuery(
      req,
      z.object({
        status: z.enum(['pending', 'running', 'completed', 'failed', 'dead']).optional(),
        queue: z.string().max(40).optional(),
      }),
    );

    const { rows } = await db.query<Record<string, unknown>>(
      `select j.id, j.queue, j.status, j.attempts, j.max_attempts, j.organization_id,
              j.payload, j.last_error, j.run_at, j.started_at, j.finished_at, j.duration_ms, j.created_at,
              o.name as organization_name
         from jobs j left join organizations o on o.id = j.organization_id
        where ($1::text is null or j.status = $1::text)
          and ($2::text is null or j.queue = $2::text)
        order by j.created_at desc limit 200`,
      [q.status ?? null, q.queue ?? null],
    );

    const jobs: JobRecord[] = rows.map((r) => ({
      id: r.id as string,
      queue: r.queue as JobRecord['queue'],
      status: r.status as JobRecord['status'],
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      organizationId: (r.organization_id as string | null) ?? null,
      organizationName: (r.organization_name as string | null) ?? null,
      // Resumo com as CHAVES do payload, nao os valores: ids bastam para
      // diagnosticar, e nenhum dado do cliente vaza para a tela de operacao.
      payloadSummary: Object.keys((r.payload as Record<string, unknown>) ?? {}).join(', ') || '(vazio)',
      lastError: (r.last_error as string | null) ?? null,
      runAt: new Date(r.run_at as string).toISOString(),
      startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
      finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
    return { jobs };
  });

  /** Reprocessamento auditado de job morto. */
  server.post('/api/v1/jumpers/jobs/:id/requeue', async (req) => {
    const principal = authorizePlatform(req, 'superadmin');
    const jobId = idOf(req);

    const { rowCount } = await db.query(
      `update jobs set status = 'pending', attempts = 0, run_at = now(),
              locked_at = null, locked_by = null, lock_expires_at = null, last_error = null
        where id = $1 and status in ('failed','dead')`,
      [jobId],
    );
    if (rowCount === 0) {
      throw new DomainError('conflict', 'Apenas jobs com falha podem ser reprocessados.');
    }

    await audit.write({
      organizationId: null,
      actorType: 'platform',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.jobRequeued,
      resourceType: 'job',
      resourceId: jobId,
      requestId: req.id,
      ip: req.ip,
    });

    return { requeued: true };
  });

  server.get('/api/v1/jumpers/audit', async (req) => {
    authorizePlatform(req, 'support');
    const q = parseQuery(
      req,
      z.object({
        organizationId: z.uuid().optional(),
        action: z.string().max(60).optional(),
        outcome: z.enum(['success', 'denied', 'error']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    );

    const { rows } = await db.query<Record<string, unknown>>(
      `select a.id, a.actor_type, a.actor_label, a.organization_id, a.action, a.resource_type,
              a.resource_id, a.outcome, a.request_id, a.ip_prefix, a.reason, a.created_at,
              o.name as organization_name
         from audit_logs a left join organizations o on o.id = a.organization_id
        where ($1::uuid is null or a.organization_id = $1::uuid)
          and ($2::text is null or a.action = $2::text)
          and ($3::text is null or a.outcome = $3::text)
        order by a.created_at desc limit $4`,
      [q.organizationId ?? null, q.action ?? null, q.outcome ?? null, q.limit],
    );

    const entries: AuditLogEntry[] = rows.map((r) => ({
      id: r.id as string,
      actorName: (r.actor_label as string | null) ?? null,
      actorType: r.actor_type as AuditLogEntry['actorType'],
      organizationId: (r.organization_id as string | null) ?? null,
      organizationName: (r.organization_name as string | null) ?? null,
      action: r.action as string,
      resourceType: r.resource_type as string,
      resourceId: (r.resource_id as string | null) ?? null,
      outcome: r.outcome as AuditLogEntry['outcome'],
      requestId: (r.request_id as string | null) ?? null,
      ipPrefix: (r.ip_prefix as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
    return { entries };
  });

  /** Auditoria da propria organizacao, para o owner. Escopo garantido no SQL. */
  server.get('/api/v1/audit', async (req) => {
    const principal = authorize(req, 'audit:read');
    const q = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }));

    const { rows } = await db.query<Record<string, unknown>>(
      `select id, actor_type, actor_label, action, resource_type, resource_id, outcome,
              request_id, ip_prefix, reason, created_at
         from audit_logs where organization_id = $1
        order by created_at desc limit $2`,
      [principal.organizationId, q.limit],
    );

    return {
      entries: rows.map((r) => ({
        id: r.id as string,
        actorName: (r.actor_label as string | null) ?? null,
        actorType: r.actor_type as string,
        action: r.action as string,
        resourceType: r.resource_type as string,
        resourceId: (r.resource_id as string | null) ?? null,
        outcome: r.outcome as string,
        ipPrefix: (r.ip_prefix as string | null) ?? null,
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
    };
  });
}
