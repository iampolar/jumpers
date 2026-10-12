import type { SqlClient } from '@castwave/db';
import { truncateIp } from '@castwave/core';

/**
 * Trilha de auditoria append-only.
 *
 * Registra *quem* fez *o que*, *em que*, e se deu certo. Guarda tambem as
 * negativas: uma tentativa de acessar recurso de outra organizacao e
 * exatamente o evento que interessa numa investigacao, e ela nunca apareceria
 * se so registrassemos sucesso.
 *
 * O que nunca entra aqui: senha, token, roteiro de anuncio, conteudo de
 * mensagem de suporte. IP vem truncado em /24 ou /48.
 */

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEntry {
  readonly organizationId: string | null;
  readonly actorType: 'user' | 'device' | 'system' | 'platform';
  readonly actorId?: string | null;
  readonly actorLabel?: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly outcome?: AuditOutcome;
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** Metadado minimo e nao sensivel: contagens, nomes de campo, estados. */
  readonly metadata?: Record<string, unknown>;
}

export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

export function createAuditWriter(db: SqlClient): AuditWriter {
  return {
    async write(entry: AuditEntry): Promise<void> {
      await db.query(
        `insert into audit_logs (organization_id, actor_type, actor_id, actor_label, action,
            resource_type, resource_id, outcome, reason, request_id, ip_prefix, user_agent, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          entry.organizationId,
          entry.actorType,
          entry.actorId ?? null,
          entry.actorLabel ?? null,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.outcome ?? 'success',
          entry.reason ?? null,
          entry.requestId ?? null,
          truncateIp(entry.ip),
          entry.userAgent?.slice(0, 200) ?? null,
          JSON.stringify(entry.metadata ?? {}),
        ],
      );
    },
  };
}

/**
 * Acoes auditadas. Lista fechada para que o painel de auditoria possa
 * filtrar por valores conhecidos em vez de texto livre.
 */
export const AUDIT_ACTIONS = {
  // Identidade
  userRegistered: 'user.registered',
  userLoggedIn: 'user.logged_in',
  userLoginFailed: 'user.login_failed',
  userLoggedOut: 'user.logged_out',
  passwordResetRequested: 'user.password_reset_requested',
  passwordResetCompleted: 'user.password_reset_completed',
  sessionsRevoked: 'user.sessions_revoked',
  // Organizacao e equipe
  organizationUpdated: 'organization.updated',
  memberInvited: 'member.invited',
  memberUpdated: 'member.updated',
  memberRemoved: 'member.removed',
  // Lojas e dispositivos
  storeCreated: 'store.created',
  storeUpdated: 'store.updated',
  storeArchived: 'store.archived',
  zoneCreated: 'zone.created',
  zoneUpdated: 'zone.updated',
  pairingCodeIssued: 'device.pairing_code_issued',
  devicePaired: 'device.paired',
  deviceUpdated: 'device.updated',
  deviceRevoked: 'device.revoked',
  // Conteudo
  mediaUploaded: 'media.uploaded',
  mediaArchived: 'media.archived',
  announcementCreated: 'announcement.created',
  announcementVersioned: 'announcement.versioned',
  announcementTransitioned: 'announcement.transitioned',
  playlistUpdated: 'playlist.updated',
  scheduleUpdated: 'schedule.updated',
  campaignTransitioned: 'campaign.transitioned',
  // Dados e plano
  reportExported: 'analytics.exported',
  planChanged: 'billing.plan_changed',
  checkoutAttempted: 'billing.checkout_attempted',
  // Operacao Jumpers
  platformAccessed: 'platform.accessed',
  platformImpersonationDenied: 'platform.impersonation_denied',
  jobRequeued: 'platform.job_requeued',
} as const;
