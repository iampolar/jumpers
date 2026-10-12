import type { OrganizationRole, PlatformRole } from './enums.js';

/**
 * Matriz de permissoes.
 *
 * Esta tabela e a *unica* fonte de verdade e e compartilhada entre API e UI:
 * a API decide (deny-by-default, em todas as rotas), a UI apenas desabilita
 * botoes com o mesmo calculo para nao oferecer uma acao que vai falhar.
 * Esconder link nao e autorizacao -- ver `requirePermission` em apps/api.
 */

export const PERMISSIONS = [
  'org:read',
  'org:update',
  'members:read',
  'members:manage',
  'stores:read',
  'stores:manage',
  'zones:manage',
  'devices:read',
  'devices:pair',
  'devices:manage',
  'media:read',
  'media:upload',
  'media:manage',
  'announcements:read',
  'announcements:write',
  'announcements:approve',
  'playlists:read',
  'playlists:write',
  'schedules:read',
  'schedules:write',
  'campaigns:read',
  'campaigns:write',
  'analytics:read',
  'analytics:export',
  'billing:read',
  'billing:manage',
  'ai:generate',
  'support:write',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const OWNER: readonly Permission[] = PERMISSIONS;

const ADMIN: readonly Permission[] = PERMISSIONS.filter(
  (p) => p !== 'billing:manage' && p !== 'org:update',
);

const CONTENT_EDITOR: readonly Permission[] = [
  'org:read',
  'members:read',
  'stores:read',
  'devices:read',
  'media:read',
  'media:upload',
  'media:manage',
  'announcements:read',
  'announcements:write',
  'playlists:read',
  'playlists:write',
  'schedules:read',
  'schedules:write',
  'campaigns:read',
  'campaigns:write',
  'analytics:read',
  'ai:generate',
  'support:write',
];

/** Operador de loja: so enxerga o que foi escopado em `store_memberships`. */
const STORE_OPERATOR: readonly Permission[] = [
  'org:read',
  'stores:read',
  'devices:read',
  'devices:pair',
  'media:read',
  'announcements:read',
  'playlists:read',
  'schedules:read',
  'campaigns:read',
  'analytics:read',
  'support:write',
];

const VIEWER_FINANCE: readonly Permission[] = [
  'org:read',
  'members:read',
  'stores:read',
  'devices:read',
  'media:read',
  'announcements:read',
  'playlists:read',
  'schedules:read',
  'campaigns:read',
  'analytics:read',
  'analytics:export',
  'billing:read',
  'support:write',
];

export const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  owner: OWNER,
  admin: ADMIN,
  content_editor: CONTENT_EDITOR,
  store_operator: STORE_OPERATOR,
  viewer_finance: VIEWER_FINANCE,
};

export const ROLE_LABELS_PT: Record<OrganizationRole, string> = {
  owner: 'Proprietario',
  admin: 'Administrador',
  content_editor: 'Editor de conteudo',
  store_operator: 'Operador de loja',
  viewer_finance: 'Leitor / Financeiro',
};

export const ROLE_DESCRIPTIONS_PT: Record<OrganizationRole, string> = {
  owner: 'Controle total, incluindo assinatura e exclusao da organizacao.',
  admin: 'Gerencia conteudo, lojas, dispositivos e equipe. Nao altera a assinatura.',
  content_editor: 'Cria anuncios, envia audio e monta programacao. Pode exigir aprovacao.',
  store_operator: 'Acompanha e opera apenas as lojas atribuidas a ele.',
  viewer_finance: 'Consulta relatorios e assinatura. Nao edita conteudo.',
};

export function roleHasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Permissoes que um operador de loja exerce *somente* dentro das lojas em que
 * tem escopo. Para as demais lojas a resposta e 404, nao 403: nao vazamos a
 * existencia de recursos fora do escopo.
 */
export const STORE_SCOPED_PERMISSIONS: readonly Permission[] = [
  'devices:read',
  'devices:pair',
  'devices:manage',
  'analytics:read',
  'analytics:export',
  'schedules:read',
  'schedules:write',
];

export const PLATFORM_ROLE_LABELS_PT: Record<PlatformRole, string> = {
  none: 'Sem acesso Jumpers',
  support: 'Suporte Jumpers',
  superadmin: 'Superadmin Jumpers',
};

/** Acesso ao painel Jumpers. Guard proprio, rotas e layout separados. */
export function canAccessPlatformConsole(role: PlatformRole): boolean {
  return role === 'support' || role === 'superadmin';
}
