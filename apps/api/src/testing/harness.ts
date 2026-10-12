import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { createSqlClient, migrate, seed, type SqlClient } from '@castwave/db';
import { loadConfig, silentLogger } from '@castwave/runtime';
import { buildApp, type CastWaveApp } from '../app';

/**
 * Arnes de teste de integracao.
 *
 * Sobe a aplicacao inteira contra um PostgreSQL real em memoria e fala com ela
 * por HTTP. Nada e mockado: as rotas, os guards, o SQL e as constraints sao os
 * mesmos de producao.
 *
 * `agent()` guarda cookie e token CSRF como um navegador faria, para que um
 * teste de isolamento entre clientes seja escrito do jeito que o ataque
 * aconteceria de verdade -- logado como A, pedindo recurso de B.
 */

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'memory://',
  SESSION_SECRET: 's'.repeat(48),
  MEDIA_URL_SECRET: 'm'.repeat(48),
  STORAGE_LOCAL_PATH: './.data/test-storage',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'error',
} as const satisfies NodeJS.ProcessEnv;

export interface TestContext {
  readonly app: CastWaveApp;
  readonly db: SqlClient;
  close(): Promise<void>;
}

export async function createTestContext(
  env: Partial<Record<string, string>> = {},
): Promise<TestContext> {
  const db = await createSqlClient({ url: 'memory://' });
  await migrate(db);
  // Catalogo de planos sem a organizacao de demonstracao: cada teste monta
  // os tenants de que precisa.
  await seed(db, { withDemoOrganization: false });

  const app = await buildApp({
    config: loadConfig({ ...TEST_ENV, ...env }),
    db,
    logger: silentLogger,
  });
  await app.server.ready();

  return {
    app,
    db,
    async close() {
      await app.server.close();
      await db.close();
    },
  };
}

export interface Agent {
  readonly cookie: string | null;
  readonly csrfToken: string | null;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  del(url: string): Promise<LightMyRequestResponse>;
}

/** Cliente com estado, como um navegador: guarda sessao e token CSRF. */
export function createAgent(app: CastWaveApp): Agent {
  let cookie: string | null = null;
  let csrfToken: string | null = null;

  const agent: Agent = {
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },

    async request(options: InjectOptions): Promise<LightMyRequestResponse> {
      // Cabecalho explicito do teste SEMPRE vence o estado guardado: e assim
      // que um teste consegue simular token CSRF ausente, vazio ou de outra
      // sessao. Inverter essa precedencia mascararia a falha de seguranca.
      const explicit = (options.headers as Record<string, string> | undefined) ?? {};
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      Object.assign(headers, explicit);

      const res = await app.server.inject({ ...options, headers });

      // Captura Set-Cookie como um navegador faria.
      const setCookie = res.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      for (const entry of raw) {
        const [pair] = entry.split(';');
        if (!pair) continue;
        const [name, value] = pair.split('=');
        if (name?.trim() !== 'castwave_session') continue;
        cookie = value && value.length > 0 ? pair : null;
        if (!cookie) csrfToken = null;
      }

      // Login e cadastro devolvem o token CSRF no corpo.
      if (res.statusCode < 400) {
        try {
          const body = res.json<{ csrfToken?: string }>();
          if (body && typeof body.csrfToken === 'string') csrfToken = body.csrfToken;
        } catch {
          /* resposta sem corpo JSON */
        }
      }
      return res;
    },

    get: (url) => agent.request({ method: 'GET', url }),
    post: (url, payload) => agent.request({ method: 'POST', url, payload: payload ?? {} }),
    patch: (url, payload) => agent.request({ method: 'PATCH', url, payload: payload ?? {} }),
    del: (url) => agent.request({ method: 'DELETE', url }),
  };

  return agent;
}

export interface RegisteredTenant {
  readonly agent: Agent;
  readonly email: string;
  readonly password: string;
  readonly organizationId: string;
  readonly userId: string;
}

/** Cria uma organizacao com owner logado. Base de quase todo teste. */
export async function registerTenant(
  ctx: TestContext,
  options: { name?: string; organizationName?: string; email?: string } = {},
): Promise<RegisteredTenant> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = options.email ?? `owner-${suffix}@exemplo.test`;
  const password = 'senha-de-teste-bem-longa';

  const agent = createAgent(ctx.app);
  const res = await agent.post('/api/v1/auth/register', {
    name: options.name ?? 'Owner de Teste',
    email,
    password,
    organizationName: options.organizationName ?? `Rede ${suffix}`,
    timezone: 'America/Sao_Paulo',
    acceptedTerms: true,
  });

  if (res.statusCode !== 201) {
    throw new Error(`Falha ao registrar tenant de teste: ${res.statusCode} ${res.body}`);
  }

  const body = res.json<{ session: { user: { id: string }; organization: { id: string } } }>();
  return {
    agent,
    email,
    password,
    organizationId: body.session.organization.id,
    userId: body.session.user.id,
  };
}

/** Promove um usuario a superadmin da Jumpers, direto no banco. */
export async function makePlatformAdmin(
  ctx: TestContext,
  userId: string,
  role: 'support' | 'superadmin' = 'superadmin',
): Promise<void> {
  await ctx.db.query('update users set platform_role = $2 where id = $1', [userId, role]);
}
