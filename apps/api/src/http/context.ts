import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, type Permission } from '@castwave/contracts';
import {
  requirePermission,
  requirePermissionOnStore,
  requirePlatformRole,
  requireStoreScope,
  type DevicePrincipal,
  type UserPrincipal,
} from '@castwave/core';
import type { SqlClient } from '@castwave/db';
import type { AppConfig } from '@castwave/runtime';
import type { AuditWriter } from '../audit.js';
import type { LocalObjectStorage } from '../storage.js';

/**
 * Contexto de requisicao.
 *
 * Tudo que um handler precisa chega por aqui -- inclusive, e principalmente,
 * o escopo do chamador. Nenhuma rota le `organization_id` do corpo, da query
 * ou de um cabecalho: o escopo vem SEMPRE da sessao autenticada. Essa e a
 * linha que separa um SaaS multi-tenant de um vazamento de dados.
 */

export interface AppServices {
  readonly db: SqlClient;
  readonly config: AppConfig;
  readonly storage: LocalObjectStorage;
  readonly audit: AuditWriter;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo plugin de autenticacao. `null` em rota publica. */
    principal: UserPrincipal | DevicePrincipal | null;
    services: AppServices;
  }
}

/** Exige sessao humana. Falha com 401 se nao houver. */
export function requireUser(req: FastifyRequest): UserPrincipal {
  const principal = req.principal;
  if (!principal || principal.kind !== 'user') {
    throw new DomainError('unauthenticated', 'Faca login para continuar.');
  }
  return principal;
}

/** Exige credencial de dispositivo. Player nunca acessa rota administrativa. */
export function requireDevice(req: FastifyRequest): DevicePrincipal {
  const principal = req.principal;
  if (!principal || principal.kind !== 'device') {
    throw new DomainError('device_token_invalid', 'Credencial de dispositivo invalida.');
  }
  return principal;
}

/** Sessao + permissao, em uma chamada. O caminho normal de toda rota. */
export function authorize(req: FastifyRequest, permission: Permission): UserPrincipal {
  const principal = requireUser(req);
  requirePermission(principal, permission);
  return principal;
}

/** Sessao + permissao + escopo de loja. */
export function authorizeStore(
  req: FastifyRequest,
  permission: Permission,
  storeId: string,
): UserPrincipal {
  const principal = requireUser(req);
  requirePermissionOnStore(principal, permission, storeId);
  return principal;
}

/** Acesso ao painel Jumpers. Para quem nao e da equipe, a area nao existe. */
export function authorizePlatform(
  req: FastifyRequest,
  minimum: 'support' | 'superadmin' = 'support',
): UserPrincipal {
  const principal = requireUser(req);
  requirePlatformRole(principal, minimum);
  return principal;
}

export { requireStoreScope };

/**
 * Verificacao CSRF por double-submit.
 *
 * O cookie de sessao e `SameSite=Lax`, o que ja barra POST cross-site na
 * maioria dos navegadores. O token no cabecalho e a segunda camada: o
 * atacante nao consegue le-lo (nao ha CORS permitindo) nem adivinha-lo.
 * Metodos seguros (GET/HEAD/OPTIONS) nao precisam.
 */
export function assertCsrf(req: FastifyRequest, expectedSecret: string): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const header = req.headers['x-csrf-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || provided !== expectedSecret) {
    throw new DomainError('csrf_token_invalid', 'Sessao expirada. Recarregue a pagina.', {
      logContext: { reason: provided ? 'mismatch' : 'missing' },
    });
  }
}

/** Resposta 204 sem corpo. */
export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}

export function created<T>(reply: FastifyReply, body: T): FastifyReply {
  return reply.status(201).send(body);
}
