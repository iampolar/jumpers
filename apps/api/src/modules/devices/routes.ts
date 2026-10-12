import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  newPairingCode,
  zCreatePairingCodeInput,
  zPairDeviceInput,
  zUpdateDeviceInput,
  type Device,
} from '@castwave/contracts';
import { assertWithinQuota, hashToken, randomToken } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, authorizeStore, created, type AppServices } from '../../http/context.js';
import { idOf, parseBody } from '../../http/validate.js';
import { loadUsage } from '../billing/usage.js';

/**
 * Pareamento e ciclo de vida do player.
 *
 * O codigo de pareamento e a unica janela em que um dispositivo nao
 * autenticado pode virar um autenticado, entao ele e tratado como segredo de
 * curta duracao: aleatorio por CSPRNG, guardado apenas como hash, uso unico,
 * TTL de minutos e consumido dentro de uma transacao que impede corrida entre
 * dois players digitando o mesmo codigo.
 */

function mapDevice(row: Record<string, unknown>, offlineAfterSeconds: number): Device {
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at as string) : null;
  const secondsSince = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 1000) : null;

  /*
   * O estado mostrado deriva do relogio do SERVIDOR. Um player congelado nao
   * avisa que parou; confiar no ultimo status gravado faria o painel mentir
   * ate o worker passar. Aqui a leitura ja e honesta.
   */
  let status = row.status as Device['status'];
  if (status === 'active' && secondsSince !== null && secondsSince > offlineAfterSeconds) {
    status = 'offline';
  }

  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    storeId: row.store_id as string,
    storeName: (row.store_name as string) ?? '',
    zoneId: row.zone_id as string,
    zoneName: (row.zone_name as string) ?? '',
    name: row.name as string,
    status,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    secondsSinceLastSeen: secondsSince,
    appVersion: (row.app_version as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorAt: row.last_error_at ? new Date(row.last_error_at as string).toISOString() : null,
    cachedItems: row.cached_items === null ? null : Number(row.cached_items),
    bufferDepth: row.buffer_depth === null ? null : Number(row.buffer_depth),
    currentItemLabel: (row.current_item_label as string | null) ?? null,
    pairedAt: row.paired_at ? new Date(row.paired_at as string).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

const DEVICE_SELECT = `
  select d.id, d.organization_id, d.store_id, d.zone_id, d.name, d.status, d.last_seen_at,
         d.app_version, d.last_error_code, d.last_error_at, d.cached_items, d.buffer_depth,
         d.current_item_label, d.paired_at, d.revoked_at, d.created_at,
         s.name as store_name, z.name as zone_name
    from player_devices d
    join stores s      on s.id = d.store_id
    join audio_zones z on z.id = d.zone_id`;

export function registerDeviceRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit, config } = services;
  const offlineAfter = config.DEVICE_OFFLINE_AFTER_SECONDS;

  // -------------------------------------------------------------------------
  // Emissao de codigo
  // -------------------------------------------------------------------------

  server.post('/api/v1/devices/pairing-codes', async (req, reply) => {
    const principal = authorize(req, 'devices:pair');
    const input = parseBody(req, zCreatePairingCodeInput);
    authorizeStore(req, 'devices:pair', input.storeId);

    // A zona precisa ser da loja informada E da organizacao da sessao. A FK
    // composta ja garante no banco; aqui damos erro legivel antes.
    const zone = await db.query(
      `select 1 from audio_zones
        where id = $1 and store_id = $2 and organization_id = $3 and status = 'active'`,
      [input.zoneId, input.storeId, principal.organizationId],
    );
    if (zone.rowCount === 0) {
      throw new DomainError('not_found', 'Zona de audio nao encontrada nesta loja.');
    }

    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('devices', usage.quotas, usage.snapshot);

    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    await db.query(
      `insert into device_pairing_codes
         (organization_id, store_id, zone_id, code_hash, device_name, requested_by, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        principal.organizationId,
        input.storeId,
        input.zoneId,
        hashToken(code.replace('-', '')),
        input.deviceName,
        principal.userId,
        expiresAt,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.pairingCodeIssued,
      resourceType: 'store',
      resourceId: input.storeId,
      requestId: req.id,
      // O codigo em si NUNCA entra na auditoria.
      metadata: { zoneId: input.zoneId, ttlSeconds: input.ttlSeconds },
      ip: req.ip,
    });

    const store = await db.query<{ store_name: string; zone_name: string }>(
      `select s.name as store_name, z.name as zone_name
         from stores s join audio_zones z on z.id = $2 where s.id = $1`,
      [input.storeId, input.zoneId],
    );

    return created(reply, {
      // Exibido uma unica vez. O banco so tem o hash.
      code: code,
      expiresAt: expiresAt.toISOString(),
      storeId: input.storeId,
      zoneId: input.zoneId,
      deviceName: input.deviceName,
      storeName: store.rows[0]?.store_name ?? '',
      zoneName: store.rows[0]?.zone_name ?? '',
    });
  });

  // -------------------------------------------------------------------------
  // Troca de codigo por credencial (rota publica, chamada pelo player)
  // -------------------------------------------------------------------------

  server.post(
    '/api/v1/devices/pair',
    {
      // Rota publica: limite apertado para nao virar oraculo de adivinhacao.
      config: {
        rateLimit: config.RATE_LIMIT_ENABLED
          ? { max: 12, timeWindow: '1 minute' }
          : { max: 100_000, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const input = parseBody(req, zPairDeviceInput);
      const codeHash = hashToken(input.code);
      const deviceToken = randomToken(32);

      const result = await db.transaction(async (tx) => {
        /*
         * `for update` serializa duas tentativas simultaneas com o mesmo
         * codigo: a segunda espera, encontra `used_at` preenchido e falha.
         * Sem isso, dois players poderiam parear com um codigo de uso unico.
         */
        const { rows } = await tx.query<{
          id: string;
          organization_id: string;
          store_id: string;
          zone_id: string;
          device_name: string;
          expires_at: Date;
          used_at: Date | null;
        }>(
          `select id, organization_id, store_id, zone_id, device_name, expires_at, used_at
             from device_pairing_codes
            where code_hash = $1
            for update`,
          [codeHash],
        );

        const pairing = rows[0];
        // Mensagem unica para codigo inexistente, usado e expirado: quem esta
        // tentando adivinhar nao aprende em qual dos casos caiu.
        const invalid = (): never => {
          throw new DomainError('not_found', 'Codigo invalido ou expirado.', {
            action: 'Gere um novo codigo no painel, em Players.',
          });
        };
        if (!pairing) invalid();
        if (pairing!.used_at) invalid();
        if (new Date(pairing!.expires_at) <= new Date()) invalid();

        const p = pairing!;
        const device = await tx.query<{ id: string }>(
          `insert into player_devices
             (organization_id, store_id, zone_id, name, token_hash, status, paired_at)
           values ($1,$2,$3,$4,$5,'active', now()) returning id`,
          [p.organization_id, p.store_id, p.zone_id, p.device_name, hashToken(deviceToken)],
        );

        await tx.query(
          'update device_pairing_codes set used_at = now(), used_by_device = $2 where id = $1',
          [p.id, device.rows[0]!.id],
        );

        const info = await tx.query<{
          store_name: string;
          zone_name: string;
          timezone: string;
          org_name: string;
        }>(
          `select s.name as store_name, z.name as zone_name, s.timezone, o.name as org_name
             from stores s
             join audio_zones z   on z.id = $2
             join organizations o on o.id = s.organization_id
            where s.id = $1`,
          [p.store_id, p.zone_id],
        );

        return {
          deviceId: device.rows[0]!.id,
          organizationId: p.organization_id,
          storeId: p.store_id,
          deviceName: p.device_name,
          ...info.rows[0]!,
        };
      });

      await audit.write({
        organizationId: result.organizationId,
        actorType: 'device',
        actorId: result.deviceId,
        actorLabel: result.deviceName,
        action: AUDIT_ACTIONS.devicePaired,
        resourceType: 'device',
        resourceId: result.deviceId,
        requestId: req.id,
        metadata: { storeId: result.storeId },
        ip: req.ip,
        userAgent: input.userAgent ?? req.headers['user-agent'],
      });

      return created(reply, {
        deviceId: result.deviceId,
        // Entregue uma unica vez. O player guarda localmente; o banco so tem o hash.
        deviceToken,
        storeName: result.store_name,
        zoneName: result.zone_name,
        deviceName: result.deviceName,
        organizationName: result.org_name,
        timezone: result.timezone,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Operacao
  // -------------------------------------------------------------------------

  server.get('/api/v1/devices', async (req) => {
    const principal = authorize(req, 'devices:read');
    const query = z
      .object({
        storeId: z.uuid().optional(),
        status: z.enum(['pairing', 'active', 'degraded', 'offline', 'revoked']).optional(),
      })
      .parse(req.query ?? {});

    const { rows } = await db.query(
      `${DEVICE_SELECT}
        where d.organization_id = $1
          and ($2::uuid[] is null or d.store_id = any($2::uuid[]))
          and ($3::uuid is null or d.store_id = $3::uuid)
          and ($4::text is null or d.status = $4::text)
        order by s.name, z.name, d.name`,
      [
        principal.organizationId,
        principal.scopedStoreIds ?? null,
        query.storeId ?? null,
        query.status ?? null,
      ],
    );
    return { devices: rows.map((r) => mapDevice(r, offlineAfter)) };
  });

  server.get('/api/v1/devices/:id', async (req) => {
    const principal = authorize(req, 'devices:read');
    const { rows } = await db.query(`${DEVICE_SELECT} where d.id = $1 and d.organization_id = $2`, [
      idOf(req),
      principal.organizationId,
    ]);
    if (!rows[0]) throw new DomainError('not_found', 'Player nao encontrado.');
    authorizeStore(req, 'devices:read', rows[0].store_id as string);
    return { device: mapDevice(rows[0], offlineAfter) };
  });

  server.patch('/api/v1/devices/:id', async (req) => {
    const principal = authorize(req, 'devices:manage');
    const deviceId = idOf(req);
    const input = parseBody(req, zUpdateDeviceInput);

    const current = await db.query<{ store_id: string }>(
      'select store_id from player_devices where id = $1 and organization_id = $2',
      [deviceId, principal.organizationId],
    );
    if (!current.rows[0]) throw new DomainError('not_found', 'Player nao encontrado.');
    authorizeStore(req, 'devices:manage', current.rows[0].store_id);

    if (input.zoneId) {
      // Mover de zona so dentro da mesma loja: mudar de loja exige novo
      // pareamento, porque o escopo do token muda.
      const zone = await db.query(
        'select 1 from audio_zones where id = $1 and store_id = $2 and organization_id = $3',
        [input.zoneId, current.rows[0].store_id, principal.organizationId],
      );
      if (zone.rowCount === 0) {
        throw new DomainError('validation_failed', 'A zona precisa pertencer a mesma loja do player.');
      }
    }

    await db.query(
      `update player_devices set name = coalesce($3, name), zone_id = coalesce($4, zone_id), updated_at = now()
        where id = $1 and organization_id = $2`,
      [deviceId, principal.organizationId, input.name ?? null, input.zoneId ?? null],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.deviceUpdated,
      resourceType: 'device',
      resourceId: deviceId,
      requestId: req.id,
      metadata: { fields: Object.keys(input) },
      ip: req.ip,
    });

    const full = await db.query(`${DEVICE_SELECT} where d.id = $1`, [deviceId]);
    return { device: mapDevice(full.rows[0]!, offlineAfter) };
  });

  server.post('/api/v1/devices/:id/revoke', async (req) => {
    const principal = authorize(req, 'devices:manage');
    const deviceId = idOf(req);

    const current = await db.query<{ store_id: string; status: string; name: string }>(
      'select store_id, status, name from player_devices where id = $1 and organization_id = $2',
      [deviceId, principal.organizationId],
    );
    const device = current.rows[0];
    if (!device) throw new DomainError('not_found', 'Player nao encontrado.');
    authorizeStore(req, 'devices:manage', device.store_id);

    if (device.status === 'revoked') {
      return { revoked: true, alreadyRevoked: true };
    }

    await db.query(
      `update player_devices
          set status = 'revoked', revoked_at = now(), revoked_by = $3, updated_at = now()
        where id = $1 and organization_id = $2`,
      [deviceId, principal.organizationId, principal.userId],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.deviceRevoked,
      resourceType: 'device',
      resourceId: deviceId,
      requestId: req.id,
      metadata: { deviceName: device.name },
      ip: req.ip,
    });

    /*
     * Limitacao honesta, documentada no runbook: a revogacao vale a partir da
     * proxima sincronizacao. Um player offline com cache valido continua
     * tocando ate reconectar -- por isso o manifesto expira em minutos, nao
     * em horas. Nao prometemos corte instantaneo que o navegador nao entrega.
     */
    return {
      revoked: true,
      alreadyRevoked: false,
      note: 'O player para na proxima sincronizacao. Se estiver offline, continuara tocando o cache local ate reconectar.',
    };
  });
}
