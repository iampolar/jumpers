import { describe, expect, it } from 'vitest';
import { DomainError, type OrganizationRole } from '@castwave/contracts';
import {
  assertSameOrganization,
  hasPermission,
  requirePermission,
  requirePermissionOnStore,
  requirePlatformRole,
  requireStoreScope,
  type UserPrincipal,
} from './authorization';

const principal = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user',
  userId: 'u1',
  organizationId: 'org-a',
  role: 'admin',
  platformRole: 'none',
  scopedStoreIds: null,
  sessionId: 's1',
  ...over,
});

const code = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : 'nao-era-DomainError';
  }
};

describe('matriz de permissoes', () => {
  it('owner pode tudo, inclusive assinatura', () => {
    const p = principal({ role: 'owner' });
    expect(hasPermission(p, 'billing:manage')).toBe(true);
    expect(hasPermission(p, 'org:update')).toBe(true);
    expect(hasPermission(p, 'audit:read')).toBe(true);
  });

  it('admin gerencia conteudo mas nao a assinatura', () => {
    const p = principal({ role: 'admin' });
    expect(hasPermission(p, 'announcements:write')).toBe(true);
    expect(hasPermission(p, 'members:manage')).toBe(true);
    expect(hasPermission(p, 'billing:manage')).toBe(false);
    expect(hasPermission(p, 'org:update')).toBe(false);
  });

  it('editor de conteudo nao aprova o proprio anuncio', () => {
    const p = principal({ role: 'content_editor' });
    expect(hasPermission(p, 'announcements:write')).toBe(true);
    expect(hasPermission(p, 'announcements:approve')).toBe(false);
    expect(hasPermission(p, 'members:manage')).toBe(false);
  });

  it('leitor/financeiro nao escreve conteudo', () => {
    const p = principal({ role: 'viewer_finance' });
    expect(hasPermission(p, 'analytics:export')).toBe(true);
    expect(hasPermission(p, 'billing:read')).toBe(true);
    expect(hasPermission(p, 'announcements:write')).toBe(false);
    expect(hasPermission(p, 'media:upload')).toBe(false);
  });

  it('operador de loja nao edita playlist nem convida gente', () => {
    const p = principal({ role: 'store_operator' });
    expect(hasPermission(p, 'devices:pair')).toBe(true);
    expect(hasPermission(p, 'playlists:write')).toBe(false);
    expect(hasPermission(p, 'members:manage')).toBe(false);
  });

  it('nenhum papel de cliente enxerga auditoria alem do permitido', () => {
    const roles: OrganizationRole[] = ['content_editor', 'store_operator', 'viewer_finance'];
    for (const role of roles) {
      expect(hasPermission(principal({ role }), 'audit:read')).toBe(false);
    }
  });

  it('negativa de permissao devolve 403', () => {
    expect(code(() => requirePermission(principal({ role: 'viewer_finance' }), 'media:upload'))).toBe('forbidden');
    expect(code(() => requirePermission(principal({ role: 'owner' }), 'media:upload'))).toBeNull();
  });
});

describe('escopo de loja', () => {
  it('escopo nulo significa todas as lojas', () => {
    expect(code(() => requireStoreScope(principal({ scopedStoreIds: null }), 'qualquer'))).toBeNull();
  });

  it('loja fora do escopo devolve 404, nao 403', () => {
    const p = principal({ role: 'store_operator', scopedStoreIds: ['store-1'] });
    expect(code(() => requireStoreScope(p, 'store-1'))).toBeNull();
    // 403 confirmaria que a loja existe. 404 nao vaza nada.
    expect(code(() => requireStoreScope(p, 'store-2'))).toBe('not_found');
  });

  it('permissao com escopo valida os dois lados', () => {
    const p = principal({ role: 'store_operator', scopedStoreIds: ['store-1'] });
    expect(code(() => requirePermissionOnStore(p, 'devices:read', 'store-1'))).toBeNull();
    expect(code(() => requirePermissionOnStore(p, 'devices:read', 'store-9'))).toBe('not_found');
    expect(code(() => requirePermissionOnStore(p, 'devices:manage', 'store-1'))).toBe('forbidden');
  });

  it('permissao global nao e limitada pelo escopo de loja', () => {
    const p = principal({ role: 'admin', scopedStoreIds: ['store-1'] });
    // `media:read` nao esta em STORE_SCOPED_PERMISSIONS: vale para a organizacao toda.
    expect(code(() => requirePermissionOnStore(p, 'media:read', 'store-9'))).toBeNull();
  });
});

describe('isolamento entre organizacoes', () => {
  it('recurso de outro tenant responde 404', () => {
    const p = principal({ organizationId: 'org-a' });
    expect(code(() => assertSameOrganization(p, { organizationId: 'org-a' }, 'Anuncio'))).toBeNull();
    expect(code(() => assertSameOrganization(p, { organizationId: 'org-b' }, 'Anuncio'))).toBe('not_found');
    expect(code(() => assertSameOrganization(p, null, 'Anuncio'))).toBe('not_found');
    expect(code(() => assertSameOrganization(p, undefined, 'Anuncio'))).toBe('not_found');
  });

  it('a mensagem de erro nao revela o tenant dono', () => {
    try {
      assertSameOrganization(principal(), { organizationId: 'org-secreta' }, 'Playlist');
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err.message).toBe('Playlist nao encontrado.');
      expect(err.message).not.toContain('org-secreta');
      // O contexto so existe para o log estruturado, nunca para o corpo HTTP.
      expect(err.toBody('req-1').error).not.toHaveProperty('logContext');
    }
  });
});

describe('painel Jumpers', () => {
  it('cliente comum nao sabe que a area existe (404, nao 403)', () => {
    expect(code(() => requirePlatformRole(principal({ platformRole: 'none' }), 'support'))).toBe('not_found');
  });

  it('suporte entra na area de suporte mas nao na de superadmin', () => {
    const p = principal({ platformRole: 'support' });
    expect(code(() => requirePlatformRole(p, 'support'))).toBeNull();
    expect(code(() => requirePlatformRole(p, 'superadmin'))).toBe('not_found');
  });

  it('superadmin entra em tudo', () => {
    const p = principal({ platformRole: 'superadmin' });
    expect(code(() => requirePlatformRole(p, 'support'))).toBeNull();
    expect(code(() => requirePlatformRole(p, 'superadmin'))).toBeNull();
  });

  it('ser owner da organizacao nao da acesso ao painel da Jumpers', () => {
    expect(code(() => requirePlatformRole(principal({ role: 'owner', platformRole: 'none' }), 'support'))).toBe(
      'not_found',
    );
  });
});
