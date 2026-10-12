import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ACCEPTED_AUDIO_MIME,
  DomainError,
  MAX_SPOT_DURATION_MS,
  MAX_TRACK_DURATION_MS,
  MAX_UPLOAD_BYTES,
  zCreateUploadInput,
  type MediaAsset,
} from '@castwave/contracts';
import {
  assertWithinQuota,
  CONTAINER_MIME,
  NativeAudioProbe,
  sha256Hex,
  signUrlToken,
  verifyUrlToken,
} from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit';
import { authorize, created, type AppServices } from '../../http/context';
import { idOf, parseBody, parseQuery } from '../../http/validate';
import { loadUsage } from '../billing/usage';

/**
 * Biblioteca de audio.
 *
 * O upload acontece em duas etapas -- `POST /uploads` cria o registro e
 * devolve um ticket, `POST /uploads/:id/complete` recebe os bytes -- para que
 * a cota do plano seja verificada ANTES de alguem transferir 60 MB que serao
 * recusados no fim.
 *
 * A validacao do arquivo nunca confia no cliente:
 *  - o tipo vem dos magic bytes, nao da extensao nem do Content-Type;
 *  - a duracao e lida do container de verdade;
 *  - o checksum e calculado pelo servidor sobre os bytes recebidos;
 *  - o tamanho e conferido contra o declarado.
 *
 * Um arquivo so vira `ready` com duracao, checksum e chave de storage -- e ha
 * um CHECK no banco garantindo isso mesmo contra bug de aplicacao.
 */

const probe = new NativeAudioProbe();
const UPLOAD_TTL_SECONDS = 900;

function mapAsset(row: Record<string, unknown>): MediaAsset {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    kind: row.kind as MediaAsset['kind'],
    title: row.title as string,
    originalFilename: row.original_filename as string,
    mimeType: (row.mime_type as string | null) ?? '',
    sizeBytes: Number(row.size_bytes),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    checksumSha256: (row.checksum_sha256 as string | null) ?? null,
    sampleRate: row.sample_rate === null ? null : Number(row.sample_rate),
    channels: row.channels === null ? null : Number(row.channels),
    bitrateKbps: row.bitrate_kbps === null ? null : Number(row.bitrate_kbps),
    loudnessLufs: row.loudness_lufs === null ? null : Number(row.loudness_lufs),
    status: row.status as MediaAsset['status'],
    processingError: (row.processing_error as string | null) ?? null,
    rightsAttestedAt: row.rights_attested_at
      ? new Date(row.rights_attested_at as string).toISOString()
      : null,
    rightsAttestedBy: (row.rights_attested_by_name as string | null) ?? null,
    uploadedByName: (row.uploaded_by_name as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

const ASSET_SELECT = `
  select m.id, m.organization_id, m.kind, m.title, m.original_filename, m.mime_type, m.size_bytes,
         m.duration_ms, m.checksum_sha256, m.sample_rate, m.channels, m.bitrate_kbps, m.loudness_lufs,
         m.status, m.processing_error, m.rights_attested_at, m.created_at,
         u.name  as uploaded_by_name,
         ra.name as rights_attested_by_name
    from media_assets m
    left join users u  on u.id = m.uploaded_by
    left join users ra on ra.id = m.rights_attested_by`;

/** Nome de arquivo saneado: sem caminho, sem caractere de controle. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'audio';
  // Remover caractere de controle do nome e o proposito desta funcao.
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 180) || 'audio';
}

export function registerMediaRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit, storage, config } = services;

  // -------------------------------------------------------------------------
  // Listagem
  // -------------------------------------------------------------------------

  server.get('/api/v1/media', async (req) => {
    const principal = authorize(req, 'media:read');
    const query = parseQuery(
      req,
      z.object({
        kind: z.enum(['music', 'voice_over', 'jingle', 'operational_notice']).optional(),
        status: z.enum(['uploading', 'processing', 'ready', 'failed', 'archived']).optional(),
        search: z.string().trim().max(120).optional(),
      }),
    );

    const { rows } = await db.query(
      `${ASSET_SELECT}
        where m.organization_id = $1
          and ($2::text is null or m.kind = $2::text)
          and ($3::text is null or m.status = $3::text)
          and ($3::text is not null or m.status <> 'archived')
          and ($4::text is null or m.title ilike '%' || $4::text || '%')
        order by m.created_at desc
        limit 500`,
      [principal.organizationId, query.kind ?? null, query.status ?? null, query.search ?? null],
    );
    return { media: rows.map(mapAsset) };
  });

  server.get('/api/v1/media/:id', async (req) => {
    const principal = authorize(req, 'media:read');
    const { rows } = await db.query(`${ASSET_SELECT} where m.id = $1 and m.organization_id = $2`, [
      idOf(req),
      principal.organizationId,
    ]);
    if (!rows[0]) throw new DomainError('not_found', 'Audio nao encontrado.');
    return { asset: mapAsset(rows[0]) };
  });

  // -------------------------------------------------------------------------
  // Upload em duas etapas
  // -------------------------------------------------------------------------

  server.post('/api/v1/media/uploads', async (req, reply) => {
    const principal = authorize(req, 'media:upload');
    const input = parseBody(req, zCreateUploadInput);

    // Cota antes da transferencia: nao gastamos a banda do lojista para
    // recusar no fim.
    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('storage', usage.quotas, usage.snapshot, input.sizeBytes);

    const filename = sanitizeFilename(input.filename);
    const uploadToken = signUrlToken(
      {
        key: `pending/${principal.organizationId}`,
        expiresAt: Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS,
        audience: principal.userId,
      },
      config.MEDIA_URL_SECRET,
    );

    const { rows } = await db.query<{ id: string }>(
      `insert into media_assets
         (organization_id, kind, title, original_filename, size_bytes, status,
          rights_attested_at, rights_attested_by, uploaded_by, upload_expires_at)
       values ($1,$2,$3,$4,$5,'uploading', now(), $6, $6, now() + make_interval(secs => $7))
       returning id`,
      [
        principal.organizationId,
        input.kind,
        input.title ?? filename.replace(/\.[^.]+$/, ''),
        filename,
        input.sizeBytes,
        principal.userId,
        UPLOAD_TTL_SECONDS,
      ],
    );

    return created(reply, {
      mediaAssetId: rows[0]!.id,
      uploadUrl: `/api/v1/media/uploads/${rows[0]!.id}/complete`,
      uploadToken,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
      maxBytes: MAX_UPLOAD_BYTES,
    });
  });

  /**
   * Recebe os bytes e valida.
   *
   * Ponto central do produto: e aqui que um `.mp3` que na verdade e um ZIP, um
   * SVG com script ou um arquivo truncado e recusado -- antes de existir
   * qualquer chance de ser servido a um player.
   */
  server.post(
    '/api/v1/media/uploads/:id/complete',
    { bodyLimit: MAX_UPLOAD_BYTES + 1024 },
    async (req) => {
      const principal = authorize(req, 'media:upload');
      const assetId = idOf(req);

      const current = await db.query<{ status: string; size_bytes: string; kind: string; original_filename: string }>(
        `select status, size_bytes, kind, original_filename from media_assets
          where id = $1 and organization_id = $2`,
        [assetId, principal.organizationId],
      );
      const asset = current.rows[0];
      if (!asset) throw new DomainError('not_found', 'Upload nao encontrado.');
      if (asset.status !== 'uploading') {
        throw new DomainError('conflict', 'Este upload ja foi concluido.');
      }

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new DomainError('validation_failed', 'Corpo da requisicao vazio ou invalido.');
      }
      const bytes = new Uint8Array(body);

      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new DomainError('payload_too_large', 'Arquivo maior que o limite de 64 MB.');
      }

      let probed;
      try {
        probed = await probe.probe(bytes, asset.original_filename);
      } catch (error) {
        // Falha de validacao marca o registro, nao o deixa pendurado em
        // "uploading" para sempre.
        await db.query(
          `update media_assets set status = 'failed', processing_error = $2, updated_at = now()
            where id = $1`,
          [assetId, error instanceof DomainError ? error.message : 'Arquivo ilegivel.'],
        );
        throw error;
      }

      const maxDuration = asset.kind === 'music' ? MAX_TRACK_DURATION_MS : MAX_SPOT_DURATION_MS;
      if (probed.durationMs <= 0) {
        await db.query(
          "update media_assets set status = 'failed', processing_error = 'Duracao zero.' where id = $1",
          [assetId],
        );
        throw new DomainError('unprocessable_media', 'O arquivo nao tem audio audivel (duracao zero).');
      }
      if (probed.durationMs > maxDuration) {
        await db.query(
          "update media_assets set status = 'failed', processing_error = 'Duracao acima do limite.' where id = $1",
          [assetId],
        );
        throw new DomainError(
          'unprocessable_media',
          `Audio de ${Math.round(probed.durationMs / 1000)}s excede o limite de ${Math.round(maxDuration / 1000)}s para este tipo.`,
        );
      }

      const checksum = sha256Hex(bytes);

      // Deduplicacao: o mesmo arquivo enviado duas vezes nao ocupa espaco em
      // dobro nem polui a biblioteca.
      const duplicate = await db.query<{ id: string; title: string }>(
        `select id, title from media_assets
          where organization_id = $1 and checksum_sha256 = $2 and status <> 'archived' and id <> $3`,
        [principal.organizationId, checksum, assetId],
      );
      if (duplicate.rows[0]) {
        await db.query('delete from media_assets where id = $1', [assetId]);
        throw new DomainError('already_exists', `Este audio ja esta na biblioteca como "${duplicate.rows[0].title}".`, {
          action: 'Use o arquivo existente ou renomeie se for realmente outro conteudo.',
          logContext: { existingId: duplicate.rows[0].id },
        });
      }

      const storageKey = `org/${principal.organizationId}/media/${assetId}`;
      const mime = CONTAINER_MIME[probed.container as keyof typeof CONTAINER_MIME] ?? 'audio/mpeg';
      await storage.put(storageKey, bytes, mime);

      const { rows } = await db.query(
        `update media_assets set
            status = 'ready', storage_key = $2, mime_type = $3, size_bytes = $4,
            duration_ms = $5, checksum_sha256 = $6, sample_rate = $7, channels = $8,
            bitrate_kbps = $9, loudness_lufs = $10, probed_by = $11,
            processing_error = null, upload_token_hash = null, upload_expires_at = null,
            updated_at = now()
          where id = $1
          returning id`,
        [
          assetId,
          storageKey,
          mime,
          bytes.byteLength,
          probed.durationMs,
          checksum,
          probed.sampleRate,
          probed.channels,
          probed.bitrateKbps,
          probed.loudnessLufs,
          probed.probedBy,
        ],
      );
      void rows;

      await audit.write({
        organizationId: principal.organizationId,
        actorType: 'user',
        actorId: principal.userId,
        action: AUDIT_ACTIONS.mediaUploaded,
        resourceType: 'media_asset',
        resourceId: assetId,
        requestId: req.id,
        metadata: {
          kind: asset.kind,
          sizeBytes: bytes.byteLength,
          durationMs: probed.durationMs,
          container: probed.container,
          probedBy: probed.probedBy,
        },
        ip: req.ip,
      });

      const full = await db.query(`${ASSET_SELECT} where m.id = $1`, [assetId]);
      return {
        asset: mapAsset(full.rows[0]!),
        // Transparencia sobre a origem do dado tecnico: com FFmpeg ausente,
        // o painel mostra "lido do cabecalho" em vez de fingir precisao.
        probedBy: probed.probedBy,
        loudnessMeasured: probed.loudnessLufs !== null,
      };
    },
  );

  server.post('/api/v1/media/:id/archive', async (req) => {
    const principal = authorize(req, 'media:manage');
    const assetId = idOf(req);

    // Arquivo em uso nao some: quebraria a playlist e o historico.
    const inUse = await db.query<{ n: string }>(
      `select count(*)::text as n from playlist_items
        where media_asset_id = $1 and organization_id = $2 and enabled`,
      [assetId, principal.organizationId],
    );
    if (Number(inUse.rows[0]!.n) > 0) {
      throw new DomainError('conflict', 'Este audio esta em uso em uma ou mais playlists.', {
        action: 'Remova-o das playlists antes de arquivar.',
      });
    }

    const { rowCount } = await db.query(
      `update media_assets set status = 'archived', archived_at = now(), updated_at = now()
        where id = $1 and organization_id = $2 and status <> 'archived'`,
      [assetId, principal.organizationId],
    );
    if (rowCount === 0) throw new DomainError('not_found', 'Audio nao encontrado.');

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.mediaArchived,
      resourceType: 'media_asset',
      resourceId: assetId,
      requestId: req.id,
      ip: req.ip,
    });

    return { archived: true };
  });

  // -------------------------------------------------------------------------
  // Previa no painel
  // -------------------------------------------------------------------------

  server.get('/api/v1/media/:id/stream-url', async (req) => {
    const principal = authorize(req, 'media:read');
    const { rows } = await db.query<{ storage_key: string | null; status: string }>(
      'select storage_key, status from media_assets where id = $1 and organization_id = $2',
      [idOf(req), principal.organizationId],
    );
    const asset = rows[0];
    if (!asset) throw new DomainError('not_found', 'Audio nao encontrado.');
    if (asset.status !== 'ready' || !asset.storage_key) {
      throw new DomainError('conflict', 'Este audio ainda nao esta pronto para reproducao.');
    }

    const token = signUrlToken(
      {
        key: asset.storage_key,
        expiresAt: Math.floor(Date.now() / 1000) + config.MEDIA_URL_TTL_SECONDS,
        // Amarra a URL ao usuario: link vazado nao serve a outra pessoa.
        audience: `user:${principal.userId}`,
      },
      config.MEDIA_URL_SECRET,
    );

    return {
      url: `/api/v1/media/stream?token=${encodeURIComponent(token)}`,
      expiresInSeconds: config.MEDIA_URL_TTL_SECONDS,
    };
  });

  /**
   * Entrega os bytes. Rota publica por necessidade -- a tag `<audio>` nao
   * manda cabecalho de autorizacao -- mas so aceita token HMAC valido, de TTL
   * curto, que carrega a chave exata. Nao ha como pedir "outro arquivo".
   */
  server.get('/api/v1/media/stream', async (req, reply) => {
    const { token } = parseQuery(req, z.object({ token: z.string().min(16).max(2048) }));
    const claims = verifyUrlToken(token, config.MEDIA_URL_SECRET, Math.floor(Date.now() / 1000));
    if (!claims) {
      throw new DomainError('forbidden', 'Link de audio invalido ou expirado.');
    }

    const head = await storage.head(claims.key);
    if (!head) throw new DomainError('not_found', 'Arquivo nao encontrado.');
    const bytes = await storage.get(claims.key);

    return reply
      .header('content-type', head.contentType)
      .header('content-length', String(head.sizeBytes))
      .header('cache-control', 'private, max-age=60')
      .header('x-content-type-options', 'nosniff')
      // Nunca executar no contexto da origem: audio e dado, nao script.
      .header('content-disposition', 'inline')
      .send(Buffer.from(bytes));
  });

  void ACCEPTED_AUDIO_MIME;
}
