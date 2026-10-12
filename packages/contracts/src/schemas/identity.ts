import { z } from 'zod';
import { MEMBERSHIP_STATUSES, ORGANIZATION_ROLES, ORGANIZATION_STATUSES, PLATFORM_ROLES, USER_STATUSES } from '../enums';
import { zEmail, zId, zIsoDateTime, zSafeText, zSlug, zTimezone } from './common';

/**
 * Politica de senha. 12 caracteres e o piso do NIST SP 800-63B quando nao ha
 * composicao obrigatoria; preferimos comprimento a "1 maiuscula e 1 simbolo".
 */
export const zPassword = z
  .string()
  .min(12, 'Use ao menos 12 caracteres.')
  .max(256)
  .refine((v) => v.trim().length === v.length || v.trim().length >= 12, {
    message: 'Senha nao pode ser apenas espacos.',
  });

export const zRegisterInput = z.object({
  name: zSafeText(2, 120),
  email: zEmail,
  password: zPassword,
  organizationName: zSafeText(2, 120),
  timezone: zTimezone.default('America/Sao_Paulo'),
  acceptedTerms: z.literal(true, { message: 'E necessario aceitar os termos de uso.' }),
});
export type RegisterInput = z.infer<typeof zRegisterInput>;

export const zLoginInput = z.object({
  email: zEmail,
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof zLoginInput>;

export const zForgotPasswordInput = z.object({ email: zEmail });

export const zResetPasswordInput = z.object({
  token: z.string().min(20).max(256),
  password: zPassword,
});

export const zUser = z.object({
  id: zId,
  name: z.string(),
  email: z.string(),
  status: z.enum(USER_STATUSES),
  platformRole: z.enum(PLATFORM_ROLES),
  mfaEnabled: z.boolean(),
  createdAt: zIsoDateTime,
});
export type User = z.infer<typeof zUser>;

export const zOrganization = z.object({
  id: zId,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: z.enum(ORGANIZATION_STATUSES),
  /** Quando true, anuncio precisa de `announcements:approve` antes de publicar. */
  requiresApproval: z.boolean(),
  createdAt: zIsoDateTime,
});
export type Organization = z.infer<typeof zOrganization>;

export const zUpdateOrganizationInput = z.object({
  name: zSafeText(2, 120).optional(),
  slug: zSlug.optional(),
  timezone: zTimezone.optional(),
  requiresApproval: z.boolean().optional(),
});

export const zMembership = z.object({
  id: zId,
  userId: zId,
  name: z.string(),
  email: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.enum(MEMBERSHIP_STATUSES),
  /** Vazio = acesso a todas as lojas. Preenchido = escopo restrito. */
  storeIds: z.array(zId),
  lastSeenAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});
export type Membership = z.infer<typeof zMembership>;

export const zInviteMemberInput = z.object({
  email: zEmail,
  name: zSafeText(2, 120),
  role: z.enum(ORGANIZATION_ROLES),
  storeIds: z.array(zId).max(200).default([]),
});
export type InviteMemberInput = z.infer<typeof zInviteMemberInput>;

export const zUpdateMemberInput = z.object({
  role: z.enum(ORGANIZATION_ROLES).optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  storeIds: z.array(zId).max(200).optional(),
});

/** Resposta de `GET /auth/me`: identidade + escopo efetivo + permissoes. */
export const zSessionContext = z.object({
  user: zUser,
  organization: zOrganization,
  role: z.enum(ORGANIZATION_ROLES),
  permissions: z.array(z.string()),
  /** `null` = todas as lojas da organizacao. */
  scopedStoreIds: z.array(zId).nullable(),
  organizations: z.array(z.object({ id: zId, name: z.string(), slug: z.string(), role: z.enum(ORGANIZATION_ROLES) })),
});
export type SessionContext = z.infer<typeof zSessionContext>;
