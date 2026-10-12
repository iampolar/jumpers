import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, registerTenant, type Agent, type RegisteredTenant, type TestContext } from '../../testing/harness.js';
import { mp3DurationMs, mp3Vbr, PAYLOADS_NAO_AUDIO, wavTone } from '../../testing/audio.js';

let ctx: TestContext;
let tenant: RegisteredTenant;

beforeEach(async () => {
  ctx = await createTestContext();
  tenant = await registerTenant(ctx);
});

afterEach(async () => {
  await ctx.close();
});

interface UploadResult {
  statusCode: number;
  assetId: string | null;
  body: Record<string, unknown>;
}

/** Executa o fluxo completo de upload: ticket + bytes. */
async function upload(
  agent: Agent,
  bytes: Buffer,
  options: { filename?: string; kind?: string; contentType?: string } = {},
): Promise<UploadResult> {
  const ticket = await agent.post('/api/v1/media/uploads', {
    filename: options.filename ?? 'spot.wav',
    sizeBytes: bytes.byteLength || 1,
    kind: options.kind ?? 'voice_over',
    rightsAttested: true,
  });
  if (ticket.statusCode !== 201) {
    return { statusCode: ticket.statusCode, assetId: null, body: ticket.json() };
  }

  const assetId = ticket.json<{ mediaAssetId: string }>().mediaAssetId;
  const res = await agent.request({
    method: 'POST',
    url: `/api/v1/media/uploads/${assetId}/complete`,
    payload: bytes,
    headers: { 'content-type': options.contentType ?? 'application/octet-stream' },
  });
  return { statusCode: res.statusCode, assetId, body: res.json() };
}

describe('upload valido', () => {
  it('aceita WAV e extrai duracao, taxa e canais reais', async () => {
    const res = await upload(tenant.agent, wavTone(12));
    expect(res.statusCode).toBe(200);

    const asset = (res.body as { asset: Record<string, unknown> }).asset;
    expect(asset.status).toBe('ready');
    expect(asset.durationMs).toBe(12_000);
    expect(asset.sampleRate).toBe(44100);
    expect(asset.channels).toBe(1);
    expect(asset.mimeType).toBe('audio/wav');
  });

  it('aceita MP3 VBR com duracao exata da tag Xing', async () => {
    const res = await upload(tenant.agent, mp3Vbr(500), { filename: 'jingle.mp3' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { asset: { durationMs: number } }).asset.durationMs).toBe(mp3DurationMs(500));
  });

  it('calcula o checksum no servidor, sobre os bytes recebidos', async () => {
    const bytes = wavTone(3);
    const res = await upload(tenant.agent, bytes);
    const asset = (res.body as { asset: { checksumSha256: string; sizeBytes: number } }).asset;

    const { createHash } = await import('node:crypto');
    expect(asset.checksumSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(asset.sizeBytes).toBe(bytes.byteLength);
  });

  it('informa que a duracao veio do cabecalho quando nao ha FFmpeg', async () => {
    const res = await upload(tenant.agent, wavTone(2));
    // Transparencia: nao fingimos ter medido loudness.
    expect((res.body as { probedBy: string }).probedBy).toBe('native-header');
    expect((res.body as { loudnessMeasured: boolean }).loudnessMeasured).toBe(false);
    expect((res.body as { asset: { loudnessLufs: null } }).asset.loudnessLufs).toBeNull();
  });

  it('registra quem atestou os direitos de execucao', async () => {
    await upload(tenant.agent, wavTone(2));
    const { rows } = await ctx.db.query<{ rights_attested_at: Date | null; rights_attested_by: string | null }>(
      'select rights_attested_at, rights_attested_by from media_assets',
    );
    expect(rows[0]!.rights_attested_at).not.toBeNull();
    expect(rows[0]!.rights_attested_by).toBe(tenant.userId);
  });

  it('exige a declaracao de direitos para abrir o upload', async () => {
    const res = await tenant.agent.post('/api/v1/media/uploads', {
      filename: 'musica.mp3',
      sizeBytes: 1000,
      kind: 'music',
      rightsAttested: false,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/direitos/i);
  });
});

describe('arquivos recusados', () => {
  it('recusa ZIP, SVG com script, HTML e executavel disfarcados de audio', async () => {
    for (const [nome, bytes] of Object.entries(PAYLOADS_NAO_AUDIO)) {
      if (nome === 'vazio') continue;
      const res = await upload(tenant.agent, bytes, { filename: `${nome}.mp3` });
      expect(res.statusCode, nome).toBeGreaterThanOrEqual(400);
      const code = (res.body as { error: { code: string } }).error.code;
      expect(['unsupported_media_type', 'unprocessable_media'], nome).toContain(code);
    }
  });

  it('o arquivo recusado nunca fica como "ready"', async () => {
    await upload(tenant.agent, PAYLOADS_NAO_AUDIO.zip, { filename: 'malicioso.mp3' });
    const { rows } = await ctx.db.query<{ status: string }>('select status from media_assets');
    expect(rows[0]!.status).toBe('failed');

    // E nao aparece na biblioteca por padrao.
    const lista = await tenant.agent.get('/api/v1/media');
    expect(lista.json<{ media: unknown[] }>().media.filter((m) => (m as { status: string }).status === 'ready')).toHaveLength(0);
  });

  it('recusa audio de duracao zero', async () => {
    const res = await upload(tenant.agent, wavTone(0));
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/duracao zero/i);
  });

  it('recusa spot acima do limite de duracao', async () => {
    // Limite de spot e 3 min; 4 min deve ser recusado.
    const res = await upload(tenant.agent, wavTone(240), { kind: 'voice_over' });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/excede o limite/i);
  });

  it('aceita faixa musical longa, que tem limite maior', async () => {
    const res = await upload(tenant.agent, wavTone(240), { kind: 'music', filename: 'faixa.wav' });
    expect(res.statusCode).toBe(200);
  });

  it('nao permite concluir o mesmo upload duas vezes', async () => {
    const ticket = await tenant.agent.post('/api/v1/media/uploads', {
      filename: 'spot.wav',
      sizeBytes: 1000,
      kind: 'voice_over',
      rightsAttested: true,
    });
    const assetId = ticket.json<{ mediaAssetId: string }>().mediaAssetId;
    const send = () =>
      tenant.agent.request({
        method: 'POST',
        url: `/api/v1/media/uploads/${assetId}/complete`,
        payload: wavTone(2),
        headers: { 'content-type': 'application/octet-stream' },
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(409);
  });

  it('deduplica arquivo identico em vez de ocupar espaco em dobro', async () => {
    const bytes = wavTone(5);
    expect((await upload(tenant.agent, bytes)).statusCode).toBe(200);

    const segundo = await upload(tenant.agent, bytes, { filename: 'copia.wav' });
    expect(segundo.statusCode).toBe(409);
    expect(JSON.stringify(segundo.body)).toMatch(/ja esta na biblioteca/i);

    const { rows } = await ctx.db.query<{ n: string }>('select count(*)::text as n from media_assets');
    expect(rows[0]!.n).toBe('1');
  });
});

describe('entrega do audio', () => {
  it('a URL assinada expira e esta amarrada ao usuario', async () => {
    const up = await upload(tenant.agent, wavTone(3));
    const assetId = (up.body as { asset: { id: string } }).asset.id;

    const res = await tenant.agent.get(`/api/v1/media/${assetId}/stream-url`);
    expect(res.statusCode).toBe(200);
    const { url, expiresInSeconds } = res.json<{ url: string; expiresInSeconds: number }>();
    expect(expiresInSeconds).toBeLessThanOrEqual(3600);

    const stream = await tenant.agent.get(url);
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('audio/wav');
    expect(stream.headers['x-content-type-options']).toBe('nosniff');
  });

  it('token de audio adulterado e recusado', async () => {
    const up = await upload(tenant.agent, wavTone(3));
    const assetId = (up.body as { asset: { id: string } }).asset.id;
    const { url } = (await tenant.agent.get(`/api/v1/media/${assetId}/stream-url`)).json<{ url: string }>();

    const adulterado = url.replace(/token=(.)/, (_m, c: string) => `token=${c === 'A' ? 'B' : 'A'}`);
    const res = await tenant.agent.get(adulterado);
    expect(res.statusCode).toBe(403);
  });

  it('sem token, a rota de stream nao entrega nada', async () => {
    const res = await tenant.agent.get('/api/v1/media/stream');
    expect(res.statusCode).toBe(400);
  });
});

describe('isolamento da biblioteca', () => {
  it('outra organizacao nao ve nem baixa o audio', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const up = await upload(tenant.agent, wavTone(3));
    const assetId = (up.body as { asset: { id: string } }).asset.id;

    expect((await outro.agent.get('/api/v1/media')).json<{ media: unknown[] }>().media).toHaveLength(0);
    expect((await outro.agent.get(`/api/v1/media/${assetId}`)).statusCode).toBe(404);
    expect((await outro.agent.get(`/api/v1/media/${assetId}/stream-url`)).statusCode).toBe(404);
  });

  it('arquivos identicos em organizacoes diferentes coexistem', async () => {
    const outro = await registerTenant(ctx, { organizationName: 'Rede B' });
    const bytes = wavTone(4);
    expect((await upload(tenant.agent, bytes)).statusCode).toBe(200);
    // A deduplicacao e por organizacao, nao global: um tenant nao descobre o
    // que o outro enviou comparando checksums.
    expect((await upload(outro.agent, bytes)).statusCode).toBe(200);
  });
});

describe('arquivamento', () => {
  it('recusa arquivar audio em uso numa playlist', async () => {
    const up = await upload(tenant.agent, wavTone(3), { kind: 'music', filename: 'faixa.wav' });
    const assetId = (up.body as { asset: { id: string } }).asset.id;

    const playlist = await ctx.db.query<{ id: string }>(
      "insert into playlists (organization_id, name) values ($1,'Ambiente') returning id",
      [tenant.organizationId],
    );
    await ctx.db.query(
      `insert into playlist_items (organization_id, playlist_id, item_type, media_asset_id)
       values ($1,$2,'music',$3)`,
      [tenant.organizationId, playlist.rows[0]!.id, assetId],
    );

    const res = await tenant.agent.post(`/api/v1/media/${assetId}/archive`);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/em uso/i);
  });

  it('arquiva audio livre', async () => {
    const up = await upload(tenant.agent, wavTone(3));
    const assetId = (up.body as { asset: { id: string } }).asset.id;
    expect((await tenant.agent.post(`/api/v1/media/${assetId}/archive`)).statusCode).toBe(200);
  });
});

describe('cota de armazenamento', () => {
  it('bloqueia upload que estouraria o plano, antes da transferencia', async () => {
    // Starter tem 2 GB; pedimos 3 GB.
    await ctx.db.query("update subscriptions set plan_id = (select id from plans where code = 'starter')");
    const res = await tenant.agent.post('/api/v1/media/uploads', {
      filename: 'gigante.wav',
      sizeBytes: 3 * 1024 * 1024 * 1024,
      kind: 'music',
      rightsAttested: true,
    });
    // 400 pela validacao de tamanho maximo por arquivo, ou 403 pela cota --
    // os dois sao recusa antes de transferir um byte.
    expect([400, 403]).toContain(res.statusCode);
  });
});
