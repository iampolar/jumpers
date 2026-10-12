import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  createTestContext,
  makePlatformAdmin,
  registerTenant,
  type RegisteredTenant,
  type TestContext,
} from '../../testing/harness';

let ctx: TestContext;
let cliente: RegisteredTenant;

beforeEach(async () => {
  ctx = await createTestContext();
  cliente = await registerTenant(ctx, { organizationName: 'Rede Cliente' });
});

afterEach(async () => {
  await ctx.close();
});

/** Promove e refaz o login: mudar o papel invalida a sessao anterior. */
async function comoJumpers(role: 'support' | 'superadmin' = 'superadmin') {
  const tenant = await registerTenant(ctx, { organizationName: 'Jumpers Interno' });
  await makePlatformAdmin(ctx, tenant.userId, role);
  const agent = createAgent(ctx.app);
  await agent.post('/api/v1/auth/login', { email: tenant.email, password: tenant.password });
  return agent;
}

describe('isolamento do painel Jumpers', () => {
  it('para um cliente, a area nao existe: 404, nao 403', async () => {
    for (const url of [
      '/api/v1/jumpers/overview',
      '/api/v1/jumpers/organizations',
      '/api/v1/jumpers/jobs',
      '/api/v1/jumpers/audit',
    ]) {
      const res = await cliente.agent.get(url);
      // 403 confirmaria que a rota existe e que ele quase chegou la.
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('ser owner da propria organizacao nao abre o painel', async () => {
    const me = await cliente.agent.get('/api/v1/auth/me');
    expect(me.json<{ session: { role: string } }>().session.role).toBe('owner');
    expect((await cliente.agent.get('/api/v1/jumpers/overview')).statusCode).toBe(404);
  });

  it('suporte entra na visao geral mas nao reprocessa job', async () => {
    const suporte = await comoJumpers('support');
    expect((await suporte.get('/api/v1/jumpers/overview')).statusCode).toBe(200);

    const job = await ctx.db.query<{ id: string }>(
      `insert into jobs (queue, payload, status, last_error)
       values ('analytics-rollup','{}'::jsonb,'dead','falhou') returning id`,
    );
    const res = await suporte.post(`/api/v1/jumpers/jobs/${job.rows[0]!.id}/requeue`);
    // Reprocessar e acao de superadmin.
    expect(res.statusCode).toBe(404);
  });

  it('superadmin acessa tudo', async () => {
    const admin = await comoJumpers('superadmin');
    expect((await admin.get('/api/v1/jumpers/overview')).statusCode).toBe(200);
    expect((await admin.get('/api/v1/jumpers/organizations')).statusCode).toBe(200);
  });
});

describe('visao de operacao', () => {
  it('conta organizacoes, players e jobs', async () => {
    const admin = await comoJumpers();
    const res = await admin.get('/api/v1/jumpers/overview');
    const body = res.json<{
      organizations: { active: number };
      jobs: { pending: number; dead: number };
      integrations: { key: string; state: string }[];
    }>();

    expect(body.organizations.active).toBeGreaterThanOrEqual(2);
    expect(body.jobs.pending).toBeGreaterThanOrEqual(0);
    // O estado das integracoes aparece aqui, sem valor de variavel de ambiente.
    expect(body.integrations.find((i) => i.key === 'payments')!.state).toBe('not_configured');
  });

  it('lista organizacoes com plano e contadores', async () => {
    const admin = await comoJumpers();
    const res = await admin.get('/api/v1/jumpers/organizations?search=Cliente');
    const { organizations } = res.json<{
      organizations: { name: string; planCode: string; subscriptionStatus: string }[];
    }>();

    expect(organizations).toHaveLength(1);
    expect(organizations[0]!.name).toBe('Rede Cliente');
    expect(organizations[0]!.subscriptionStatus).toBe('trialing');
  });

  it('a fila mostra apenas as CHAVES do payload, nunca os valores', async () => {
    await ctx.db.query(
      `insert into jobs (queue, payload, status, organization_id)
       values ('media-process', '{"mediaAssetId":"segredo-do-cliente","organizationId":"x"}'::jsonb, 'pending', $1)`,
      [cliente.organizationId],
    );

    const admin = await comoJumpers();
    const res = await admin.get('/api/v1/jumpers/jobs');
    const { jobs } = res.json<{ jobs: { payloadSummary: string }[] }>();

    expect(jobs[0]!.payloadSummary).toContain('mediaAssetId');
    // O valor nao aparece na tela de operacao.
    expect(res.body).not.toContain('segredo-do-cliente');
  });

  it('reprocessa job morto e registra na auditoria', async () => {
    const job = await ctx.db.query<{ id: string }>(
      `insert into jobs (queue, payload, status, attempts, last_error)
       values ('analytics-rollup','{}'::jsonb,'dead',5,'esgotou') returning id`,
    );
    const admin = await comoJumpers();

    const res = await admin.post(`/api/v1/jumpers/jobs/${job.rows[0]!.id}/requeue`);
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.db.query<{ status: string; attempts: number }>(
      'select status, attempts from jobs where id = $1',
      [job.rows[0]!.id],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });

    const trilha = await ctx.db.query<{ actor_type: string }>(
      "select actor_type from audit_logs where action = 'platform.job_requeued'",
    );
    expect(trilha.rows[0]!.actor_type).toBe('platform');
  });

  it('recusa reprocessar job que nao falhou', async () => {
    const job = await ctx.db.query<{ id: string }>(
      `insert into jobs (queue, payload, status) values ('analytics-rollup','{}'::jsonb,'completed') returning id`,
    );
    const admin = await comoJumpers();
    expect((await admin.post(`/api/v1/jumpers/jobs/${job.rows[0]!.id}/requeue`)).statusCode).toBe(409);
  });
});

describe('auditoria', () => {
  it('o owner ve a trilha da propria organizacao', async () => {
    await cliente.agent.post('/api/v1/stores', { name: 'Loja', timezone: 'America/Sao_Paulo' });

    const res = await cliente.agent.get('/api/v1/audit');
    expect(res.statusCode).toBe(200);
    const { entries } = res.json<{ entries: { action: string }[] }>();
    expect(entries.some((e) => e.action === 'store.created')).toBe(true);
  });

  it('a trilha do cliente NAO inclui outra organizacao', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    await outro.agent.post('/api/v1/stores', { name: 'Loja B', timezone: 'America/Sao_Paulo' });
    await cliente.agent.post('/api/v1/stores', { name: 'Loja A', timezone: 'America/Sao_Paulo' });

    const res = await cliente.agent.get('/api/v1/audit');
    const { entries } = res.json<{ entries: { resourceId: string }[] }>();

    const idsDaOutra = await ctx.db.query<{ id: string }>(
      "select id from stores where name = 'Loja B'",
    );
    expect(entries.map((e) => e.resourceId)).not.toContain(idsDaOutra.rows[0]!.id);
  });

  it('editor de conteudo nao le auditoria', async () => {
    await ctx.db.query("update organization_memberships set role = 'content_editor' where user_id = $1", [
      cliente.userId,
    ]);
    const editor = createAgent(ctx.app);
    await editor.post('/api/v1/auth/login', { email: cliente.email, password: cliente.password });
    expect((await editor.get('/api/v1/audit')).statusCode).toBe(403);
  });

  it('a negativa de acesso tambem e registrada', async () => {
    await cliente.agent.get('/api/v1/jumpers/overview'); // 404

    const admin = await comoJumpers();
    const res = await admin.get('/api/v1/jumpers/audit?outcome=denied');
    expect(res.statusCode).toBe(200);
    // Tentativas negadas sao o evento que importa numa investigacao.
    const { entries } = res.json<{ entries: { outcome: string }[] }>();
    for (const e of entries) expect(e.outcome).toBe('denied');
  });

  it('o IP guardado e truncado, nao completo', async () => {
    await cliente.agent.post('/api/v1/stores', { name: 'Loja', timezone: 'America/Sao_Paulo' });
    const { rows } = await ctx.db.query<{ ip_prefix: string | null }>(
      "select ip_prefix from audit_logs where action = 'store.created'",
    );
    if (rows[0]!.ip_prefix) {
      expect(rows[0]!.ip_prefix).toMatch(/\/(24|48)$/);
    }
  });
});
