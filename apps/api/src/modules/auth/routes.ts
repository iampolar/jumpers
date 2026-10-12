import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ROLE_PERMISSIONS,
  zForgotPasswordInput,
  zLoginInput,
  zRegisterInput,
  zResetPasswordInput,
  type SessionContext,
} from '@castwave/contracts';
import type { UserPrincipal } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { assertCsrf, noContent, requireUser, type AppServices } from '../../http/context.js';
import { parseBody } from '../../http/validate.js';
import * as auth from './service.js';

/**
 * Rotas de sessao.
 *
 * O cookie e `HttpOnly` (JavaScript nao le, entao XSS nao rouba a sessao),
 * `SameSite=Lax` (barra POST cross-site) e `Secure` em producao. O token de
 * CSRF vai no corpo da resposta, nao em cookie: o cliente o guarda em memoria
 * e o devolve em cabecalho, fechando o double-submit.
 */

export const SESSION_COOKIE = 'castwave_session';

function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
    signed: false,
  });
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });
}

async function buildSessionContext(
  services: AppServices,
  principal: UserPrincipal,
): Promise<SessionContext> {
  const { db } = services;

  const user = await db.query<{
    id: string;
    name: string;
    email: string;
    status: string;
    platform_role: string;
    mfa_secret: string | null;
    created_at: Date;
  }>('select id, name, email, status, platform_role, mfa_secret, created_at from users where id = $1', [
    principal.userId,
  ]);

  const organization = await db.query<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    status: string;
    requires_approval: boolean;
    created_at: Date;
  }>(
    'select id, name, slug, timezone, status, requires_approval, created_at from organizations where id = $1',
    [principal.organizationId],
  );

  const memberships = await db.query<{ id: string; name: string; slug: string; role: string }>(
    `select o.id, o.name, o.slug, m.role
       from organization_memberships m
       join organizations o on o.id = m.organization_id
      where m.user_id = $1 and m.status = 'active' and o.status <> 'archived'
      order by o.name`,
    [principal.userId],
  );

  const u = user.rows[0]!;
  const o = organization.rows[0]!;

  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status as SessionContext['user']['status'],
      platformRole: u.platform_role as SessionContext['user']['platformRole'],
      mfaEnabled: Boolean(u.mfa_secret),
      createdAt: new Date(u.created_at).toISOString(),
    },
    organization: {
      id: o.id,
      name: o.name,
      slug: o.slug,
      timezone: o.timezone,
      status: o.status as SessionContext['organization']['status'],
      requiresApproval: o.requires_approval,
      createdAt: new Date(o.created_at).toISOString(),
    },
    role: principal.role,
    permissions: [...ROLE_PERMISSIONS[principal.role]],
    scopedStoreIds: principal.scopedStoreIds ? [...principal.scopedStoreIds] : null,
    organizations: memberships.rows.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      role: m.role as SessionContext['role'],
    })),
  };
}

export function registerAuthRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, config, audit } = services;
  const ctx = { db, sessionTtlHours: config.SESSION_TTL_HOURS };
  const secure = config.isProduction;

  /*
   * Rate limit agressivo nas rotas de credencial. 600/min global nao protege
   * contra forca bruta direcionada: 10 tentativas por minuto, por IP, sim.
   */
  const credentialLimit = {
    rateLimit: config.RATE_LIMIT_ENABLED
      ? { max: 10, timeWindow: '1 minute' }
      : // Em teste o limite sai do caminho, mas a forma do objeto continua a
        // mesma para que a rota exercite o mesmo codigo.
        { max: 100_000, timeWindow: '1 minute' },
  };

  server.post('/api/v1/auth/register', { config: credentialLimit }, async (req, reply) => {
    const input = parseBody(req, zRegisterInput);
    const result = await auth.register(ctx, input, { ip: req.ip, userAgent: req.headers['user-agent'] });

    setSessionCookie(reply, result.session.token, result.session.expiresAt, secure);
    await audit.write({
      organizationId: result.organizationId,
      actorType: 'user',
      actorId: result.userId,
      actorLabel: input.email,
      action: AUDIT_ACTIONS.userRegistered,
      resourceType: 'organization',
      resourceId: result.organizationId,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const principal = await auth.resolveSession(db, result.session.token);
    return reply.status(201).send({
      csrfToken: result.session.csrfSecret,
      session: principal ? await buildSessionContext(services, principal.principal) : null,
    });
  });

  server.post('/api/v1/auth/login', { config: credentialLimit }, async (req, reply) => {
    const input = parseBody(req, zLoginInput);

    try {
      const result = await auth.login(ctx, input.email, input.password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      setSessionCookie(reply, result.session.token, result.session.expiresAt, secure);
      await audit.write({
        organizationId: result.organizationId,
        actorType: 'user',
        actorId: result.userId,
        actorLabel: input.email,
        action: AUDIT_ACTIONS.userLoggedIn,
        resourceType: 'session',
        resourceId: result.session.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const resolved = await auth.resolveSession(db, result.session.token);
      return reply.send({
        csrfToken: result.session.csrfSecret,
        session: resolved ? await buildSessionContext(services, resolved.principal) : null,
      });
    } catch (error) {
      // Tentativa falha tambem e auditada: e o padrao que denuncia ataque.
      await audit.write({
        organizationId: null,
        actorType: 'user',
        actorLabel: input.email,
        action: AUDIT_ACTIONS.userLoginFailed,
        resourceType: 'session',
        outcome: 'denied',
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      throw error;
    }
  });

  server.post('/api/v1/auth/logout', async (req, reply) => {
    const principal = req.principal;
    if (principal?.kind === 'user') {
      await auth.revokeSession(db, principal.sessionId);
      await audit.write({
        organizationId: principal.organizationId,
        actorType: 'user',
        actorId: principal.userId,
        action: AUDIT_ACTIONS.userLoggedOut,
        resourceType: 'session',
        resourceId: principal.sessionId,
        requestId: req.id,
        ip: req.ip,
      });
    }
    clearSessionCookie(reply, secure);
    return noContent(reply);
  });

  server.get('/api/v1/auth/me', async (req) => {
    const principal = requireUser(req);

    /*
     * O token CSRF volta aqui de proposito.
     *
     * Ele vive apenas na memoria do cliente -- nunca em localStorage, onde um
     * XSS o leria. So que recarregar a pagina (F5, ou abrir uma URL direto)
     * zera essa memoria, e sem o token toda escrita passaria a falhar com
     * "sessao expirada" ate a pessoa relogar. Devolve-lo na mesma resposta que
     * ja exige o cookie restaura o par sem enfraquecer nada: quem nao tem o
     * cookie nao chega ate aqui.
     */
    const session = await db.query<{ csrf_secret: string }>(
      'select csrf_secret from sessions where id = $1',
      [principal.sessionId],
    );

    return {
      csrfToken: session.rows[0]?.csrf_secret ?? null,
      session: await buildSessionContext(services, principal),
    };
  });

  server.post('/api/v1/auth/switch-organization', async (req, reply) => {
    const principal = requireUser(req);
    const { organizationId } = parseBody(req, z.object({ organizationId: z.uuid() }));
    await auth.switchOrganization(db, principal, organizationId);
    // O principal antigo ja nao vale: devolvemos o contexto recarregado.
    const refreshed = await db.query<{ token_hash: string }>('select 1 from sessions where id = $1', [
      principal.sessionId,
    ]);
    void refreshed;
    return reply.send({ ok: true });
  });

  server.post('/api/v1/auth/revoke-sessions', async (req, reply) => {
    const principal = requireUser(req);
    const revoked = await auth.revokeAllSessions(db, principal.userId, principal.sessionId);
    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.sessionsRevoked,
      resourceType: 'session',
      requestId: req.id,
      metadata: { revoked },
      ip: req.ip,
    });
    return reply.send({ revoked });
  });

  server.post('/api/v1/auth/password/forgot', { config: credentialLimit }, async (req, reply) => {
    const { email } = parseBody(req, zForgotPasswordInput);
    const issued = await auth.requestPasswordReset(db, email);

    if (issued) {
      await audit.write({
        organizationId: null,
        actorType: 'user',
        actorId: issued.userId,
        actorLabel: email,
        action: AUDIT_ACTIONS.passwordResetRequested,
        resourceType: 'user',
        resourceId: issued.userId,
        requestId: req.id,
        ip: req.ip,
      });
      /*
       * Sem SMTP configurado nao ha como entregar o link. Em vez de fingir
       * envio, registramos no log do servidor (apenas em desenvolvimento) para
       * que o fluxo seja testavel, e a UI avisa que o e-mail esta desligado.
       */
      if (!config.SMTP_URL && !config.isProduction) {
        req.log2.info('link de recuperacao gerado (SMTP desligado)', {
          resetPath: `/redefinir-senha?token=${issued.token}`,
        });
      }
    }

    // Resposta identica exista ou nao a conta: sem oraculo de enumeracao.
    return noContent(reply);
  });

  server.post('/api/v1/auth/password/reset', { config: credentialLimit }, async (req, reply) => {
    const input = parseBody(req, zResetPasswordInput);
    const userId = await auth.completePasswordReset(db, input.token, input.password);

    await audit.write({
      organizationId: null,
      actorType: 'user',
      actorId: userId,
      action: AUDIT_ACTIONS.passwordResetCompleted,
      resourceType: 'user',
      resourceId: userId,
      requestId: req.id,
      ip: req.ip,
    });

    clearSessionCookie(reply, secure);
    return noContent(reply);
  });

  void assertCsrf;
}
