import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  createTestContext,
  registerTenant,
  type Agent,
  type RegisteredTenant,
  type TestContext,
} from '../../testing/harness.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.close();
});

async function createStore(
  agent: Agent,
  over: Record<string, unknown> = {},
): Promise<{ id: string; zoneId: string }> {
  const store = await agent.post('/api/v1/stores', {
    name: 'Aurora Centro',
    timezone: 'America/Sao_Paulo',
    ...over,
  });
  if (store.statusCode !== 201) throw new Error(`loja: ${store.statusCode} ${store.body}`);
  const id = store.json<{ store: { id: string } }>().store.id;

  const zone = await agent.post(`/api/v1/stores/${id}/zones`, { name: 'Salao' });
  if (zone.statusCode !== 201) throw new Error(`zona: ${zone.statusCode} ${zone.body}`);
  return { id, zoneId: zone.json<{ zone: { id: string } }>().zone.id };
}

async function issueCode(agent: Agent, storeId: string, zoneId: string, ttl = 300): Promise<string> {
  const res = await agent.post('/api/v1/devices/pairing-codes', {
    storeId,
    zoneId,
    deviceName: 'Player do salao',
    ttlSeconds: ttl,
  });
  if (res.statusCode !== 201) throw new Error(`codigo: ${res.statusCode} ${res.body}`);
  return res.json<{ code: string }>().code;
}

describe('lojas e zonas', () => {
  let tenant: RegisteredTenant;
  beforeEach(async () => {
    tenant = await registerTenant(ctx);
  });

  it('cria loja com fuso e devolve contadores', async () => {
    const res = await tenant.agent.post('/api/v1/stores', {
      name: 'Aurora Manaus',
      timezone: 'America/Manaus',
      city: 'Manaus',
      state: 'am',
    });
    expect(res.statusCode).toBe(201);
    const { store } = res.json<{ store: { timezone: string; state: string; slug: string; zoneCount: number } }>();
    expect(store.timezone).toBe('America/Manaus');
    expect(store.state).toBe('AM'); // normalizado para maiusculo
    expect(store.slug).toBe('aurora-manaus');
    expect(store.zoneCount).toBe(0);
  });

  it('recusa fuso horario que nao existe na base IANA', async () => {
    const res = await tenant.agent.post('/api/v1/stores', {
      name: 'Fantasma',
      timezone: 'America/Nao_Existe',
    });
    expect(res.statusCode).toBe(400);
  });

  it('recusa slug duplicado na mesma organizacao', async () => {
    await createStore(tenant.agent);
    const res = await tenant.agent.post('/api/v1/stores', {
      name: 'Outro Nome',
      slug: 'aurora-centro',
      timezone: 'America/Sao_Paulo',
    });
    expect(res.statusCode).toBe(409);
  });

  it('arquiva em vez de apagar, preservando historico', async () => {
    const store = await createStore(tenant.agent);
    const res = await tenant.agent.del(`/api/v1/stores/${store.id}`);
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.db.query<{ status: string }>('select status from stores where id = $1', [
      store.id,
    ]);
    expect(rows[0]!.status).toBe('archived'); // a linha continua la
    expect((await tenant.agent.get('/api/v1/stores')).json<{ stores: unknown[] }>().stores).toHaveLength(0);
  });

  it('arquivar a loja revoga os players dela', async () => {
    const store = await createStore(tenant.agent);
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    await createAgent(ctx.app).post('/api/v1/devices/pair', { code });

    const res = await tenant.agent.del(`/api/v1/stores/${store.id}`);
    expect(res.json<{ revokedDevices: number }>().revokedDevices).toBe(1);
  });

  it('zona duplicada na mesma loja e recusada', async () => {
    const store = await createStore(tenant.agent);
    const res = await tenant.agent.post(`/api/v1/stores/${store.id}/zones`, { name: 'salao' });
    expect(res.statusCode).toBe(409);
  });
});

describe('isolamento entre organizacoes', () => {
  let a: RegisteredTenant;
  let b: RegisteredTenant;
  let storeOfA: { id: string; zoneId: string };

  beforeEach(async () => {
    a = await registerTenant(ctx, { organizationName: 'Rede A' });
    b = await registerTenant(ctx, { organizationName: 'Rede B' });
    storeOfA = await createStore(a.agent);
  });

  it('B nao ve lojas de A na listagem', async () => {
    const res = await b.agent.get('/api/v1/stores');
    expect(res.json<{ stores: unknown[] }>().stores).toHaveLength(0);
  });

  it('B pedindo a loja de A por id recebe 404, nao 403', async () => {
    const res = await b.agent.get(`/api/v1/stores/${storeOfA.id}`);
    // 403 confirmaria que o recurso existe.
    expect(res.statusCode).toBe(404);
  });

  it('B nao consegue editar nem arquivar a loja de A', async () => {
    expect((await b.agent.patch(`/api/v1/stores/${storeOfA.id}`, { name: 'Invadida' })).statusCode).toBe(404);
    expect((await b.agent.del(`/api/v1/stores/${storeOfA.id}`)).statusCode).toBe(404);

    const { rows } = await ctx.db.query<{ name: string }>('select name from stores where id = $1', [
      storeOfA.id,
    ]);
    expect(rows[0]!.name).toBe('Aurora Centro');
  });

  it('B nao cria zona dentro da loja de A', async () => {
    const res = await b.agent.post(`/api/v1/stores/${storeOfA.id}/zones`, { name: 'Invasora' });
    expect(res.statusCode).toBe(404);
  });

  it('B nao emite codigo de pareamento para a loja de A', async () => {
    const res = await b.agent.post('/api/v1/devices/pairing-codes', {
      storeId: storeOfA.id,
      zoneId: storeOfA.zoneId,
      deviceName: 'Invasor',
      ttlSeconds: 300,
    });
    expect(res.statusCode).toBe(404);
  });

  it('B nao enxerga players de A', async () => {
    const code = await issueCode(a.agent, storeOfA.id, storeOfA.zoneId);
    await createAgent(ctx.app).post('/api/v1/devices/pair', { code });

    expect((await b.agent.get('/api/v1/devices')).json<{ devices: unknown[] }>().devices).toHaveLength(0);
    expect((await a.agent.get('/api/v1/devices')).json<{ devices: unknown[] }>().devices).toHaveLength(1);
  });
});

describe('pareamento', () => {
  let tenant: RegisteredTenant;
  let store: { id: string; zoneId: string };

  beforeEach(async () => {
    tenant = await registerTenant(ctx);
    store = await createStore(tenant.agent);
  });

  it('troca o codigo por uma credencial de dispositivo', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const player = createAgent(ctx.app);
    const res = await player.post('/api/v1/devices/pair', { code });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ deviceToken: string; storeName: string; zoneName: string; timezone: string }>();
    expect(body.deviceToken).toBeTruthy();
    expect(body.storeName).toBe('Aurora Centro');
    expect(body.zoneName).toBe('Salao');
    expect(body.timezone).toBe('America/Sao_Paulo');
  });

  it('guarda o codigo apenas como hash', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const { rows } = await ctx.db.query<{ code_hash: string }>('select code_hash from device_pairing_codes');
    expect(rows[0]!.code_hash).not.toContain(code.replace('-', ''));
    expect(rows[0]!.code_hash).toHaveLength(64);
  });

  it('guarda o token do player apenas como hash', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const res = await createAgent(ctx.app).post('/api/v1/devices/pair', { code });
    const token = res.json<{ deviceToken: string }>().deviceToken;

    const { rows } = await ctx.db.query<{ token_hash: string }>('select token_hash from player_devices');
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it('o codigo e de uso unico', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    expect((await createAgent(ctx.app).post('/api/v1/devices/pair', { code })).statusCode).toBe(201);

    const segundo = await createAgent(ctx.app).post('/api/v1/devices/pair', { code });
    expect(segundo.statusCode).toBe(404);
  });

  it('o codigo expira', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    await ctx.db.query(
      `update device_pairing_codes
          set created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'`,
    );
    expect((await createAgent(ctx.app).post('/api/v1/devices/pair', { code })).statusCode).toBe(404);
  });

  it('codigo inexistente, usado e expirado dao a MESMA resposta', async () => {
    const usado = await issueCode(tenant.agent, store.id, store.zoneId);
    await createAgent(ctx.app).post('/api/v1/devices/pair', { code: usado });

    const expirado = await issueCode(tenant.agent, store.id, store.zoneId);
    await ctx.db.query(
      `update device_pairing_codes
          set created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'
        where used_at is null`,
    );

    const respostas = await Promise.all(
      [usado, expirado, 'ZZZZ-ZZZZ'].map((code) =>
        createAgent(ctx.app).post('/api/v1/devices/pair', { code }),
      ),
    );
    const mensagens = respostas.map((r) => r.json<{ error: { message: string } }>().error.message);
    // Quem tenta adivinhar nao aprende em qual dos casos caiu.
    expect(new Set(mensagens).size).toBe(1);
    expect(new Set(respostas.map((r) => r.statusCode)).size).toBe(1);
  });

  it('aceita o codigo com ou sem hifen e em minusculas', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const semHifen = code.replace('-', '').toLowerCase();
    expect((await createAgent(ctx.app).post('/api/v1/devices/pair', { code: semHifen })).statusCode).toBe(201);
  });

  it('o codigo nunca aparece na auditoria', async () => {
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const { rows } = await ctx.db.query<{ dump: string }>(
      "select coalesce(string_agg(metadata::text, ' '), '') as dump from audit_logs",
    );
    expect(rows[0]!.dump).not.toContain(code.replace('-', ''));
  });

  it('zona de outra loja no mesmo tenant e recusada', async () => {
    const outra = await createStore(tenant.agent, { name: 'Aurora Norte' });
    const res = await tenant.agent.post('/api/v1/devices/pairing-codes', {
      storeId: store.id,
      zoneId: outra.zoneId,
      deviceName: 'Cruzado',
      ttlSeconds: 300,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('operacao do player', () => {
  let tenant: RegisteredTenant;
  let store: { id: string; zoneId: string };
  let deviceId: string;

  beforeEach(async () => {
    tenant = await registerTenant(ctx);
    store = await createStore(tenant.agent);
    const code = await issueCode(tenant.agent, store.id, store.zoneId);
    const res = await createAgent(ctx.app).post('/api/v1/devices/pair', { code });
    deviceId = res.json<{ deviceId: string }>().deviceId;
  });

  it('o estado offline deriva do relogio do servidor, nao do navegador', async () => {
    // Player gravado como "active" mas sem heartbeat ha muito tempo.
    await ctx.db.query(
      "update player_devices set status = 'active', last_seen_at = now() - interval '2 hours'",
    );
    const res = await tenant.agent.get('/api/v1/devices');
    const device = res.json<{ devices: { status: string; secondsSinceLastSeen: number }[] }>().devices[0]!;
    expect(device.status).toBe('offline');
    expect(device.secondsSinceLastSeen).toBeGreaterThan(3600);
  });

  it('renomeia e move de zona dentro da mesma loja', async () => {
    const outraZona = await tenant.agent.post(`/api/v1/stores/${store.id}/zones`, { name: 'Caixas' });
    const zoneId = outraZona.json<{ zone: { id: string } }>().zone.id;

    const res = await tenant.agent.patch(`/api/v1/devices/${deviceId}`, {
      name: 'Player dos caixas',
      zoneId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ device: { name: string; zoneName: string } }>().device.zoneName).toBe('Caixas');
  });

  it('recusa mover o player para zona de outra loja', async () => {
    const outraLoja = await createStore(tenant.agent, { name: 'Aurora Norte' });
    const res = await tenant.agent.patch(`/api/v1/devices/${deviceId}`, { zoneId: outraLoja.zoneId });
    expect(res.statusCode).toBe(400);
  });

  it('revoga e explica a limitacao de dispositivo offline', async () => {
    const res = await tenant.agent.post(`/api/v1/devices/${deviceId}/revoke`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ revoked: boolean; note: string }>();
    expect(body.revoked).toBe(true);
    // Honestidade: nao prometemos corte instantaneo que o navegador nao entrega.
    expect(body.note).toMatch(/offline/i);

    const { rows } = await ctx.db.query<{ status: string }>('select status from player_devices');
    expect(rows[0]!.status).toBe('revoked');
  });

  it('revogar duas vezes e idempotente', async () => {
    await tenant.agent.post(`/api/v1/devices/${deviceId}/revoke`);
    const segunda = await tenant.agent.post(`/api/v1/devices/${deviceId}/revoke`);
    expect(segunda.json<{ alreadyRevoked: boolean }>().alreadyRevoked).toBe(true);
  });
});

describe('limites de plano', () => {
  it('bloqueia a criacao de loja alem da cota, com motivo acionavel', async () => {
    const tenant = await registerTenant(ctx);
    // Rebaixa para o plano de 1 loja.
    await ctx.db.query(
      "update subscriptions set plan_id = (select id from plans where code = 'starter')",
    );

    await createStore(tenant.agent);
    const res = await tenant.agent.post('/api/v1/stores', {
      name: 'Segunda loja',
      timezone: 'America/Sao_Paulo',
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; action: string } }>();
    expect(body.error.code).toBe('plan_limit_reached');
    expect(body.error.action).toBeTruthy();
  });

  it('bloqueia pareamento alem da cota de players', async () => {
    const tenant = await registerTenant(ctx);
    await ctx.db.query(
      "update subscriptions set plan_id = (select id from plans where code = 'starter')",
    );
    const store = await createStore(tenant.agent);

    for (let i = 0; i < 2; i += 1) {
      const code = await issueCode(tenant.agent, store.id, store.zoneId);
      await createAgent(ctx.app).post('/api/v1/devices/pair', { code });
    }

    const res = await tenant.agent.post('/api/v1/devices/pairing-codes', {
      storeId: store.id,
      zoneId: store.zoneId,
      deviceName: 'Terceiro',
      ttlSeconds: 300,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('plan_limit_reached');
  });
});
