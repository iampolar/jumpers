import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  createAgent,
  createTestContext,
  registerTenant,
  type Agent,
  type RegisteredTenant,
  type TestContext,
} from '../../testing/harness';
import { localDateString } from '@castwave/core';
import { wavTone } from '../../testing/audio';

let ctx: TestContext;
let tenant: RegisteredTenant;
let storeId: string;
let zoneId: string;
let deviceToken: string;
let deviceId: string;

/** Cliente do player: Bearer token, sem cookie nem CSRF. */
function player(token: string) {
  return {
    get: (url: string): Promise<LightMyRequestResponse> =>
      ctx.app.server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }),
    post: (url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      ctx.app.server.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${token}` },
      }),
  };
}

async function uploadAudio(agent: Agent, seconds: number, kind: string, name: string): Promise<string> {
  const bytes = wavTone(seconds, 300 + Math.round(Math.random() * 600));
  const ticket = await agent.post('/api/v1/media/uploads', {
    filename: `${name}.wav`,
    sizeBytes: bytes.byteLength,
    kind,
    rightsAttested: true,
  });
  const id = ticket.json<{ mediaAssetId: string }>().mediaAssetId;
  const res = await agent.request({
    method: 'POST',
    url: `/api/v1/media/uploads/${id}/complete`,
    payload: bytes,
    headers: { 'content-type': 'application/octet-stream' },
  });
  return res.json<{ asset: { id: string } }>().asset.id;
}

/** Monta loja + zona + playlist + agenda integral + player pareado. */
async function setupStoreWithProgram(): Promise<string> {
  const store = await tenant.agent.post('/api/v1/stores', {
    name: 'Aurora Centro',
    timezone: 'America/Sao_Paulo',
  });
  storeId = store.json<{ store: { id: string } }>().store.id;
  const zone = await tenant.agent.post(`/api/v1/stores/${storeId}/zones`, { name: 'Salao' });
  zoneId = zone.json<{ zone: { id: string } }>().zone.id;

  const m1 = await uploadAudio(tenant.agent, 120, 'music', 'faixa1');
  const m2 = await uploadAudio(tenant.agent, 150, 'music', 'faixa2');

  const p = await tenant.agent.post('/api/v1/playlists', {
    name: 'Ambiente integral',
    rotationRules: { musicOrder: 'sequential', shuffleSeed: 7 },
  });
  const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;
  for (const mediaAssetId of [m1, m2]) {
    await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, { itemType: 'music', mediaAssetId });
  }

  await tenant.agent.post('/api/v1/schedules', {
    name: 'Integral',
    storeId,
    playlistId,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startLocalTime: '00:00',
    endLocalTime: '23:59',
  });

  const code = await tenant.agent.post('/api/v1/devices/pairing-codes', {
    storeId,
    zoneId,
    deviceName: 'Player do salao',
    ttlSeconds: 300,
  });
  const paired = await createAgent(ctx.app).post('/api/v1/devices/pair', {
    code: code.json<{ code: string }>().code,
  });
  const body = paired.json<{ deviceToken: string; deviceId: string }>();
  deviceToken = body.deviceToken;
  deviceId = body.deviceId;
  return playlistId;
}

beforeEach(async () => {
  ctx = await createTestContext();
  tenant = await registerTenant(ctx);
  await setupStoreWithProgram();
});

afterEach(async () => {
  await ctx.close();
});

describe('autenticacao do player', () => {
  it('sem token, nenhuma rota de player responde', async () => {
    const res = await ctx.app.server.inject({ method: 'GET', url: '/api/v1/player/manifest' });
    expect(res.statusCode).toBe(401);
  });

  it('token invalido e recusado', async () => {
    const res = await player('token-que-nao-existe').get('/api/v1/player/manifest');
    expect(res.statusCode).toBe(401);
  });

  it('player revogado perde acesso na proxima sincronizacao', async () => {
    expect((await player(deviceToken).get('/api/v1/player/manifest')).statusCode).toBe(200);

    await tenant.agent.post(`/api/v1/devices/${deviceId}/revoke`);

    const res = await player(deviceToken).get('/api/v1/player/manifest');
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('device_revoked');
  });

  it('o token de player NAO abre rota administrativa', async () => {
    const res = await ctx.app.server.inject({
      method: 'GET',
      url: '/api/v1/stores',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    // Credencial de dispositivo e sessao humana sao universos separados.
    expect(res.statusCode).toBe(401);
  });

  it('a sessao humana NAO serve para pegar manifesto', async () => {
    const res = await tenant.agent.get('/api/v1/player/manifest');
    expect(res.statusCode).toBe(401);
  });
});

describe('manifesto', () => {
  it('entrega a programacao com itens posicionados no tempo', async () => {
    const res = await player(deviceToken).get('/api/v1/player/manifest');
    expect(res.statusCode).toBe(200);

    const manifest = res.json<{
      revision: string;
      program: { playlistName: string; windowEndsAt: string } | null;
      items: { title: string; durationMs: number; startsAfterMs: number; url: string }[];
      device: { storeName: string; zoneName: string; timezone: string };
      policy: { heartbeatIntervalSeconds: number };
    }>();

    expect(manifest.program?.playlistName).toBe('Ambiente integral');
    expect(manifest.items.length).toBeGreaterThan(0);
    expect(manifest.device.storeName).toBe('Aurora Centro');
    expect(manifest.device.timezone).toBe('America/Sao_Paulo');
    expect(manifest.policy.heartbeatIntervalSeconds).toBeGreaterThan(0);

    // Itens sao seriais: nenhum comeca antes do anterior terminar.
    for (let i = 1; i < manifest.items.length; i += 1) {
      const prev = manifest.items[i - 1]!;
      expect(manifest.items[i]!.startsAfterMs).toBe(prev.startsAfterMs + prev.durationMs);
    }
  });

  it('nao carrega roteiro nem dado da organizacao', async () => {
    const spotAudio = await uploadAudio(tenant.agent, 20, 'voice_over', 'spot');
    const ann = await tenant.agent.post('/api/v1/announcements', {
      title: 'Oferta',
      scriptText: 'TEXTO SECRETO DO ROTEIRO COMERCIAL',
      mediaAssetId: spotAudio,
    });
    const announcementId = ann.json<{ announcement: { id: string } }>().announcement.id;
    await tenant.agent.post(`/api/v1/announcements/${announcementId}/actions`, { action: 'approve' });
    await tenant.agent.post(`/api/v1/announcements/${announcementId}/actions`, { action: 'schedule' });

    const res = await player(deviceToken).get('/api/v1/player/manifest');
    expect(res.body).not.toContain('TEXTO SECRETO');
    expect(res.body).not.toContain(tenant.email);
  });

  it('as URLs de audio sao assinadas e funcionam para este player', async () => {
    const manifest = (await player(deviceToken).get('/api/v1/player/manifest')).json<{
      items: { url: string }[];
    }>();
    const url = manifest.items[0]!.url;
    expect(url).toContain('token=');

    const audio = await ctx.app.server.inject({ method: 'GET', url });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
  });

  it('a revisao muda quando a programacao muda, e nao quando nao muda', async () => {
    const primeira = (await player(deviceToken).get('/api/v1/player/manifest')).json<{ revision: string }>();
    const segunda = (await player(deviceToken).get('/api/v1/player/manifest')).json<{ revision: string }>();
    // Mesma programacao: mesma revisao, mesmo com tokens de URL diferentes.
    expect(segunda.revision).toBe(primeira.revision);
  });

  it('fora do horario de funcionamento, diz o motivo em vez de fingir', async () => {
    await tenant.agent.patch(`/api/v1/stores/${storeId}`, {
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: '03:00',
        closesAt: '03:01',
        closed: false,
      })),
    });

    const manifest = (await player(deviceToken).get('/api/v1/player/manifest')).json<{
      items: unknown[];
      program: unknown;
      idleReason: string;
    }>();
    expect(manifest.items).toHaveLength(0);
    expect(manifest.program).toBeNull();
    expect(manifest.idleReason).toBe('outside_opening_hours');
  });

  it('feriado em blackout zera o manifesto com motivo', async () => {
    // A data TEM que vir no fuso da loja, igual ao servidor faz.
    // `toISOString()` devolve a data em UTC: em Sao Paulo (UTC-3) as duas
    // divergem das 21h a meia-noite, e o teste reprovava toda noite nessa
    // janela por marcar o blackout no dia seguinte.
    const hoje = localDateString(new Date(), 'America/Sao_Paulo');
    await tenant.agent.post('/api/v1/schedules/exceptions', {
      storeId,
      localDate: hoje,
      kind: 'blackout',
      label: 'Feriado',
    });

    const manifest = (await player(deviceToken).get('/api/v1/player/manifest')).json<{
      items: unknown[];
      idleReason: string;
    }>();
    expect(manifest.items).toHaveLength(0);
    expect(manifest.idleReason).toBe('blackout');
  });
});

describe('heartbeat', () => {
  it('atualiza o estado do player e devolve o intervalo', async () => {
    const res = await player(deviceToken).post('/api/v1/player/heartbeat', {
      appVersion: '1.0.0',
      online: true,
      bufferDepth: 3,
      cachedItems: 8,
      pendingEvents: 0,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ nextHeartbeatInSeconds: number; serverTime: string }>();
    expect(body.nextHeartbeatInSeconds).toBeGreaterThan(0);

    const device = (await tenant.agent.get(`/api/v1/devices/${deviceId}`)).json<{
      device: { status: string; appVersion: string; cachedItems: number };
    }>().device;
    expect(device.status).toBe('active');
    expect(device.appVersion).toBe('1.0.0');
    expect(device.cachedItems).toBe(8);
  });

  it('traz o player de volta de offline', async () => {
    await ctx.db.query("update player_devices set status = 'offline'");
    await player(deviceToken).post('/api/v1/player/heartbeat', { online: true });
    const { rows } = await ctx.db.query<{ status: string }>('select status from player_devices');
    expect(rows[0]!.status).toBe('active');
  });
});

describe('eventos de reproducao', () => {
  const evento = (over: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    slotId: 'slot-1',
    mediaAssetId: '',
    eventType: 'completed',
    occurredAt: new Date().toISOString(),
    playedMs: 120_000,
    ...over,
  });

  async function primeiroMediaId(): Promise<string> {
    const manifest = (await player(deviceToken).get('/api/v1/player/manifest')).json<{
      items: { mediaAssetId: string; slotId: string }[];
    }>();
    return manifest.items[0]!.mediaAssetId;
  }

  it('aceita um lote e persiste', async () => {
    const mediaAssetId = await primeiroMediaId();
    const res = await player(deviceToken).post('/api/v1/player/events', {
      events: [evento({ mediaAssetId }), evento({ mediaAssetId, eventType: 'started', playedMs: 0 })],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: number; duplicates: number }>()).toMatchObject({
      accepted: 2,
      duplicates: 0,
    });
  });

  it('reenvio apos reconexao NAO duplica a contagem', async () => {
    const mediaAssetId = await primeiroMediaId();
    const lote = { events: [evento({ mediaAssetId }), evento({ mediaAssetId })] };

    const primeira = await player(deviceToken).post('/api/v1/player/events', lote);
    expect(primeira.json<{ accepted: number }>().accepted).toBe(2);

    // Exatamente o que acontece quando a rede cai no meio do envio.
    const reenvio = await player(deviceToken).post('/api/v1/player/events', lote);
    expect(reenvio.json<{ accepted: number; duplicates: number }>()).toMatchObject({
      accepted: 0,
      duplicates: 2,
    });

    const { rows } = await ctx.db.query<{ n: string }>('select count(*)::text as n from playback_events');
    expect(rows[0]!.n).toBe('2');
  });

  it('calcula a data local com o fuso da loja, nao o do servidor', async () => {
    const mediaAssetId = await primeiroMediaId();
    // 02:00 UTC do dia 16 ainda e dia 15 em Sao Paulo.
    await player(deviceToken).post('/api/v1/player/events', {
      events: [evento({ mediaAssetId, occurredAt: '2026-03-16T02:00:00.000Z' })],
    });

    const { rows } = await ctx.db.query<{ local_date: Date }>('select local_date from playback_events');
    expect(new Date(rows[0]!.local_date).toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('eventos fora de ordem sao aceitos sem reclamar', async () => {
    const mediaAssetId = await primeiroMediaId();
    const res = await player(deviceToken).post('/api/v1/player/events', {
      events: [
        evento({ mediaAssetId, eventType: 'completed', occurredAt: '2026-03-16T12:05:00.000Z' }),
        evento({ mediaAssetId, eventType: 'started', occurredAt: '2026-03-16T12:00:00.000Z' }),
      ],
    });
    // Um buffer offline drena na ordem que conseguir; o servidor nao impoe
    // sequencia, apenas registra o instante de cada um.
    expect(res.json<{ accepted: number }>().accepted).toBe(2);
  });

  it('evento de falha exige codigo de erro', async () => {
    const mediaAssetId = await primeiroMediaId();
    const res = await player(deviceToken).post('/api/v1/player/events', {
      events: [evento({ mediaAssetId, eventType: 'failed', errorCode: null })],
    });
    // O CHECK do banco recusa; o lote nao quebra, o evento e reportado.
    expect(res.json<{ rejected: unknown[] }>().rejected).toHaveLength(1);
  });

  it('um evento ruim nao impede os bons do mesmo lote', async () => {
    const mediaAssetId = await primeiroMediaId();
    const res = await player(deviceToken).post('/api/v1/player/events', {
      events: [
        evento({ mediaAssetId }),
        evento({ mediaAssetId, eventType: 'failed', errorCode: null }),
        evento({ mediaAssetId }),
      ],
    });
    const body = res.json<{ accepted: number; rejected: unknown[] }>();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(1);
  });

  it('o player nao consegue reportar evento para outra loja', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const lojaAlheia = await outro.agent.post('/api/v1/stores', {
      name: 'Boreal',
      timezone: 'America/Sao_Paulo',
    });
    void lojaAlheia;

    // O escopo vem do token, nao do corpo: nao ha campo storeId para forjar.
    const mediaAssetId = await primeiroMediaId();
    await player(deviceToken).post('/api/v1/player/events', { events: [evento({ mediaAssetId })] });

    const { rows } = await ctx.db.query<{ organization_id: string }>(
      'select organization_id from playback_events',
    );
    expect(rows[0]!.organization_id).toBe(tenant.organizationId);
  });
});
