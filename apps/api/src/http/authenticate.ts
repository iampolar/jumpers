import type { FastifyInstance } from 'fastify';
import { DomainError } from '@castwave/contracts';
import { hashToken } from '@castwave/core';
import type { SqlClient } from '@castwave/db';
import { assertCsrf, type AppServices } from './context';
import { SESSION_COOKIE } from '../modules/auth/routes';
import { resolveSession } from '../modules/auth/service';

/**
 * Resolucao de identidade.
 *
 * Duas credenciais completamente separadas chegam nesta API:
 *
 *  - **cookie de sessao** -> humano no painel, com papel e escopo de loja;
 *  - **bearer de dispositivo** -> player de loja, com escopo minimo e
 *    nenhum acesso a rota administrativa.
 *
 * Nunca se confundem: um player nao tem papel, e um humano nao recebe
 * manifesto. A separacao e verificada por teste.
 */

/** Rotas que funcionam sem credencial. Lista fechada; o resto exige sessao. */
const PUBLIC_ROUTES = new Set([
  'POST:/api/v1/auth/register',
  'POST:/api/v1/auth/login',
  'POST:/api/v1/auth/logout',
  'POST:/api/v1/auth/password/forgot',
  'POST:/api/v1/auth/password/reset',
  'POST:/api/v1/devices/pair',
  'GET:/api/v1/status/integrations',
  'GET:/api/v1/billing/plans',
  'GET:/health/live',
  'GET:/health/ready',
  'GET:/api/v1/media/stream',
]);

/** Prefixo das rotas que o player usa, autenticadas por token de dispositivo. */
const DEVICE_PREFIX = '/api/v1/player/';

interface DeviceRow {
  id: string;
  organization_id: string;
  store_id: string;
  zone_id: string;
  status: string;
}

async function resolveDeviceToken(db: SqlClient, token: string): Promise<DeviceRow | null> {
  const { rows } = await db.query<DeviceRow>(
    `select id, organization_id, store_id, zone_id, status
       from player_devices where token_hash = $1`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export function registerAuthentication(server: FastifyInstance, services: AppServices): void {
  const { db } = services;

  /*
   * Fastify exige um valor inicial para cada decorator. Ambos sao preenchidos
   * no primeiro hook de cada requisicao; o cast existe so para satisfazer a
   * assinatura, nunca e observavel por um handler.
   */
  server.decorateRequest('principal', null);
  server.decorateRequest('services', null as unknown as AppServices);

  server.addHook('onRequest', async (req) => {
    req.services = services;
    req.principal = null;

    const routeKey = `${req.method}:${req.routeOptions?.url ?? req.url.split('?')[0]}`;
    const isDeviceRoute = (req.routeOptions?.url ?? req.url).startsWith(DEVICE_PREFIX);

    // ---------------------------------------------------------------------
    // Player: Bearer token de dispositivo
    // ---------------------------------------------------------------------
    if (isDeviceRoute) {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
      if (!token) {
        throw new DomainError('device_token_invalid', 'Credencial de dispositivo ausente.');
      }

      const device = await resolveDeviceToken(db, token);
      if (!device) {
        throw new DomainError('device_token_invalid', 'Credencial de dispositivo invalida.');
      }
      if (device.status === 'revoked') {
        // Terminal: nem heartbeat nem manifesto. Exige novo pareamento.
        throw new DomainError('device_revoked', 'Este player foi removido da loja.', {
          action: 'Peca um novo codigo de pareamento no painel.',
          logContext: { deviceId: device.id },
        });
      }

      req.principal = {
        kind: 'device',
        deviceId: device.id,
        organizationId: device.organization_id,
        storeId: device.store_id,
        zoneId: device.zone_id,
      };
      return;
    }

    // ---------------------------------------------------------------------
    // Painel: cookie de sessao
    // ---------------------------------------------------------------------
    const isPublic = PUBLIC_ROUTES.has(routeKey);
    const cookie = req.cookies[SESSION_COOKIE];

    if (cookie) {
      const resolved = await resolveSession(db, cookie);
      if (resolved) {
        req.principal = resolved.principal;
        /*
         * CSRF so faz sentido com cookie -- e ele que o navegador envia
         * sozinho -- e so em rota que depende da sessao.
         *
         * Numa rota publica a checagem seria ativamente DANOSA: o tablet da
         * loja costuma ter um cookie de console de quando alguem logou nele,
         * e exigir token CSRF ali faria o pareamento do player falhar com
         * "sessao expirada" sem nenhum ganho de seguranca -- a rota nao usa
         * a sessao para nada. O mesmo vale para login num navegador que ainda
         * tem sessao antiga.
         */
        if (!isPublic) assertCsrf(req, resolved.csrfSecret);
        return;
      }
    }

    if (isPublic) return;

    throw new DomainError('unauthenticated', 'Faca login para continuar.');
  });
}
