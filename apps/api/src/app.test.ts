import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqlClient, migrate, seed, type SqlClient } from '@castwave/db';
import { buildApp, type CastWaveApp } from './app';
import { loadConfig, silentLogger } from '@castwave/runtime';

/**
 * Testes de integracao HTTP: sobem a aplicacao inteira (Fastify + Postgres)
 * e falam com ela por `inject`, o despachante real do Fastify. Nao ha mock de
 * rota, de banco nem de middleware.
 */

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'memory://',
  SESSION_SECRET: 'x'.repeat(48),
  MEDIA_URL_SECRET: 'y'.repeat(48),
  STORAGE_LOCAL_PATH: './.data/test-storage',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'error',
} satisfies NodeJS.ProcessEnv;

let app: CastWaveApp;
let db: SqlClient;

beforeEach(async () => {
  db = await createSqlClient({ url: 'memory://' });
  await migrate(db);
  await seed(db, { withDemoOrganization: false });
  app = await buildApp({ config: loadConfig(baseEnv), db, logger: silentLogger });
  await app.server.ready();
});

afterEach(async () => {
  await app.server.close();
  await db.close();
});

describe('saude', () => {
  it('liveness responde sem tocar dependencia', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('readiness reporta cada dependencia separadamente', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json<{
      status: string;
      checks: { name: string; status: string; required: boolean; detail: string | null }[];
    }>();

    expect([200, 503]).toContain(res.statusCode);
    const names = body.checks.map((c) => c.name);
    expect(names).toContain('postgres');
    expect(names).toContain('ffprobe');
    expect(body.checks.find((c) => c.name === 'postgres')).toMatchObject({ status: 'ok', required: true });
  });

  it('FFmpeg ausente degrada mas NAO derruba o readiness', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json<{ status: string; checks: { name: string; status: string; required: boolean }[] }>();
    const ffprobe = body.checks.find((c) => c.name === 'ffprobe')!;

    expect(ffprobe.status).toBe('degraded');
    expect(ffprobe.required).toBe(false);
    // Dependencia opcional nao pode tirar a API de rotacao.
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('degraded');
  });

  it('readiness explica o que se perde sem FFmpeg, em vez de fingir', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json<{ checks: { name: string; detail: string | null }[] }>();
    expect(body.checks.find((c) => c.name === 'ffprobe')!.detail).toMatch(/sonda nativa/i);
  });
});

describe('estado das integracoes', () => {
  it('reporta tudo desconectado por padrao, com acao para cada uma', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/status/integrations' });
    expect(res.statusCode).toBe(200);

    const { integrations } = res.json<{
      integrations: { key: string; state: string; action: string | null; disabledFeatures: string[] }[];
    }>();

    const byKey = Object.fromEntries(integrations.map((i) => [i.key, i]));
    expect(byKey.ai_copy!.state).toBe('not_configured');
    expect(byKey.ai_tts!.state).toBe('not_configured');
    expect(byKey.payments!.state).toBe('not_configured');

    // Cada integracao ausente diz o que fazer e o que fica desligado.
    for (const key of ['ai_copy', 'ai_tts', 'payments']) {
      expect(byKey[key]!.action, key).toBeTruthy();
      expect(byKey[key]!.disabledFeatures.length, key).toBeGreaterThan(0);
    }
  });

  it('nunca vaza valor de variavel de ambiente', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/status/integrations' });
    const raw = res.body;
    expect(raw).not.toContain(baseEnv.SESSION_SECRET);
    expect(raw).not.toContain(baseEnv.MEDIA_URL_SECRET);
    expect(raw).not.toMatch(/SESSION_SECRET\s*[:=]\s*\w/);
  });
});

describe('forma dos erros', () => {
  it('rota desconhecida responde 401 para anonimo, nao 404', async () => {
    /*
     * A autenticacao roda antes da resolucao de rota, de proposito: um
     * chamador sem credencial nao consegue mapear quais endpoints existem
     * comparando 404 com 401. A superficie da API nao e publica.
     */
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/rota-que-nao-existe' });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.requestId).toBeTruthy();
  });

  it('404 tem codigo estavel e requestId para quem esta autenticado', async () => {
    const { registerTenant } = await import('./testing/harness');
    const tenant = await registerTenant({ app, db, close: () => Promise.resolve() });

    const res = await tenant.agent.get('/api/v1/rota-que-nao-existe');
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBeTruthy();
  });

  it('o requestId da resposta bate com o cabecalho', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/nao-existe' });
    const body = res.json<{ error: { requestId: string } }>();
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('aceita correlation id do cliente quando tem forma de UUID', async () => {
    const given = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const res = await app.server.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': given },
    });
    expect(res.headers['x-request-id']).toBe(given);
  });

  it('recusa correlation id arbitrario em vez de ecoar no log', async () => {
    // Texto livre no header viraria poluicao (ou injecao) no agregador de logs.
    const res = await app.server.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'id\ninjetado: <script>' },
    });
    expect(res.headers['x-request-id']).not.toContain('injetado');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('cabecalhos de seguranca', () => {
  it('aplica nosniff, frame-ancestors e CSP restritiva', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('CORS so reflete a origem configurada', async () => {
    const allowed = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v1/status/integrations',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const foreign = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v1/status/integrations',
      headers: { origin: 'https://site-malicioso.example', 'access-control-request-method': 'GET' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});
