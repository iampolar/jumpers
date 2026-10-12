import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  registerTenant,
  type Agent,
  type RegisteredTenant,
  type TestContext,
} from '../../testing/harness.js';
import { wavTone } from '../../testing/audio.js';

let ctx: TestContext;
let tenant: RegisteredTenant;

beforeEach(async () => {
  ctx = await createTestContext();
  tenant = await registerTenant(ctx);
});

afterEach(async () => {
  await ctx.close();
});

// --------------------------------------------------------------------------
// Auxiliares de montagem
// --------------------------------------------------------------------------

async function uploadAudio(agent: Agent, seconds: number, kind: string, name: string): Promise<string> {
  const bytes = wavTone(seconds, 440 + Math.round(Math.random() * 400));
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
  if (res.statusCode !== 200) throw new Error(`upload ${name}: ${res.statusCode} ${res.body}`);
  return res.json<{ asset: { id: string } }>().asset.id;
}

async function createStore(agent: Agent, name: string, timezone: string) {
  const store = await agent.post('/api/v1/stores', { name, timezone });
  const id = store.json<{ store: { id: string } }>().store.id;
  const zone = await agent.post(`/api/v1/stores/${id}/zones`, { name: 'Salao' });
  return { id, zoneId: zone.json<{ zone: { id: string } }>().zone.id };
}

describe('playlists', () => {
  it('monta playlist com musicas e spot, e calcula duracao total', async () => {
    const m1 = await uploadAudio(tenant.agent, 120, 'music', 'faixa1');
    const m2 = await uploadAudio(tenant.agent, 150, 'music', 'faixa2');

    const created = await tenant.agent.post('/api/v1/playlists', { name: 'Ambiente' });
    expect(created.statusCode).toBe(201);
    const playlistId = created.json<{ playlist: { id: string } }>().playlist.id;

    for (const mediaAssetId of [m1, m2]) {
      const res = await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, {
        itemType: 'music',
        mediaAssetId,
      });
      expect(res.statusCode).toBe(201);
    }

    const final = await tenant.agent.get(`/api/v1/playlists/${playlistId}`);
    const playlist = final.json<{ playlist: { musicCount: number; totalDurationMs: number } }>().playlist;
    expect(playlist.musicCount).toBe(2);
    expect(playlist.totalDurationMs).toBe(270_000);
  });

  it('recusa item apontando para audio de outra organizacao', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const audioDeOutro = await uploadAudio(outro.agent, 60, 'music', 'alheia');

    const playlist = await tenant.agent.post('/api/v1/playlists', { name: 'Ambiente' });
    const playlistId = playlist.json<{ playlist: { id: string } }>().playlist.id;

    const res = await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, {
      itemType: 'music',
      mediaAssetId: audioDeOutro,
    });
    expect(res.statusCode).toBe(404);
  });

  it('recusa audio que ainda nao esta pronto', async () => {
    const ticket = await tenant.agent.post('/api/v1/media/uploads', {
      filename: 'pendente.wav',
      sizeBytes: 1000,
      kind: 'music',
      rightsAttested: true,
    });
    const pendente = ticket.json<{ mediaAssetId: string }>().mediaAssetId;

    const playlist = await tenant.agent.post('/api/v1/playlists', { name: 'Ambiente' });
    const playlistId = playlist.json<{ playlist: { id: string } }>().playlist.id;

    const res = await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, {
      itemType: 'music',
      mediaAssetId: pendente,
    });
    expect(res.statusCode).toBe(409);
  });

  it('reordena itens e recusa id de outra playlist', async () => {
    const m1 = await uploadAudio(tenant.agent, 60, 'music', 'a');
    const m2 = await uploadAudio(tenant.agent, 60, 'music', 'b');
    const p = await tenant.agent.post('/api/v1/playlists', { name: 'Playlist de teste' });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;

    for (const id of [m1, m2]) {
      await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, { itemType: 'music', mediaAssetId: id });
    }
    const before = (await tenant.agent.get(`/api/v1/playlists/${playlistId}`)).json<{
      playlist: { items: { id: string }[] };
    }>().playlist.items;

    const reordered = await tenant.agent.post(`/api/v1/playlists/${playlistId}/reorder`, {
      itemIds: [before[1]!.id, before[0]!.id],
    });
    expect(reordered.statusCode).toBe(200);
    const after = reordered.json<{ playlist: { items: { id: string }[] } }>().playlist.items;
    expect(after[0]!.id).toBe(before[1]!.id);

    const invalido = await tenant.agent.post(`/api/v1/playlists/${playlistId}/reorder`, {
      itemIds: ['00000000-0000-0000-0000-000000000001'],
    });
    expect(invalido.statusCode).toBe(400);
  });
});

describe('previa da rotacao', () => {
  it('insere o spot entre as musicas, como o player fara', async () => {
    const musicas = await Promise.all([
      uploadAudio(tenant.agent, 120, 'music', 'm1'),
      uploadAudio(tenant.agent, 120, 'music', 'm2'),
      uploadAudio(tenant.agent, 120, 'music', 'm3'),
    ]);
    const spotAudio = await uploadAudio(tenant.agent, 20, 'voice_over', 'spot');

    const p = await tenant.agent.post('/api/v1/playlists', {
      name: 'Com spots',
      rotationRules: { insertionMode: 'every_n_tracks', everyNTracks: 2, musicOrder: 'sequential' },
    });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;
    for (const mediaAssetId of musicas) {
      await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, { itemType: 'music', mediaAssetId });
    }

    // Anuncio publicado, com audio: so assim entra na rotacao.
    const ann = await tenant.agent.post('/api/v1/announcements', {
      title: 'Oferta do dia',
      scriptText: 'Hoje, cafe por R$ 19,90.',
      mediaAssetId: spotAudio,
    });
    const announcementId = ann.json<{ announcement: { id: string } }>().announcement.id;
    await tenant.agent.post(`/api/v1/announcements/${announcementId}/actions`, { action: 'approve' });
    await tenant.agent.post(`/api/v1/announcements/${announcementId}/actions`, { action: 'schedule' });

    await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, {
      itemType: 'promo_spot',
      announcementId,
    });

    const preview = await tenant.agent.get(`/api/v1/playlists/${playlistId}/preview?minutes=30`);
    expect(preview.statusCode).toBe(200);
    const { slots } = preview.json<{ slots: { itemType: string }[] }>();
    expect(slots.slice(0, 3).map((s) => s.itemType)).toEqual(['music', 'music', 'promo_spot']);
  });

  it('explica por que um spot ficou de fora, em vez de silenciar', async () => {
    await uploadAudio(tenant.agent, 120, 'music', 'm1');
    const spotAudio = await uploadAudio(tenant.agent, 20, 'voice_over', 'spot');

    const p = await tenant.agent.post('/api/v1/playlists', { name: 'Playlist de teste' });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;

    // Anuncio criado mas NAO publicado: nao deve entrar.
    const ann = await tenant.agent.post('/api/v1/announcements', {
      title: 'Rascunho',
      scriptText: 'Ainda nao publicado.',
      mediaAssetId: spotAudio,
    });
    const announcementId = ann.json<{ announcement: { id: string } }>().announcement.id;
    await tenant.agent.post(`/api/v1/playlists/${playlistId}/items`, {
      itemType: 'promo_spot',
      announcementId,
    });

    const preview = await tenant.agent.get(`/api/v1/playlists/${playlistId}/preview?minutes=30`);
    const { excluded } = preview.json<{ excluded: { reason: string; title: string }[] }>();
    expect(excluded.some((e) => e.reason === 'disabled')).toBe(true);
  });
});

describe('agenda e fuso', () => {
  it('a mesma regra de 09:00 produz grades diferentes em fusos diferentes', async () => {
    const sp = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const mao = await createStore(tenant.agent, 'Aurora Manaus', 'America/Manaus');
    const p = await tenant.agent.post('/api/v1/playlists', { name: 'Comercial' });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;

    for (const store of [sp, mao]) {
      const res = await tenant.agent.post('/api/v1/schedules', {
        name: 'Comercial',
        storeId: store.id,
        playlistId,
        weekdays: [1, 2, 3, 4, 5],
        startLocalTime: '09:00',
        endLocalTime: '18:00',
      });
      expect(res.statusCode).toBe(201);
    }

    const calSp = await tenant.agent.get(
      `/api/v1/schedules/calendar?storeId=${sp.id}&from=2026-03-16&to=2026-03-16`,
    );
    const calMao = await tenant.agent.get(
      `/api/v1/schedules/calendar?storeId=${mao.id}&from=2026-03-16&to=2026-03-16`,
    );

    expect(calSp.json<{ timezone: string }>().timezone).toBe('America/Sao_Paulo');
    expect(calMao.json<{ timezone: string }>().timezone).toBe('America/Manaus');

    // As duas tem um bloco de programacao das 09:00 as 18:00 LOCAIS, que sao
    // instantes UTC diferentes -- exatamente a realidade de uma rede.
    for (const cal of [calSp, calMao]) {
      const blocks = cal.json<{ days: { blocks: { kind: string; startLocalTime: string; endLocalTime: string }[] }[] }>()
        .days[0]!.blocks;
      const programa = blocks.find((b) => b.kind === 'program')!;
      expect(programa.startLocalTime).toBe('09:00');
      expect(programa.endLocalTime).toBe('18:00');
    }
  });

  it('feriado como blackout silencia o dia inteiro', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const p = await tenant.agent.post('/api/v1/playlists', { name: 'Comercial' });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;
    await tenant.agent.post('/api/v1/schedules', {
      name: 'Comercial',
      storeId: store.id,
      playlistId,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startLocalTime: '08:00',
      endLocalTime: '22:00',
    });

    const exc = await tenant.agent.post('/api/v1/schedules/exceptions', {
      storeId: store.id,
      localDate: '2026-04-21',
      kind: 'blackout',
      label: 'Tiradentes',
    });
    expect(exc.statusCode).toBe(201);

    const cal = await tenant.agent.get(
      `/api/v1/schedules/calendar?storeId=${store.id}&from=2026-04-21&to=2026-04-22`,
    );
    const days = cal.json<{ days: { localDate: string; blocks: { kind: string; label: string }[] }[] }>().days;

    const feriado = days.find((d) => d.localDate === '2026-04-21')!;
    expect(feriado.blocks).toHaveLength(1);
    expect(feriado.blocks[0]!.kind).toBe('blackout');
    expect(feriado.blocks[0]!.label).toBe('Tiradentes');

    // O dia seguinte volta ao normal.
    const seguinte = days.find((d) => d.localDate === '2026-04-22')!;
    expect(seguinte.blocks.some((b) => b.kind === 'program')).toBe(true);
  });

  it('/schedules/now diz o que toca agora e ate quando', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const p = await tenant.agent.post('/api/v1/playlists', { name: 'Integral' });
    const playlistId = p.json<{ playlist: { id: string } }>().playlist.id;
    await tenant.agent.post('/api/v1/schedules', {
      name: 'Integral',
      storeId: store.id,
      playlistId,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startLocalTime: '00:00',
      endLocalTime: '23:59',
    });

    const res = await tenant.agent.get(`/api/v1/schedules/now?storeId=${store.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ playing: boolean; playlistName: string; windowEndsAt: string; timezone: string }>();
    expect(body.playing).toBe(true);
    expect(body.playlistName).toBe('Integral');
    expect(body.timezone).toBe('America/Sao_Paulo');
    expect(new Date(body.windowEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('loja sem agenda relata o motivo do silencio', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const res = await tenant.agent.get(`/api/v1/schedules/now?storeId=${store.id}`);
    const body = res.json<{ playing: boolean; idleReason: string }>();
    expect(body.playing).toBe(false);
    // Nunca dizemos "tocando" quando nao ha o que tocar.
    expect(['no_schedule', 'outside_opening_hours']).toContain(body.idleReason);
  });

  it('agenda de outra organizacao nao e acessivel', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const res = await outro.agent.get(`/api/v1/schedules/now?storeId=${store.id}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('campanhas', () => {
  it('cria, publica e encerra seguindo a maquina de estados', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');

    const created = await tenant.agent.post('/api/v1/campaigns', {
      name: 'Semana do cafe',
      startsAt: '2026-05-01T03:00:00.000Z',
      endsAt: '2026-05-08T03:00:00.000Z',
      storeIds: [store.id],
    });
    expect(created.statusCode).toBe(201);
    const campaign = created.json<{ campaign: { id: string; status: string; availableActions: string[] } }>()
      .campaign;
    expect(campaign.status).toBe('draft');
    expect(campaign.availableActions).toContain('publish');

    const publicada = await tenant.agent.post(`/api/v1/campaigns/${campaign.id}/actions`, {
      action: 'publish',
    });
    expect(publicada.json<{ campaign: { status: string } }>().campaign.status).toBe('scheduled');

    // Transicao ilegal e recusada pelo servidor, nao escondida pela UI.
    const ilegal = await tenant.agent.post(`/api/v1/campaigns/${campaign.id}/actions`, {
      action: 'resume',
    });
    expect(ilegal.statusCode).toBe(400);
    expect(ilegal.json<{ error: { code: string } }>().error.code).toBe('invalid_state_transition');
  });

  it('recusa campanha com fim antes do inicio', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const res = await tenant.agent.post('/api/v1/campaigns', {
      name: 'Invertida',
      startsAt: '2026-05-10T00:00:00.000Z',
      endsAt: '2026-05-01T00:00:00.000Z',
      storeIds: [store.id],
    });
    expect(res.statusCode).toBe(400);
  });

  it('recusa loja de outra organizacao no alvo', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const lojaAlheia = await createStore(outro.agent, 'Boreal', 'America/Sao_Paulo');

    const res = await tenant.agent.post('/api/v1/campaigns', {
      name: 'Invasora',
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-05-08T00:00:00.000Z',
      storeIds: [lojaAlheia.id],
    });
    expect(res.statusCode).toBe(400);
  });

  it('o relatorio deixa claro que conta execucoes, nao audiencia', async () => {
    const store = await createStore(tenant.agent, 'Aurora Centro', 'America/Sao_Paulo');
    const created = await tenant.agent.post('/api/v1/campaigns', {
      name: 'Campanha',
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-05-08T00:00:00.000Z',
      storeIds: [store.id],
    });
    const id = created.json<{ campaign: { id: string } }>().campaign.id;

    const report = await tenant.agent.get(`/api/v1/campaigns/${id}/report`);
    expect(report.statusCode).toBe(200);
    const body = report.json<{ campaign: { stats: { started: number } }; disclaimer: string }>();
    expect(body.campaign.stats.started).toBe(0);
    expect(body.disclaimer).toMatch(/nao quantas pessoas/i);
  });
});
