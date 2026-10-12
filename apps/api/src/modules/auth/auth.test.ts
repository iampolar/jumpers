import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, createTestContext, registerTenant, type TestContext } from '../../testing/harness.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.close();
});

const registerPayload = (over: Record<string, unknown> = {}) => ({
  name: 'Marina Prado',
  email: 'marina@aurora.test',
  password: 'senha-de-teste-bem-longa',
  organizationName: 'Rede Aurora',
  timezone: 'America/Sao_Paulo',
  acceptedTerms: true,
  ...over,
});

describe('cadastro', () => {
  it('cria usuario, organizacao, membership owner e assinatura em trial', async () => {
    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/register', registerPayload());

    expect(res.statusCode).toBe(201);
    const body = res.json<{ csrfToken: string; session: { role: string; organization: { name: string } } }>();
    expect(body.csrfToken).toBeTruthy();
    expect(body.session.role).toBe('owner');
    expect(body.session.organization.name).toBe('Rede Aurora');

    const sub = await ctx.db.query<{ status: string; provider: string }>(
      'select status, provider from subscriptions',
    );
    // Produto funciona inteiro sem gateway conectado.
    expect(sub.rows[0]).toEqual({ status: 'trialing', provider: 'disabled' });
  });

  it('grava a senha como hash scrypt, nunca em claro', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/register', registerPayload());

    const { rows } = await ctx.db.query<{ password_hash: string }>('select password_hash from users');
    expect(rows[0]!.password_hash).not.toContain('senha-de-teste');
    expect(rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('guarda apenas o hash do token de sessao', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/register', registerPayload());

    const token = agent.cookie!.split('=')[1]!;
    const { rows } = await ctx.db.query<{ token_hash: string }>('select token_hash from sessions');
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it('define cookie HttpOnly e SameSite', async () => {
    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/register', registerPayload());
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('recusa e-mail duplicado', async () => {
    const a = createAgent(ctx.app);
    await a.post('/api/v1/auth/register', registerPayload());
    const b = createAgent(ctx.app);
    const res = await b.post('/api/v1/auth/register', registerPayload({ organizationName: 'Outra' }));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('already_exists');
  });

  it('exige aceite dos termos e senha de 12 caracteres', async () => {
    const agent = createAgent(ctx.app);
    const semTermos = await agent.post('/api/v1/auth/register', registerPayload({ acceptedTerms: false }));
    expect(semTermos.statusCode).toBe(400);

    const senhaCurta = await agent.post('/api/v1/auth/register', registerPayload({ password: 'curta' }));
    expect(senhaCurta.statusCode).toBe(400);
    expect(senhaCurta.json<{ error: { issues: { path: string }[] } }>().error.issues[0]!.path).toBe('password');
  });

  it('normaliza o e-mail antes de gravar', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/register', registerPayload({ email: '  MARINA@Aurora.TEST ' }));
    const { rows } = await ctx.db.query<{ email: string }>('select email from users');
    expect(rows[0]!.email).toBe('marina@aurora.test');
  });

  it('gera slug unico quando duas redes tem o mesmo nome', async () => {
    const a = createAgent(ctx.app);
    await a.post('/api/v1/auth/register', registerPayload());
    const b = createAgent(ctx.app);
    await b.post('/api/v1/auth/register', registerPayload({ email: 'outro@aurora.test' }));

    const { rows } = await ctx.db.query<{ slug: string }>('select slug from organizations order by slug');
    expect(rows.map((r) => r.slug)).toEqual(['rede-aurora', 'rede-aurora-2']);
  });
});

describe('login', () => {
  beforeEach(async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/register', registerPayload());
  });

  it('aceita credencial correta', async () => {
    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/login', {
      email: 'marina@aurora.test',
      password: 'senha-de-teste-bem-longa',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ session: { role: string } }>().session.role).toBe('owner');
  });

  it('da a MESMA resposta para senha errada e usuario inexistente', async () => {
    // Qualquer diferenca aqui vira enumeracao da base de clientes.
    const a = createAgent(ctx.app);
    const senhaErrada = await a.post('/api/v1/auth/login', {
      email: 'marina@aurora.test',
      password: 'senha-errada-mas-longa',
    });
    const b = createAgent(ctx.app);
    const inexistente = await b.post('/api/v1/auth/login', {
      email: 'ninguem@aurora.test',
      password: 'senha-errada-mas-longa',
    });

    const errorOf = (res: typeof senhaErrada) => {
      // `requestId` e unico por requisicao, por definicao: comparamos o que o
      // atacante consegue observar como sinal, nao o identificador de log.
      const { code, message } = res.json<{ error: { code: string; message: string } }>().error;
      return { code, message };
    };

    expect(senhaErrada.statusCode).toBe(inexistente.statusCode);
    expect(errorOf(senhaErrada)).toEqual(errorOf(inexistente));
  });

  it('registra tentativa falha na auditoria', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/login', { email: 'marina@aurora.test', password: 'errada-porem-longa' });

    const { rows } = await ctx.db.query<{ action: string; outcome: string }>(
      "select action, outcome from audit_logs where action = 'user.login_failed'",
    );
    expect(rows[0]).toMatchObject({ action: 'user.login_failed', outcome: 'denied' });
  });

  it('a auditoria nunca guarda a senha tentada', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/login', { email: 'marina@aurora.test', password: 'SenhaSecreta123!' });
    const { rows } = await ctx.db.query<{ all: string }>(
      'select coalesce(string_agg(metadata::text || coalesce(actor_label,\'\'), \' \'), \'\') as all from audit_logs',
    );
    expect(rows[0]!.all).not.toContain('SenhaSecreta123');
  });

  it('bloqueia conta suspensa', async () => {
    await ctx.db.query("update users set status = 'suspended'");
    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/login', {
      email: 'marina@aurora.test',
      password: 'senha-de-teste-bem-longa',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('sessao', () => {
  it('/auth/me devolve identidade, papel e permissoes', async () => {
    const tenant = await registerTenant(ctx);
    const res = await tenant.agent.get('/api/v1/auth/me');

    expect(res.statusCode).toBe(200);
    const { session } = res.json<{
      session: { role: string; permissions: string[]; scopedStoreIds: string[] | null };
    }>();
    expect(session.role).toBe('owner');
    expect(session.permissions).toContain('billing:manage');
    // Owner sem restricao de loja: escopo nulo = todas.
    expect(session.scopedStoreIds).toBeNull();
  });

  it('/auth/me devolve o token CSRF para sobreviver a um F5', async () => {
    /*
     * Regressao: o token CSRF vive so na memoria do cliente. Sem devolve-lo
     * aqui, recarregar a pagina deixava o usuario logado porem incapaz de
     * salvar qualquer coisa -- toda escrita respondia "sessao expirada".
     */
    const tenant = await registerTenant(ctx);
    const res = await tenant.agent.get('/api/v1/auth/me');
    const body = res.json<{ csrfToken: string }>();
    expect(body.csrfToken).toBeTruthy();

    // E o token devolvido e aceito numa escrita real.
    const escrita = await tenant.agent.request({
      method: 'POST',
      url: '/api/v1/auth/revoke-sessions',
      headers: { cookie: tenant.agent.cookie!, 'x-csrf-token': body.csrfToken },
    });
    expect(escrita.statusCode).toBe(200);
  });

  it('sem cookie, rota privada responde 401', async () => {
    const anonimo = createAgent(ctx.app);
    const res = await anonimo.get('/api/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });

  it('logout revoga a sessao imediatamente', async () => {
    const tenant = await registerTenant(ctx);
    expect((await tenant.agent.get('/api/v1/auth/me')).statusCode).toBe(200);

    const logout = await tenant.agent.post('/api/v1/auth/logout');
    expect(logout.statusCode).toBe(204);

    const { rows } = await ctx.db.query<{ revoked_at: Date | null }>('select revoked_at from sessions');
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('cookie de sessao revogada nao vale mais', async () => {
    const tenant = await registerTenant(ctx);
    const cookieRoubado = tenant.agent.cookie!;
    const csrf = tenant.agent.csrfToken!;
    await tenant.agent.post('/api/v1/auth/logout');

    const ladrao = createAgent(ctx.app);
    const res = await ladrao.request({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieRoubado, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sessao expirada e recusada', async () => {
    const tenant = await registerTenant(ctx);
    await ctx.db.query("update sessions set expires_at = now() - interval '1 hour'");
    expect((await tenant.agent.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('revogar todas as sessoes mantem a atual e derruba as outras', async () => {
    const tenant = await registerTenant(ctx);
    const outroDispositivo = createAgent(ctx.app);
    await outroDispositivo.post('/api/v1/auth/login', {
      email: tenant.email,
      password: tenant.password,
    });

    const res = await tenant.agent.post('/api/v1/auth/revoke-sessions');
    expect(res.json<{ revoked: number }>().revoked).toBe(1);
    expect((await tenant.agent.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await outroDispositivo.get('/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('recusa POST autenticado sem o token', async () => {
    const tenant = await registerTenant(ctx);
    const res = await tenant.agent.request({
      method: 'POST',
      url: '/api/v1/auth/revoke-sessions',
      headers: { cookie: tenant.agent.cookie!, 'x-csrf-token': '' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('csrf_token_invalid');
  });

  it('recusa token CSRF de outra sessao', async () => {
    const a = await registerTenant(ctx);
    const b = await registerTenant(ctx);
    const res = await a.agent.request({
      method: 'POST',
      url: '/api/v1/auth/revoke-sessions',
      headers: { cookie: a.agent.cookie!, 'x-csrf-token': b.agent.csrfToken! },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET nao precisa de token CSRF', async () => {
    const tenant = await registerTenant(ctx);
    const res = await tenant.agent.request({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: tenant.agent.cookie! },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('recuperacao de senha', () => {
  beforeEach(async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/register', registerPayload());
  });

  it('responde 204 exista ou nao a conta', async () => {
    const agent = createAgent(ctx.app);
    const existe = await agent.post('/api/v1/auth/password/forgot', { email: 'marina@aurora.test' });
    const naoExiste = await agent.post('/api/v1/auth/password/forgot', { email: 'ninguem@aurora.test' });
    expect(existe.statusCode).toBe(204);
    expect(naoExiste.statusCode).toBe(204);
    expect(existe.body).toBe(naoExiste.body);
  });

  it('guarda apenas o hash do token de recuperacao', async () => {
    const agent = createAgent(ctx.app);
    await agent.post('/api/v1/auth/password/forgot', { email: 'marina@aurora.test' });
    const { rows } = await ctx.db.query<{ token_hash: string }>('select token_hash from password_reset_tokens');
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it('troca a senha, invalida o token e derruba todas as sessoes', async () => {
    const logado = createAgent(ctx.app);
    await logado.post('/api/v1/auth/login', {
      email: 'marina@aurora.test',
      password: 'senha-de-teste-bem-longa',
    });

    // Emite e captura o token direto do servico (sem SMTP configurado).
    const { requestPasswordReset } = await import('./service.js');
    const issued = (await requestPasswordReset(ctx.db, 'marina@aurora.test'))!;

    const agent = createAgent(ctx.app);
    const reset = await agent.post('/api/v1/auth/password/reset', {
      token: issued.token,
      password: 'nova-senha-bem-longa',
    });
    expect(reset.statusCode).toBe(204);

    // Sessao anterior cai: se a conta foi comprometida, o invasor perde acesso.
    expect((await logado.get('/api/v1/auth/me')).statusCode).toBe(401);

    // Token e de uso unico.
    const reuso = await agent.post('/api/v1/auth/password/reset', {
      token: issued.token,
      password: 'outra-senha-bem-longa',
    });
    expect(reuso.statusCode).toBe(400);

    // A senha nova funciona.
    const novo = createAgent(ctx.app);
    const login = await novo.post('/api/v1/auth/login', {
      email: 'marina@aurora.test',
      password: 'nova-senha-bem-longa',
    });
    expect(login.statusCode).toBe(200);
  });

  it('recusa token expirado', async () => {
    const { requestPasswordReset } = await import('./service.js');
    const issued = (await requestPasswordReset(ctx.db, 'marina@aurora.test'))!;
    await ctx.db.query("update password_reset_tokens set expires_at = now() - interval '1 minute'");

    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/password/reset', {
      token: issued.token,
      password: 'nova-senha-bem-longa',
    });
    expect(res.statusCode).toBe(400);
  });

  it('um novo pedido invalida o anterior', async () => {
    const { requestPasswordReset } = await import('./service.js');
    const primeiro = (await requestPasswordReset(ctx.db, 'marina@aurora.test'))!;
    await requestPasswordReset(ctx.db, 'marina@aurora.test');

    const agent = createAgent(ctx.app);
    const res = await agent.post('/api/v1/auth/password/reset', {
      token: primeiro.token,
      password: 'nova-senha-bem-longa',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('isolamento entre organizacoes', () => {
  it('cada cadastro cria um tenant separado', async () => {
    const a = await registerTenant(ctx, { organizationName: 'Rede A' });
    const b = await registerTenant(ctx, { organizationName: 'Rede B' });
    expect(a.organizationId).not.toBe(b.organizationId);

    const sessionA = (await a.agent.get('/api/v1/auth/me')).json<{
      session: { organization: { id: string } };
    }>();
    expect(sessionA.session.organization.id).toBe(a.organizationId);
  });

  it('trocar para organizacao de terceiro responde 404', async () => {
    const a = await registerTenant(ctx);
    const b = await registerTenant(ctx);

    const res = await a.agent.post('/api/v1/auth/switch-organization', {
      organizationId: b.organizationId,
    });
    // 404, nao 403: nao confirmamos que aquela organizacao existe.
    expect(res.statusCode).toBe(404);
  });

  it('ser owner da propria rede nao da acesso ao painel Jumpers', async () => {
    const tenant = await registerTenant(ctx);
    const { session } = (await tenant.agent.get('/api/v1/auth/me')).json<{
      session: { user: { platformRole: string } };
    }>();
    expect(session.user.platformRole).toBe('none');
  });
});
