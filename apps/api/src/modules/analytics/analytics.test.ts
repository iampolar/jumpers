import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, registerTenant, type RegisteredTenant, type TestContext } from '../../testing/harness';

let ctx: TestContext;
let tenant: RegisteredTenant;
let storeId: string;
let zoneId: string;
let deviceId: string;
let mediaId: string;

/** Semeia eventos direto no banco: o foco aqui e a agregacao, nao o player. */
async function seedEvents(
  rows: { date: string; type: string; playedMs?: number; itemType?: string; errorCode?: string }[],
): Promise<void> {
  for (const row of rows) {
    await ctx.db.query(
      `insert into playback_events
         (event_id, organization_id, store_id, zone_id, device_id, slot_id, media_asset_id,
          item_type, event_type, occurred_at_device, played_ms, error_code, local_date)
       values ($1,$2,$3,$4,$5,'slot',$6,$7,$8,$9::timestamptz,$10,$11,$12::date)`,
      [
        randomUUID(),
        tenant.organizationId,
        storeId,
        zoneId,
        deviceId,
        mediaId,
        row.itemType ?? 'music',
        row.type,
        `${row.date}T15:00:00.000Z`,
        row.playedMs ?? 120_000,
        row.errorCode ?? null,
        row.date,
      ],
    );
  }
}

beforeEach(async () => {
  ctx = await createTestContext();
  tenant = await registerTenant(ctx);

  const store = await tenant.agent.post('/api/v1/stores', {
    name: 'Aurora Centro',
    timezone: 'America/Sao_Paulo',
  });
  storeId = store.json<{ store: { id: string } }>().store.id;
  const zone = await tenant.agent.post(`/api/v1/stores/${storeId}/zones`, { name: 'Salao' });
  zoneId = zone.json<{ zone: { id: string } }>().zone.id;

  const device = await ctx.db.query<{ id: string }>(
    `insert into player_devices (organization_id, store_id, zone_id, name, token_hash, status, paired_at)
     values ($1,$2,$3,'Player','hash-analytics','active',now()) returning id`,
    [tenant.organizationId, storeId, zoneId],
  );
  deviceId = device.rows[0]!.id;

  const media = await ctx.db.query<{ id: string }>(
    `insert into media_assets (organization_id, kind, title, original_filename, status,
        storage_key, duration_ms, checksum_sha256, size_bytes)
     values ($1,'music','Faixa 1','f1.wav','ready','k/1',120000,'abc',1000) returning id`,
    [tenant.organizationId],
  );
  mediaId = media.rows[0]!.id;
});

afterEach(async () => {
  await ctx.close();
});

describe('visao geral', () => {
  it('agrega execucoes e informa periodo e fuso junto', async () => {
    await seedEvents([
      { date: '2026-03-16', type: 'started' },
      { date: '2026-03-16', type: 'completed' },
      { date: '2026-03-17', type: 'completed' },
      { date: '2026-03-17', type: 'failed', errorCode: 'network' },
    ]);

    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-16&to=2026-03-17');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      period: { from: string; to: string; timezone: string };
      playback: { started: number; completed: number; failed: number; completionRate: number };
    }>();

    // O recorte acompanha o numero: ninguem le "2 execucoes" sem saber de quando.
    expect(body.period).toEqual({ from: '2026-03-16', to: '2026-03-17', timezone: 'America/Sao_Paulo' });
    expect(body.playback.started).toBe(1);
    expect(body.playback.completed).toBe(2);
    expect(body.playback.failed).toBe(1);
  });

  it('taxa de conclusao e null quando nao houve execucao, nao zero', async () => {
    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-01&to=2026-03-02');
    const body = res.json<{ playback: { completionRate: number | null; started: number } }>();
    expect(body.playback.started).toBe(0);
    // 0% afirmaria que tudo falhou; null diz "nao houve dado".
    expect(body.playback.completionRate).toBeNull();
  });

  it('a serie diaria e densa: dia sem evento vira zero, nao buraco', async () => {
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);

    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-15&to=2026-03-18');
    const { daily } = res.json<{ daily: { date: string; completed: number }[] }>();

    expect(daily).toHaveLength(4);
    expect(daily.map((d) => d.date)).toEqual(['2026-03-15', '2026-03-16', '2026-03-17', '2026-03-18']);
    expect(daily.find((d) => d.date === '2026-03-17')!.completed).toBe(0);
  });

  it('inclui disponibilidade de players por loja', async () => {
    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31');
    const body = res.json<{
      devices: { total: number; online: number };
      storeBreakdown: { storeName: string; totalDevices: number }[];
    }>();
    expect(body.devices.total).toBe(1);
    expect(body.storeBreakdown[0]!.storeName).toBe('Aurora Centro');
    expect(body.storeBreakdown[0]!.totalDevices).toBe(1);
  });

  it('respeita o filtro de periodo', async () => {
    await seedEvents([
      { date: '2026-03-10', type: 'completed' },
      { date: '2026-03-20', type: 'completed' },
    ]);
    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-15&to=2026-03-25');
    expect(res.json<{ playback: { completed: number } }>().playback.completed).toBe(1);
  });

  it('recusa periodo invertido', async () => {
    const res = await tenant.agent.get('/api/v1/analytics/overview?from=2026-03-20&to=2026-03-10');
    expect(res.statusCode).toBe(400);
  });
});

describe('isolamento dos relatorios', () => {
  it('outra organizacao nao ve os eventos', async () => {
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });

    const res = await outro.agent.get('/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31');
    expect(res.json<{ playback: { completed: number } }>().playback.completed).toBe(0);
  });

  it('operador restrito so ve as proprias lojas', async () => {
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);

    // Segunda loja, com eventos proprios.
    const outra = await tenant.agent.post('/api/v1/stores', {
      name: 'Aurora Norte',
      timezone: 'America/Sao_Paulo',
    });
    const outraId = outra.json<{ store: { id: string } }>().store.id;

    // Operador com escopo apenas da segunda loja.
    const membro = await tenant.agent.post('/api/v1/members', {
      email: 'operador@aurora.test',
      name: 'Operador',
      role: 'store_operator',
      storeIds: [outraId],
    });
    expect(membro.statusCode).toBe(201);

    // Simula a sessao do operador: o escopo vem de store_memberships.
    const { rows } = await ctx.db.query<{ user_id: string }>(
      "select user_id from organization_memberships where role = 'store_operator'",
    );
    await ctx.db.query(
      "update organization_memberships set status = 'active' where user_id = $1",
      [rows[0]!.user_id],
    );
    await ctx.db.query('update users set password_hash = (select password_hash from users where id = $2) where id = $1', [
      rows[0]!.user_id,
      tenant.userId,
    ]);

    const { createAgent } = await import('../../testing/harness');
    const operador = createAgent(ctx.app);
    const login = await operador.post('/api/v1/auth/login', {
      email: 'operador@aurora.test',
      password: tenant.password,
    });
    expect(login.statusCode).toBe(200);

    const res = await operador.get('/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31');
    // Os eventos sao da PRIMEIRA loja, fora do escopo dele.
    expect(res.json<{ playback: { completed: number } }>().playback.completed).toBe(0);
    expect(res.json<{ storeBreakdown: unknown[] }>().storeBreakdown).toHaveLength(1);
  });
});

describe('exportacao CSV', () => {
  it('exporta com BOM, cabecalho em portugues e hora local', async () => {
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);

    const res = await tenant.agent.get('/api/v1/analytics/export.csv?from=2026-03-16&to=2026-03-16');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    expect(res.body.startsWith(String.fromCharCode(0xfeff))).toBe(true); // Excel pt-BR
    expect(res.body).toContain('Loja;Zona;Player');
    expect(res.body).toContain('Aurora Centro');
    expect(res.body).toContain('America/Sao_Paulo');
  });

  it('neutraliza formula do Excel vinda de nome de loja', async () => {
    // O ataque: nomear a loja com uma formula e esperar que alguem abra o CSV.
    await ctx.db.query('update stores set name = $2 where id = $1', [
      storeId,
      '=HYPERLINK("http://malicioso","clique")',
    ]);
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);

    const res = await tenant.agent.get('/api/v1/analytics/export.csv?from=2026-03-16&to=2026-03-16');
    expect(res.body).toContain("'=HYPERLINK");
    expect(res.body).not.toMatch(/;=HYPERLINK/);
  });

  it('registra a exportacao na auditoria', async () => {
    await seedEvents([{ date: '2026-03-16', type: 'completed' }]);
    await tenant.agent.get('/api/v1/analytics/export.csv?from=2026-03-16&to=2026-03-16');

    const { rows } = await ctx.db.query<{ action: string }>(
      "select action from audit_logs where action = 'analytics.exported'",
    );
    expect(rows).toHaveLength(1);
  });

  it('exige permissao de exportacao, nao so de leitura', async () => {
    // content_editor le relatorio mas nao exporta.
    await ctx.db.query("update organization_memberships set role = 'content_editor' where user_id = $1", [
      tenant.userId,
    ]);
    // Papel mudou: a sessao antiga foi derrubada, entao refazemos login.
    const { createAgent } = await import('../../testing/harness');
    const editor = createAgent(ctx.app);
    await editor.post('/api/v1/auth/login', { email: tenant.email, password: tenant.password });

    expect((await editor.get('/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31')).statusCode).toBe(200);
    expect((await editor.get('/api/v1/analytics/export.csv?from=2026-03-01&to=2026-03-31')).statusCode).toBe(403);
  });
});

describe('planos e uso sem gateway', () => {
  it('lista o catalogo sem exigir sessao', async () => {
    const { createAgent } = await import('../../testing/harness');
    const anonimo = createAgent(ctx.app);
    const res = await anonimo.get('/api/v1/billing/plans');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ plans: unknown[] }>().plans.length).toBeGreaterThan(0);
  });

  it('a assinatura reporta o gateway como nao configurado', async () => {
    const res = await tenant.agent.get('/api/v1/billing/subscription');
    const { subscription } = res.json<{
      subscription: { provider: string; providerState: string; meters: unknown[] };
    }>();
    expect(subscription.provider).toBe('disabled');
    expect(subscription.providerState).toBe('not_configured');
    // Os medidores funcionam mesmo sem cobranca conectada.
    expect(subscription.meters.length).toBeGreaterThan(0);
  });

  it('o checkout recusa com motivo acionavel, sem fingir sucesso', async () => {
    const res = await tenant.agent.post('/api/v1/billing/checkout', { planCode: 'network' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string; action: string } }>();
    expect(body.error.code).toBe('payments_not_configured');
    expect(body.error.action).toBeTruthy();

    // E, crucialmente, nada foi marcado como pago.
    const { rows } = await ctx.db.query<{ status: string }>('select status from subscriptions');
    expect(rows[0]!.status).toBe('trialing');
  });

  it('troca de plano interna e auditada e declara que nao houve cobranca', async () => {
    const res = await tenant.agent.post('/api/v1/billing/change-plan', { planCode: 'network' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ planCode: string; billed: boolean; note: string }>();
    expect(body.planCode).toBe('network');
    expect(body.billed).toBe(false);
    expect(body.note).toMatch(/nenhuma cobranca/i);

    const { rows } = await ctx.db.query<{ action: string }>(
      "select action from audit_logs where action = 'billing.plan_changed'",
    );
    expect(rows).toHaveLength(1);
  });

  it('os medidores refletem o uso real', async () => {
    const res = await tenant.agent.get('/api/v1/usage');
    const { meters } = res.json<{ meters: { metric: string; used: number; limit: number }[] }>();
    const lojas = meters.find((m) => m.metric === 'stores_active')!;
    expect(lojas.used).toBe(1);
    expect(lojas.limit).toBeGreaterThan(0);
  });
});

describe('IA desligada', () => {
  it('o status informa que nao ha provedor e por que o botao esta inativo', async () => {
    const res = await tenant.agent.get('/api/v1/ai/status');
    const body = res.json<{ copy: { state: string }; disabledReason: string }>();
    expect(body.copy.state).toBe('not_configured');
    expect(body.disabledReason).toMatch(/manual/i);
  });

  it('gerar roteiro devolve 503 com acao, nao um texto inventado', async () => {
    const res = await tenant.agent.post('/api/v1/ai/copy', {
      locale: 'pt-BR',
      objective: 'vender cafe',
      tone: 'neutro',
      targetDurationSeconds: 20,
      forbiddenTerms: [],
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string; action: string } }>();
    expect(body.error.code).toBe('provider_not_configured');
    expect(body.error.action).toMatch(/manualmente|modelo/i);
  });

  it('gerar locucao tambem recusa, sem devolver audio falso', async () => {
    const res = await tenant.agent.post('/api/v1/ai/speech', {
      locale: 'pt-BR',
      scriptText: 'Teste de locucao.',
      voiceId: 'qualquer',
      outputFormat: 'mp3',
    });
    expect(res.statusCode).toBe(503);
  });

  it('o produto continua utilizavel: modelos prontos respondem normalmente', async () => {
    const res = await tenant.agent.get('/api/v1/announcements/templates');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ templates: unknown[] }>().templates.length).toBeGreaterThan(0);
  });
});
