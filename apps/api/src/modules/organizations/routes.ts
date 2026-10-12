import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  slugify,
  zInviteMemberInput,
  zUpdateMemberInput,
  zUpdateOrganizationInput,
  type Membership,
  type OrganizationRole,
} from '@castwave/contracts';
import { hashPassword, hashToken, randomToken } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, created, noContent, requireUser, type AppServices } from '../../http/context.js';
import { idOf, parseBody } from '../../http/validate.js';

/**
 * Organizacao e equipe.
 *
 * Duas invariantes que o codigo protege explicitamente:
 *  1. uma organizacao nunca fica sem owner ativo -- rebaixar ou remover o
 *     ultimo e recusado, senao a conta vira orfa e so o suporte resolve;
 *  2. ninguem eleva o proprio papel: alterar a si mesmo e bloqueado na rota.
 */

async function countActiveOwners(
  services: AppServices,
  organizationId: string,
  excludeUserId?: string,
): Promise<number> {
  const { rows } = await services.db.query<{ n: string }>(
    `select count(*)::text as n from organization_memberships
      where organization_id = $1 and role = 'owner' and status = 'active'
        and ($2::uuid is null or user_id <> $2::uuid)`,
    [organizationId, excludeUserId ?? null],
  );
  return Number(rows[0]!.n);
}

function mapMembership(row: {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  store_ids: string[] | null;
  last_seen_at: Date | null;
  created_at: Date;
}): Membership {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role as Membership['role'],
    status: row.status as Membership['status'],
    storeIds: row.store_ids ?? [],
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function registerOrganizationRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  // -------------------------------------------------------------------------
  // Organizacao
  // -------------------------------------------------------------------------

  server.get('/api/v1/organization', async (req) => {
    const principal = authorize(req, 'org:read');
    const { rows } = await db.query(
      `select id, name, slug, timezone, status, requires_approval, created_at
         from organizations where id = $1`,
      [principal.organizationId],
    );
    const o = rows[0];
    if (!o) throw new DomainError('not_found', 'Organizacao nao encontrada.');
    return {
      organization: {
        id: o.id,
        name: o.name,
        slug: o.slug,
        timezone: o.timezone,
        status: o.status,
        requiresApproval: o.requires_approval,
        createdAt: new Date(o.created_at as string).toISOString(),
      },
    };
  });

  server.patch('/api/v1/organization', async (req) => {
    const principal = authorize(req, 'org:update');
    const input = parseBody(req, zUpdateOrganizationInput);

    if (input.slug) {
      const taken = await db.query('select 1 from organizations where slug = $1 and id <> $2', [
        input.slug,
        principal.organizationId,
      ]);
      if (taken.rowCount > 0) {
        throw new DomainError('already_exists', 'Este identificador ja esta em uso.');
      }
    }

    const { rows } = await db.query(
      `update organizations set
          name              = coalesce($2, name),
          slug              = coalesce($3, slug),
          timezone          = coalesce($4, timezone),
          requires_approval = coalesce($5, requires_approval),
          updated_at        = now()
        where id = $1
        returning id, name, slug, timezone, status, requires_approval, created_at`,
      [
        principal.organizationId,
        input.name ?? null,
        input.slug ?? null,
        input.timezone ?? null,
        input.requiresApproval ?? null,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.organizationUpdated,
      resourceType: 'organization',
      resourceId: principal.organizationId,
      requestId: req.id,
      metadata: { fields: Object.keys(input) },
      ip: req.ip,
    });

    const o = rows[0]!;
    return {
      organization: {
        id: o.id,
        name: o.name,
        slug: o.slug,
        timezone: o.timezone,
        status: o.status,
        requiresApproval: o.requires_approval,
        createdAt: new Date(o.created_at as string).toISOString(),
      },
    };
  });

  // -------------------------------------------------------------------------
  // Equipe
  // -------------------------------------------------------------------------

  server.get('/api/v1/members', async (req) => {
    const principal = authorize(req, 'members:read');
    const { rows } = await db.query<Parameters<typeof mapMembership>[0]>(
      `select m.id, m.user_id, u.name, u.email, m.role, m.status, u.last_login_at as last_seen_at, m.created_at,
              (select array_agg(sm.store_id) from store_memberships sm
                where sm.user_id = m.user_id and sm.organization_id = m.organization_id) as store_ids
         from organization_memberships m
         join users u on u.id = m.user_id
        where m.organization_id = $1
        order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name`,
      [principal.organizationId],
    );
    return { members: rows.map(mapMembership) };
  });

  server.post('/api/v1/members', async (req, reply) => {
    const principal = authorize(req, 'members:manage');
    const input = parseBody(req, zInviteMemberInput);

    if (input.role === 'owner' && principal.role !== 'owner') {
      throw new DomainError('forbidden', 'Apenas um proprietario pode promover outro proprietario.');
    }

    // Lojas informadas precisam ser desta organizacao -- nunca confiamos no id
    // que veio do navegador.
    if (input.storeIds.length > 0) {
      const { rowCount } = await db.query(
        'select 1 from stores where organization_id = $1 and id = any($2::uuid[])',
        [principal.organizationId, input.storeIds],
      );
      if (rowCount !== input.storeIds.length) {
        throw new DomainError('validation_failed', 'Uma ou mais lojas informadas nao existem.');
      }
    }

    const result = await db.transaction(async (tx) => {
      const existingUser = await tx.query<{ id: string }>('select id from users where email = $1', [
        input.email,
      ]);

      let userId = existingUser.rows[0]?.id;
      if (!userId) {
        /*
         * Convidado sem conta recebe um usuario com senha aleatoria que
         * ninguem conhece -- nem o convidante. O acesso so acontece pelo
         * fluxo de definicao de senha, com token proprio.
         */
        const placeholder = await hashPassword(randomToken(32));
        userId = (
          await tx.query<{ id: string }>(
            'insert into users (name, email, password_hash) values ($1,$2,$3) returning id',
            [input.name, input.email, placeholder],
          )
        ).rows[0]!.id;
      }

      const already = await tx.query('select 1 from organization_memberships where organization_id = $1 and user_id = $2', [
        principal.organizationId,
        userId,
      ]);
      if (already.rowCount > 0) {
        throw new DomainError('already_exists', 'Esta pessoa ja faz parte da equipe.');
      }

      const inviteToken = randomToken(32);
      const membershipId = (
        await tx.query<{ id: string }>(
          `insert into organization_memberships
             (organization_id, user_id, role, status, invited_by, invite_token_hash, invite_expires_at)
           values ($1,$2,$3,'invited',$4,$5, now() + interval '7 days') returning id`,
          [principal.organizationId, userId, input.role, principal.userId, hashToken(inviteToken)],
        )
      ).rows[0]!.id;

      for (const storeId of input.storeIds) {
        await tx.query(
          'insert into store_memberships (organization_id, user_id, store_id) values ($1,$2,$3)',
          [principal.organizationId, userId, storeId],
        );
      }

      await tx.query(
        `insert into notifications (organization_id, user_id, severity, title, body, href)
         values ($1,$2,'info','Convite enviado',$3,'/equipe')`,
        [
          principal.organizationId,
          userId,
          `Voce foi convidado para ${input.role === 'owner' ? 'administrar' : 'participar da'} equipe.`,
        ],
      );

      return { userId, membershipId, inviteToken };
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.memberInvited,
      resourceType: 'membership',
      resourceId: result.membershipId,
      requestId: req.id,
      metadata: { role: input.role, scopedStores: input.storeIds.length },
      ip: req.ip,
    });

    const { rows } = await db.query<Parameters<typeof mapMembership>[0]>(
      `select m.id, m.user_id, u.name, u.email, m.role, m.status, u.last_login_at as last_seen_at, m.created_at,
              (select array_agg(sm.store_id) from store_memberships sm
                where sm.user_id = m.user_id and sm.organization_id = m.organization_id) as store_ids
         from organization_memberships m join users u on u.id = m.user_id
        where m.id = $1`,
      [result.membershipId],
    );

    return created(reply, {
      member: mapMembership(rows[0]!),
      // Sem SMTP o convite nao sai por e-mail; o painel mostra o link para o
      // administrador copiar. Nunca fingimos envio.
      inviteToken: services.config.SMTP_URL ? null : result.inviteToken,
      emailDelivered: Boolean(services.config.SMTP_URL),
    });
  });

  server.patch('/api/v1/members/:id', async (req) => {
    const principal = authorize(req, 'members:manage');
    const membershipId = idOf(req);
    const input = parseBody(req, zUpdateMemberInput);

    const current = await db.query<{ user_id: string; role: OrganizationRole }>(
      'select user_id, role from organization_memberships where id = $1 and organization_id = $2',
      [membershipId, principal.organizationId],
    );
    const member = current.rows[0];
    if (!member) throw new DomainError('not_found', 'Membro nao encontrado.');

    if (member.user_id === principal.userId) {
      // Sem autopromocao e sem se trancar para fora por engano.
      throw new DomainError('forbidden', 'Voce nao pode alterar o proprio acesso.');
    }
    if (input.role === 'owner' && principal.role !== 'owner') {
      throw new DomainError('forbidden', 'Apenas um proprietario pode promover outro proprietario.');
    }

    const losingOwner =
      member.role === 'owner' && ((input.role && input.role !== 'owner') || input.status === 'suspended');
    if (losingOwner && (await countActiveOwners(services, principal.organizationId, member.user_id)) === 0) {
      throw new DomainError('conflict', 'A organizacao precisa de ao menos um proprietario ativo.', {
        action: 'Promova outra pessoa a proprietario antes de alterar esta.',
      });
    }

    await db.transaction(async (tx) => {
      await tx.query(
        `update organization_memberships
            set role = coalesce($3, role), status = coalesce($4, status), updated_at = now()
          where id = $1 and organization_id = $2`,
        [membershipId, principal.organizationId, input.role ?? null, input.status ?? null],
      );

      if (input.storeIds) {
        const valid = await tx.query(
          'select 1 from stores where organization_id = $1 and id = any($2::uuid[])',
          [principal.organizationId, input.storeIds],
        );
        if (valid.rowCount !== input.storeIds.length) {
          throw new DomainError('validation_failed', 'Uma ou mais lojas informadas nao existem.');
        }
        await tx.query('delete from store_memberships where user_id = $1 and organization_id = $2', [
          member.user_id,
          principal.organizationId,
        ]);
        for (const storeId of input.storeIds) {
          await tx.query(
            'insert into store_memberships (organization_id, user_id, store_id) values ($1,$2,$3)',
            [principal.organizationId, member.user_id, storeId],
          );
        }
      }

      // Mudanca de papel ou suspensao derruba a sessao: o novo escopo passa a
      // valer imediatamente, nao no proximo login.
      if (input.role || input.status) {
        await tx.query(
          `update sessions set revoked_at = now()
            where user_id = $1 and organization_id = $2 and revoked_at is null`,
          [member.user_id, principal.organizationId],
        );
      }
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.memberUpdated,
      resourceType: 'membership',
      resourceId: membershipId,
      requestId: req.id,
      metadata: { fields: Object.keys(input), targetUserId: member.user_id },
      ip: req.ip,
    });

    return { ok: true };
  });

  server.delete('/api/v1/members/:id', async (req, reply) => {
    const principal = authorize(req, 'members:manage');
    const membershipId = idOf(req);

    const current = await db.query<{ user_id: string; role: OrganizationRole }>(
      'select user_id, role from organization_memberships where id = $1 and organization_id = $2',
      [membershipId, principal.organizationId],
    );
    const member = current.rows[0];
    if (!member) throw new DomainError('not_found', 'Membro nao encontrado.');

    if (member.user_id === principal.userId) {
      throw new DomainError('forbidden', 'Voce nao pode remover a si mesmo.');
    }
    if (
      member.role === 'owner' &&
      (await countActiveOwners(services, principal.organizationId, member.user_id)) === 0
    ) {
      throw new DomainError('conflict', 'A organizacao precisa de ao menos um proprietario ativo.');
    }

    await db.transaction(async (tx) => {
      await tx.query('delete from organization_memberships where id = $1 and organization_id = $2', [
        membershipId,
        principal.organizationId,
      ]);
      await tx.query('delete from store_memberships where user_id = $1 and organization_id = $2', [
        member.user_id,
        principal.organizationId,
      ]);
      await tx.query(
        `update sessions set revoked_at = now()
          where user_id = $1 and organization_id = $2 and revoked_at is null`,
        [member.user_id, principal.organizationId],
      );
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.memberRemoved,
      resourceType: 'membership',
      resourceId: membershipId,
      requestId: req.id,
      metadata: { targetUserId: member.user_id, role: member.role },
      ip: req.ip,
    });

    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // Notificacoes internas
  // -------------------------------------------------------------------------

  server.get('/api/v1/notifications', async (req) => {
    const principal = requireUser(req);
    const { rows } = await db.query(
      `select id, severity, title, body, href, read_at, created_at
         from notifications
        where organization_id = $1 and (user_id is null or user_id = $2)
        order by created_at desc limit 50`,
      [principal.organizationId, principal.userId],
    );
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        severity: n.severity,
        title: n.title,
        body: n.body,
        href: n.href,
        readAt: n.read_at ? new Date(n.read_at as string).toISOString() : null,
        createdAt: new Date(n.created_at as string).toISOString(),
      })),
    };
  });

  server.patch('/api/v1/notifications/:id/read', async (req) => {
    const principal = requireUser(req);
    const { rowCount } = await db.query(
      `update notifications set read_at = now()
        where id = $1 and organization_id = $2 and (user_id is null or user_id = $3) and read_at is null`,
      [idOf(req), principal.organizationId, principal.userId],
    );
    // rowCount 0 tambem cobre "notificacao de outra organizacao": 404 sem
    // revelar que ela existe.
    if (rowCount === 0) {
      const exists = await db.query(
        'select 1 from notifications where id = $1 and organization_id = $2',
        [idOf(req), principal.organizationId],
      );
      if (exists.rowCount === 0) throw new DomainError('not_found', 'Notificacao nao encontrada.');
    }
    return { ok: true };
  });

  void z;
  void slugify;
}
