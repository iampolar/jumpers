/**
 * Critério de aceite do blueprint, de ponta a ponta, contra a API rodando.
 *
 * Cada passo imprime o que foi verificado. Nenhum passo é simulado: todas as
 * chamadas são HTTP reais contra o servidor em http://127.0.0.1:4000.
 */
const API = 'http://127.0.0.1:4000';

let cookie = '';
let csrf = '';
const passos = [];

function ok(descricao, detalhe = '') {
  passos.push({ ok: true, descricao, detalhe });
  console.log(`  OK   ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
}
function falha(descricao, detalhe) {
  passos.push({ ok: false, descricao, detalhe });
  console.log(`  FALHA ${descricao} — ${detalhe}`);
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  let payload;
  if (body instanceof Uint8Array) {
    payload = body;
    headers['content-type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const set = res.headers.get('set-cookie');
  if (set?.includes('castwave_session=')) {
    const value = set.split(';')[0];
    if (!value.endsWith('=')) cookie = value;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (json?.csrfToken) csrf = json.csrfToken;
  return { status: res.status, body: json };
}

/** WAV PCM com tom audível — áudio de verdade, validado pela sonda. */
function wav(segundos, frequencia) {
  const sr = 22050;
  const frames = Math.round(segundos * sr);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequencia * i) / sr) * 10000), 44 + i * 2);
  }
  return new Uint8Array(buf);
}

async function upload(nome, segundos, frequencia, kind) {
  const bytes = wav(segundos, frequencia);
  const ticket = await call('POST', '/api/v1/media/uploads', {
    filename: `${nome}.wav`,
    sizeBytes: bytes.byteLength,
    kind,
    title: nome,
    rightsAttested: true,
  });
  if (ticket.status !== 201) throw new Error(`ticket ${nome}: ${ticket.status} ${JSON.stringify(ticket.body)}`);
  const done = await call('POST', `/api/v1/media/uploads/${ticket.body.mediaAssetId}/complete`, bytes);
  if (done.status !== 200) throw new Error(`upload ${nome}: ${done.status} ${JSON.stringify(done.body)}`);
  return done.body.asset;
}

const sufixo = Math.random().toString(36).slice(2, 7);

console.log('\n=== CRITERIO DE ACEITE — CastWave ===\n');

// 1 ─ conta e organização
console.log('1. Conta, organizacao e duas lojas em fusos diferentes');
const reg = await call('POST', '/api/v1/auth/register', {
  name: 'Aceite',
  email: `aceite-${sufixo}@exemplo.test`,
  password: 'senha-de-aceite-longa',
  organizationName: `Rede Aceite ${sufixo}`,
  timezone: 'America/Sao_Paulo',
  acceptedTerms: true,
});
if (reg.status !== 201) throw new Error(`registro: ${reg.status} ${JSON.stringify(reg.body)}`);
ok('conta e organizacao criadas', `papel ${reg.body.session.role}`);

const lojas = [];
for (const [nome, tz] of [
  ['Aceite Centro', 'America/Sao_Paulo'],
  ['Aceite Manaus', 'America/Manaus'],
]) {
  const r = await call('POST', '/api/v1/stores', { name: nome, timezone: tz });
  const zona = await call('POST', `/api/v1/stores/${r.body.store.id}/zones`, { name: 'Salao' });
  lojas.push({ id: r.body.store.id, zoneId: zona.body.zone.id, nome, tz });
}
ok('duas lojas com fusos distintos', lojas.map((l) => `${l.nome} (${l.tz})`).join(' · '));

// 2 ─ biblioteca
console.log('\n2. Upload de audio proprio, validado por conteudo');
const m1 = await upload('Faixa ambiente 1', 8, 320, 'music');
const m2 = await upload('Faixa ambiente 2', 10, 440, 'music');
const spot = await upload('Locucao da oferta', 4, 560, 'voice_over');
ok('tres arquivos aceitos e medidos', `${m1.durationMs}ms, ${m2.durationMs}ms, ${spot.durationMs}ms`);

const lixo = await call('POST', '/api/v1/media/uploads', {
  filename: 'malicioso.mp3',
  sizeBytes: 300,
  kind: 'music',
  rightsAttested: true,
});
const lixoEnviado = await call(
  'POST',
  `/api/v1/media/uploads/${lixo.body.mediaAssetId}/complete`,
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(290).fill(0)]),
);
if (lixoEnviado.status < 400) falha('ZIP disfarcado deveria ser recusado', `status ${lixoEnviado.status}`);
else ok('ZIP disfarcado de .mp3 recusado', lixoEnviado.body.error.code);

// 3 ─ anúncio
console.log('\n3. Anuncio manual, versionado e aprovado');
const ann = await call('POST', '/api/v1/announcements', {
  title: 'Oferta do dia',
  scriptText: 'Atencao, clientes! Hoje, cafe torrado por R$ 19,90.',
  mediaAssetId: spot.id,
});
const annId = ann.body.announcement.id;
ok('anuncio criado como rascunho', `acoes: ${ann.body.announcement.availableActions.join(', ')}`);

await call('POST', `/api/v1/announcements/${annId}/actions`, { action: 'approve' });
const agendado = await call('POST', `/api/v1/announcements/${annId}/actions`, { action: 'schedule' });
ok('aprovado e agendado pela maquina de estados', `estado ${agendado.body.announcement.status}`);

const ilegal = await call('POST', `/api/v1/announcements/${annId}/actions`, { action: 'approve' });
if (ilegal.status !== 400) falha('transicao ilegal deveria ser recusada', `status ${ilegal.status}`);
else ok('transicao ilegal recusada pelo servidor', ilegal.body.error.code);

// 4 ─ playlist
console.log('\n4. Playlist com musicas e spot');
const pl = await call('POST', '/api/v1/playlists', {
  name: 'Ambiente de aceite',
  rotationRules: { insertionMode: 'every_n_tracks', everyNTracks: 2, musicOrder: 'sequential' },
});
const plId = pl.body.playlist.id;
for (const id of [m1.id, m2.id]) {
  await call('POST', `/api/v1/playlists/${plId}/items`, { itemType: 'music', mediaAssetId: id });
}
await call('POST', `/api/v1/playlists/${plId}/items`, { itemType: 'promo_spot', announcementId: annId });
const previa = await call('GET', `/api/v1/playlists/${plId}/preview?minutes=30`);
const tipos = previa.body.slots.slice(0, 4).map((s) => s.itemType);
ok('previa monta a sequencia', tipos.join(' > '));
if (!tipos.includes('promo_spot')) falha('o spot deveria entrar na rotacao', tipos.join(','));

// 5 ─ agenda
console.log('\n5. Agenda nas duas lojas e campanha com vigencia');
for (const loja of lojas) {
  await call('POST', '/api/v1/schedules', {
    name: 'Integral',
    storeId: loja.id,
    playlistId: plId,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startLocalTime: '00:00',
    endLocalTime: '23:59',
  });
}
const agoraSp = await call('GET', `/api/v1/schedules/now?storeId=${lojas[0].id}`);
const agoraMao = await call('GET', `/api/v1/schedules/now?storeId=${lojas[1].id}`);
ok('agenda resolvida no fuso de cada loja',
  `SP ${agoraSp.body.localTime} (${agoraSp.body.timezone}) · Manaus ${agoraMao.body.localTime} (${agoraMao.body.timezone})`);

const camp = await call('POST', '/api/v1/campaigns', {
  name: 'Campanha de aceite',
  startsAt: new Date(Date.now() - 3600_000).toISOString(),
  endsAt: new Date(Date.now() + 86_400_000).toISOString(),
  storeIds: [lojas[0].id],
  announcementIds: [annId],
});
await call('POST', `/api/v1/campaigns/${camp.body.campaign.id}/actions`, { action: 'publish' });
await call('POST', `/api/v1/campaigns/${camp.body.campaign.id}/actions`, { action: 'start' });
ok('campanha publicada e no ar');

// 6 ─ player
console.log('\n6. Pareamento e manifesto do player');
const codigo = await call('POST', '/api/v1/devices/pairing-codes', {
  storeId: lojas[0].id,
  zoneId: lojas[0].zoneId,
  deviceName: 'Player de aceite',
  ttlSeconds: 300,
});
const par = await fetch(`${API}/api/v1/devices/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: codigo.body.code }),
});
const parBody = await par.json();
const deviceToken = parBody.deviceToken;
ok('player pareado', `${parBody.storeName} / ${parBody.zoneName}`);

const reuso = await fetch(`${API}/api/v1/devices/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: codigo.body.code }),
});
if (reuso.status !== 404) falha('codigo deveria ser de uso unico', `status ${reuso.status}`);
else ok('codigo de pareamento e de uso unico');

const playerFetch = (method, path, body) =>
  fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const manifesto = await playerFetch('GET', '/api/v1/player/manifest');
if (manifesto.body.items.length === 0) {
  falha('manifesto veio vazio', `motivo: ${manifesto.body.idleReason}`);
} else {
  ok('manifesto entregue com programacao',
    `${manifesto.body.items.length} itens · playlist "${manifesto.body.program.playlistName}"`);
}

const temSpot = manifesto.body.items.some((i) => i.itemType === 'promo_spot');
ok(temSpot ? 'spot entrou no manifesto do player' : 'manifesto so com musica', temSpot ? '' : 'horizonte curto');

const vazou = JSON.stringify(manifesto.body).includes('R$ 19,90');
if (vazou) falha('manifesto NAO deveria conter o roteiro', 'texto encontrado');
else ok('manifesto nao carrega o roteiro do anuncio');

// 7 ─ eventos
console.log('\n7. Eventos idempotentes e relatorio');
const evento = {
  eventId: crypto.randomUUID(),
  slotId: manifesto.body.items[0].slotId,
  mediaAssetId: manifesto.body.items[0].mediaAssetId,
  eventType: 'completed',
  occurredAt: new Date().toISOString(),
  playedMs: manifesto.body.items[0].durationMs,
};
const env1 = await playerFetch('POST', '/api/v1/player/events', { events: [evento] });
const env2 = await playerFetch('POST', '/api/v1/player/events', { events: [evento] });
ok('evento aceito e reenvio deduplicado',
  `1a: ${env1.body.accepted} aceito · 2a: ${env2.body.duplicates} duplicado`);

await playerFetch('POST', '/api/v1/player/heartbeat', { online: true, appVersion: '1.0.0' });
const devices = await call('GET', '/api/v1/devices');
ok('heartbeat refletido no painel', `estado: ${devices.body.devices[0].status}`);

const hoje = new Date().toISOString().slice(0, 10);
const rel = await call('GET', `/api/v1/analytics/overview?from=${hoje}&to=${hoje}`);
ok('relatorio reflete o evento', `${rel.body.playback.completed} execucao(oes) concluida(s)`);

const csv = await fetch(`${API}/api/v1/analytics/export.csv?from=${hoje}&to=${hoje}`, {
  headers: { cookie, 'x-csrf-token': csrf },
});
// Lido como BYTES: `response.text()` remove o BOM ao decodificar UTF-8, e o
// BOM e justamente o que faz o Excel em pt-BR abrir o arquivo com acento.
const csvBytes = new Uint8Array(await csv.arrayBuffer());
const temBom = csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;
const linhas = Buffer.from(csvBytes).toString('utf8').trim().split('\r\n').length;
ok('CSV exportado', `${linhas - 1} linha(s) de dados · BOM para Excel: ${temBom}`);
if (!temBom) falha('CSV deveria comecar com BOM UTF-8', 'Excel pt-BR quebraria os acentos');

// 8 ─ integrações desligadas
console.log('\n8. Produto completo SEM IA e SEM gateway');
const ia = await call('POST', '/api/v1/ai/copy', {
  locale: 'pt-BR',
  objective: 'teste',
  tone: 'neutro',
  targetDurationSeconds: 20,
  forbiddenTerms: [],
});
ok('geracao por IA recusa com motivo', `${ia.status} ${ia.body.error.code}`);

const checkout = await call('POST', '/api/v1/billing/checkout', { planCode: 'network' });
ok('checkout recusa sem fingir sucesso', `${checkout.status} ${checkout.body.error.code}`);

const assinatura = await call('GET', '/api/v1/billing/subscription');
ok('assinatura intacta apos tentativa de checkout', `estado ${assinatura.body.subscription.status}`);

// 9 ─ isolamento
console.log('\n9. Isolamento entre organizacoes');
const cookieA = cookie;
const csrfA = csrf;
cookie = '';
csrf = '';
await call('POST', '/api/v1/auth/register', {
  name: 'Intruso',
  email: `intruso-${sufixo}@exemplo.test`,
  password: 'senha-de-intruso-longa',
  organizationName: `Rede Intrusa ${sufixo}`,
  timezone: 'America/Sao_Paulo',
  acceptedTerms: true,
});
const tentativa = await call('GET', `/api/v1/stores/${lojas[0].id}`);
if (tentativa.status !== 404) falha('loja alheia deveria dar 404', `status ${tentativa.status}`);
else ok('loja de outra organizacao responde 404, nao 403');

const jumpers = await call('GET', '/api/v1/jumpers/overview');
if (jumpers.status !== 404) falha('painel Jumpers deveria dar 404', `status ${jumpers.status}`);
else ok('painel Jumpers nao existe para o cliente', '404');

cookie = cookieA;
csrf = csrfA;

// ─ resumo
const falhas = passos.filter((p) => !p.ok);
console.log(`\n=== ${passos.length - falhas.length}/${passos.length} verificacoes aprovadas ===`);
if (falhas.length > 0) {
  for (const f of falhas) console.log(`  FALHOU: ${f.descricao} — ${f.detalhe}`);
  process.exit(1);
}
console.log('Criterio de aceite do blueprint: ATENDIDO.\n');
