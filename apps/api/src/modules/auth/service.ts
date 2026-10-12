import {
  DomainError,
  slugify,
  type OrganizationRole,
  type PlatformRole,
  type RegisterInput,
} from '@castwave/contracts';
import {
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  truncateIp,
  verifyPassword,
  type UserPrincipal,
} from '@castwave/core';
import type { SqlClient } from '@castwave/db';

/**
 * Autenticacao e sessao.
 *
 * Decisoes que valem registro:
 *
 *  - **Sessao opaca em banco, nao JWT.** Revogar um JWT exige uma lista de
 *    bloqueio, que e justamente o banco que o JWT prometia evitar. Aqui
 *    "desconectar todos os dispositivos" e um UPDATE, e tem efeito imediato.
 *  - **Token so em hash.** Um dump do banco nao permite se passar por ninguem.
 *  - **Resposta uniforme no login.** Usuario inexistente e senha errada
 *    produzem a mesma mensagem e custo de tempo parecido: nao entregamos um
 *    oraculo de "este e-mail tem conta aqui".
 */

const SESSION_BYTES = 32;

export interface SessionRecord {
  readonly id: string;
  readonly token: string;
  readonly csrfSecret: string;
  readonly expiresAt: Date;
}

export interface AuthContext {
  readonly db: SqlClient;
  readonly sessionTtlHours: number;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  status: string;
  platform_role: PlatformRole;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

export interface RegisterResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly session: SessionRecord;
}

/** Gera um slug livre acrescentando sufixo numerico quando houver colisao. */
async function uniqueSlug(db: SqlClient, base: string): Promise<string> {
  const root = slugify(base) || 'organizacao';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const { rowCount } = await db.query('select 1 from organizations where slug = $1', [candidate]);
    if (rowCount === 0) return candidate;
  }
  return `${root}-${randomToken(4).toLowerCase()}`;
}

export async function register(
  ctx: AuthContext,
  input: RegisterInput,
  meta: { ip?: string; userAgent?: string },
): Promise<RegisterResult> {
  const { db } = ctx;

  const existing = await db.query('select 1 from users where email = $1', [input.email]);
  if (existing.rowCount > 0) {
    // Cadastro nao tem como ser anti-enumeracao: o usuario precisa saber que
    // o e-mail ja existe para ir ao login. O rate limit e a defesa aqui.
    throw new DomainError('already_exists', 'Ja existe uma conta com este e-mail.', {
      action: 'Faca login ou use a recuperacao de senha.',
    });
  }

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(db, input.organizationName);

  return db.transaction(async (tx) => {
    const userId = (
      await tx.query<{ id: string }>(
        'insert into users (name, email, password_hash) values ($1,$2,$3) returning id',
        [input.name, input.email, passwordHash],
      )
    ).rows[0]!.id;

    const organizationId = (
      await tx.query<{ id: string }>(
        'insert into organizations (name, slug, timezone) values ($1,$2,$3) returning id',
        [input.organizationName, slug, input.timezone],
      )
    ).rows[0]!.id;

    // Quem cria a organizacao e o owner dela.
    await tx.query(
      `insert into organization_memberships (organization_id, user_id, role, status)
       values ($1,$2,'owner','active')`,
      [organizationId, userId],
    );

    // Assinatura interna em trial. Sem gateway: o produto ja funciona inteiro.
    const plan = await tx.query<{ id: string }>(
      "select id from plans where code = 'growth' and active order by sort_order limit 1",
    );
    if (plan.rows[0]) {
      await tx.query(
        `insert into subscriptions (organization_id, plan_id, status, current_period_end, trial_ends_at, provider)
         values ($1,$2,'trialing', now() + interval '30 days', now() + interval '30 days','disabled')`,
        [organizationId, plan.rows[0].id],
      );
    }

    const session = await createSession(tx, ctx, userId, organizationId, meta);
    return { userId, organizationId, session };
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginResult {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly session: SessionRecord;
}

const invalidCredentials = (): DomainError =>
  new DomainError('invalid_credentials', 'E-mail ou senha incorretos.');

export async function login(
  ctx: AuthContext,
  email: string,
  password: string,
  meta: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const { db } = ctx;
  const { rows } = await db.query<UserRow>(
    'select id, name, email, password_hash, status, platform_role from users where email = $1',
    [email],
  );
  const user = rows[0];

  if (!user) {
    /*
     * Usuario inexistente: ainda assim gastamos o tempo de um hash. Sem isso,
     * a diferenca de latencia entre "e-mail existe" e "nao existe" e medivel
     * e vira enumeracao de base de clientes.
     */
    await hashPassword(password);
    throw invalidCredentials();
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw invalidCredentials();

  if (user.status !== 'active') {
    throw new DomainError('forbidden', 'Esta conta esta suspensa.', {
      action: 'Fale com o administrador da sua organizacao.',
    });
  }

  // Custo de hash aumentou desde o cadastro: reprocessa de forma transparente.
  if (needsRehash(user.password_hash)) {
    const upgraded = await hashPassword(password);
    await db.query('update users set password_hash = $2, updated_at = now() where id = $1', [
      user.id,
      upgraded,
    ]);
  }

  const membership = await db.query<{ organization_id: string }>(
    `select organization_id from organization_memberships
      where user_id = $1 and status = 'active'
      order by created_at limit 1`,
    [user.id],
  );
  const organizationId = membership.rows[0]?.organization_id ?? null;

  await db.query('update users set last_login_at = now() where id = $1', [user.id]);
  const session = await createSession(db, ctx, user.id, organizationId, meta);

  return { userId: user.id, organizationId, session };
}

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

export async function createSession(
  db: SqlClient,
  ctx: AuthContext,
  userId: string,
  organizationId: string | null,
  meta: { ip?: string; userAgent?: string; rotatedFrom?: string },
): Promise<SessionRecord> {
  const token = randomToken(SESSION_BYTES);
  const csrfSecret = randomToken(16);
  const expiresAt = new Date(Date.now() + ctx.sessionTtlHours * 3_600_000);

  const { rows } = await db.query<{ id: string }>(
    `insert into sessions (user_id, organization_id, token_hash, csrf_secret, user_agent, ip_prefix, expires_at, rotated_from)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [
      userId,
      organizationId,
      hashToken(token),
      csrfSecret,
      meta.userAgent?.slice(0, 300) ?? null,
      truncateIp(meta.ip),
      expiresAt,
      meta.rotatedFrom ?? null,
    ],
  );

  return { id: rows[0]!.id, token, csrfSecret, expiresAt };
}

export interface ResolvedSession {
  readonly principal: UserPrincipal;
  readonly csrfSecret: string;
  readonly expiresAt: Date;
}

/**
 * Resolve o cookie em um principal com escopo completo.
 *
 * Uma unica consulta traz usuario, papel na organizacao e lista de lojas
 * permitidas. O escopo nunca vem do cliente.
 */
export async function resolveSession(db: SqlClient, token: string): Promise<ResolvedSession | null> {
  const { rows } = await db.query<{
    session_id: string;
    csrf_secret: string;
    expires_at: Date;
    user_id: string;
    user_status: string;
    platform_role: PlatformRole;
    organization_id: string | null;
    role: OrganizationRole | null;
    membership_status: string | null;
    organization_status: string | null;
    store_ids: string[] | null;
  }>(
    `select s.id            as session_id,
            s.csrf_secret,
            s.expires_at,
            u.id            as user_id,
            u.status        as user_status,
            u.platform_role,
            s.organization_id,
            m.role,
            m.status        as membership_status,
            o.status        as organization_status,
            (select array_agg(sm.store_id)
               from store_memberships sm
              where sm.user_id = u.id and sm.organization_id = s.organization_id) as store_ids
       from sessions s
       join users u on u.id = s.user_id
  left join organization_memberships m
         on m.user_id = u.id and m.organization_id = s.organization_id
  left join organizations o on o.id = s.organization_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) return null;
  if (row.user_status !== 'active') return null;
  if (!row.organization_id || !row.role) return null;
  if (row.membership_status !== 'active') return null;
  if (row.organization_status === 'archived') return null;

  // Heartbeat da sessao, para a tela de "dispositivos conectados".
  await db.query('update sessions set last_seen_at = now() where id = $1', [row.session_id]);

  return {
    principal: {
      kind: 'user',
      userId: row.user_id,
      organizationId: row.organization_id,
      role: row.role,
      platformRole: row.platform_role,
      // array_agg devolve null quando nao ha linha: null = todas as lojas.
      scopedStoreIds: row.store_ids && row.store_ids.length > 0 ? row.store_ids : null,
      sessionId: row.session_id,
    },
    csrfSecret: row.csrf_secret,
    expiresAt: new Date(row.expires_at),
  };
}

export async function revokeSession(db: SqlClient, sessionId: string): Promise<void> {
  await db.query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [
    sessionId,
  ]);
}

/** Encerra todas as sessoes do usuario. Usado na troca de senha. */
export async function revokeAllSessions(
  db: SqlClient,
  userId: string,
  except?: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `update sessions set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2::uuid)`,
    [userId, except ?? null],
  );
  return rowCount;
}

/** Troca a organizacao ativa da sessao, validando o vinculo antes. */
export async function switchOrganization(
  db: SqlClient,
  principal: UserPrincipal,
  organizationId: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `select 1 from organization_memberships
      where user_id = $1 and organization_id = $2 and status = 'active'`,
    [principal.userId, organizationId],
  );
  if (rowCount === 0) {
    throw new DomainError('not_found', 'Organizacao nao encontrada.', {
      logContext: { denied: 'organization_switch', userId: principal.userId, organizationId },
    });
  }
  await db.query('update sessions set organization_id = $2 where id = $1', [
    principal.sessionId,
    organizationId,
  ]);
}

// ---------------------------------------------------------------------------
// Recuperacao de senha
// ---------------------------------------------------------------------------

const RESET_TTL_MINUTES = 30;

/**
 * Emite token de recuperacao.
 *
 * Devolve `null` quando o e-mail nao existe, e a ROTA responde 204 de
 * qualquer forma. A tela diz "se existir uma conta, enviamos instrucoes" --
 * nunca confirma nem nega a existencia do cadastro.
 */
export async function requestPasswordReset(
  db: SqlClient,
  email: string,
): Promise<{ userId: string; token: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from users where email = $1 and status = 'active'",
    [email],
  );
  const user = rows[0];
  if (!user) return null;

  // Invalida pedidos anteriores: um unico token vivo por vez.
  await db.query(
    'update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null',
    [user.id],
  );

  const token = randomToken(32);
  await db.query(
    `insert into password_reset_tokens (user_id, token_hash, expires_at)
     values ($1,$2, now() + make_interval(mins => $3))`,
    [user.id, hashToken(token), RESET_TTL_MINUTES],
  );
  return { userId: user.id, token };
}

export async function completePasswordReset(
  db: SqlClient,
  token: string,
  newPassword: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `select id, user_id from password_reset_tokens
      where token_hash = $1 and used_at is null and expires_at > now()`,
    [hashToken(token)],
  );
  const record = rows[0];
  if (!record) {
    throw new DomainError('validation_failed', 'Este link de recuperacao expirou ou ja foi usado.', {
      action: 'Solicite um novo link.',
    });
  }

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    // Uso unico: marcar antes de qualquer outro efeito.
    await tx.query('update password_reset_tokens set used_at = now() where id = $1', [record.id]);
    await tx.query('update users set password_hash = $2, updated_at = now() where id = $1', [
      record.user_id,
      passwordHash,
    ]);
    // Trocar a senha derruba todas as sessoes: se a conta foi comprometida,
    // o invasor perde o acesso no mesmo instante.
    await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
      record.user_id,
    ]);
  });

  return record.user_id;
}
