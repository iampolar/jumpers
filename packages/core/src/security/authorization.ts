import {
  DomainError,
  ROLE_PERMISSIONS,
  STORE_SCOPED_PERMISSIONS,
  type OrganizationRole,
  type Permission,
  type PlatformRole,
} from '@castwave/contracts';

/**
 * Autorizacao.
 *
 * Um principal nunca informa a propria organizacao: o escopo sai da sessao
 * autenticada. Toda consulta ao banco recebe `organizationId` deste objeto e
 * nenhuma rota le `organization_id` do corpo ou da query.
 */

export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly platformRole: PlatformRole;
  /** `null` = acesso a todas as lojas. Lista = escopo restrito. */
  readonly scopedStoreIds: readonly string[] | null;
  readonly sessionId: string;
}

export interface DevicePrincipal {
  readonly kind: 'device';
  readonly deviceId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly zoneId: string;
}

export type Principal = UserPrincipal | DevicePrincipal;

export function hasPermission(principal: UserPrincipal, permission: Permission): boolean {
  return ROLE_PERMISSIONS[principal.role].includes(permission);
}

export function requirePermission(principal: UserPrincipal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    throw new DomainError('forbidden', 'Seu perfil nao permite esta acao.', {
      logContext: { role: principal.role, permission },
    });
  }
}

/**
 * Loja fora do escopo responde 404, nao 403.
 *
 * Responder 403 confirmaria que o recurso existe -- um oraculo de enumeracao
 * que vaza a estrutura de uma rede concorrente. 404 nao distingue "nao existe"
 * de "nao e seu".
 */
export function requireStoreScope(principal: UserPrincipal, storeId: string): void {
  if (principal.scopedStoreIds === null) return;
  if (!principal.scopedStoreIds.includes(storeId)) {
    throw new DomainError('not_found', 'Loja nao encontrada.', {
      logContext: { denied: 'store_scope', storeId, userId: principal.userId },
    });
  }
}

export function requirePermissionOnStore(
  principal: UserPrincipal,
  permission: Permission,
  storeId: string,
): void {
  requirePermission(principal, permission);
  if (STORE_SCOPED_PERMISSIONS.includes(permission)) requireStoreScope(principal, storeId);
}

/** Filtro de lojas a aplicar no SQL. `null` = sem filtro adicional. */
export function storeScopeFilter(principal: UserPrincipal): readonly string[] | null {
  return principal.scopedStoreIds;
}

export function requirePlatformRole(
  principal: UserPrincipal,
  minimum: 'support' | 'superadmin',
): void {
  const rank: Record<PlatformRole, number> = { none: 0, support: 1, superadmin: 2 };
  if (rank[principal.platformRole] < rank[minimum]) {
    // Para quem nao e da Jumpers, a area de operacao simplesmente nao existe.
    throw new DomainError('not_found', 'Recurso nao encontrado.', {
      logContext: { denied: 'platform_role', required: minimum, actual: principal.platformRole },
    });
  }
}

/**
 * Guarda de tenant para objetos ja carregados. Ultima barreira contra IDOR
 * quando uma consulta esquece o `where organization_id = $1`.
 */
export function assertSameOrganization(
  principal: Principal,
  resource: { organizationId: string } | null | undefined,
  resourceName: string,
): asserts resource is { organizationId: string } {
  if (!resource || resource.organizationId !== principal.organizationId) {
    throw new DomainError('not_found', `${resourceName} nao encontrado.`, {
      logContext: {
        denied: 'tenant_isolation',
        expected: principal.organizationId,
        got: resource?.organizationId ?? null,
      },
    });
  }
}

export function isUser(p: Principal): p is UserPrincipal {
  return p.kind === 'user';
}

export function isDevice(p: Principal): p is DevicePrincipal {
  return p.kind === 'device';
}
