import { DomainError } from './errors.js';
import type { AnnouncementStatus, CampaignStatus, DeviceStatus, SubscriptionStatus } from './enums.js';

/**
 * Maquinas de estado do dominio.
 *
 * O frontend nunca envia um status: envia uma *acao* (`submit`, `approve`,
 * `revoke`). A transicao e resolvida aqui, no servidor. Isso elimina a classe
 * inteira de bugs em que uma tela empurra `status: "active"` direto para a API.
 */

export interface Transition<S extends string, A extends string> {
  readonly from: S;
  readonly action: A;
  readonly to: S;
}

export class StateMachine<S extends string, A extends string> {
  private readonly index = new Map<string, S>();

  constructor(
    readonly name: string,
    readonly initial: S,
    readonly transitions: readonly Transition<S, A>[],
    /** Estados terminais: nenhuma acao sai deles. */
    readonly terminal: readonly S[] = [],
  ) {
    for (const t of transitions) this.index.set(`${t.from}::${t.action}`, t.to);
  }

  can(from: S, action: A): boolean {
    return this.index.has(`${from}::${action}`);
  }

  isTerminal(state: S): boolean {
    return this.terminal.includes(state);
  }

  /** Acoes validas a partir de um estado. Alimenta o enable/disable dos botoes. */
  actionsFrom(from: S): A[] {
    return this.transitions.filter((t) => t.from === from).map((t) => t.action);
  }

  /** Aplica a transicao ou lanca `invalid_state_transition` (HTTP 400). */
  apply(from: S, action: A): S {
    const to = this.index.get(`${from}::${action}`);
    if (to === undefined) {
      throw new DomainError(
        'invalid_state_transition',
        `Nao e possivel executar "${action}" a partir de "${from}".`,
        { logContext: { machine: this.name, from, action } },
      );
    }
    return to;
  }
}

// --------------------------------------------------------------------------
// Anuncio
// --------------------------------------------------------------------------

export const ANNOUNCEMENT_ACTIONS = [
  'submit_approval',
  'approve',
  'reject',
  'schedule',
  'activate',
  'pause',
  'resume',
  'cancel',
  'expire',
  'complete',
  'fail',
  'reopen',
] as const;
export type AnnouncementAction = (typeof ANNOUNCEMENT_ACTIONS)[number];

export const announcementMachine = new StateMachine<AnnouncementStatus, AnnouncementAction>(
  'announcement',
  'draft',
  [
    { from: 'draft', action: 'submit_approval', to: 'pending_approval' },
    // Organizacao sem politica de aprovacao pula direto para aprovado.
    { from: 'draft', action: 'approve', to: 'approved' },
    { from: 'pending_approval', action: 'approve', to: 'approved' },
    { from: 'pending_approval', action: 'reject', to: 'rejected' },
    { from: 'pending_approval', action: 'cancel', to: 'cancelled' },
    { from: 'rejected', action: 'reopen', to: 'draft' },
    { from: 'approved', action: 'schedule', to: 'scheduled' },
    { from: 'approved', action: 'cancel', to: 'cancelled' },
    { from: 'approved', action: 'reopen', to: 'draft' },
    { from: 'scheduled', action: 'activate', to: 'active' },
    { from: 'scheduled', action: 'pause', to: 'paused' },
    { from: 'scheduled', action: 'cancel', to: 'cancelled' },
    { from: 'scheduled', action: 'expire', to: 'expired' },
    { from: 'active', action: 'pause', to: 'paused' },
    { from: 'active', action: 'complete', to: 'completed' },
    { from: 'active', action: 'expire', to: 'expired' },
    { from: 'active', action: 'cancel', to: 'cancelled' },
    { from: 'active', action: 'fail', to: 'failed' },
    { from: 'paused', action: 'resume', to: 'scheduled' },
    { from: 'paused', action: 'cancel', to: 'cancelled' },
    { from: 'paused', action: 'expire', to: 'expired' },
    { from: 'failed', action: 'reopen', to: 'draft' },
  ],
  ['completed', 'cancelled', 'expired'],
);

/** Estados em que o anuncio pode entrar num manifesto de player. */
export const ELIGIBLE_ANNOUNCEMENT_STATUSES: readonly AnnouncementStatus[] = ['scheduled', 'active'];

// --------------------------------------------------------------------------
// Dispositivo
// --------------------------------------------------------------------------

export const DEVICE_ACTIONS = ['pair', 'heartbeat', 'degrade', 'miss_heartbeat', 'revoke'] as const;
export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

export const deviceMachine = new StateMachine<DeviceStatus, DeviceAction>(
  'device',
  'pairing',
  [
    { from: 'pairing', action: 'pair', to: 'active' },
    { from: 'pairing', action: 'revoke', to: 'revoked' },
    { from: 'active', action: 'heartbeat', to: 'active' },
    { from: 'active', action: 'degrade', to: 'degraded' },
    { from: 'active', action: 'miss_heartbeat', to: 'offline' },
    { from: 'active', action: 'revoke', to: 'revoked' },
    { from: 'degraded', action: 'heartbeat', to: 'active' },
    { from: 'degraded', action: 'miss_heartbeat', to: 'offline' },
    { from: 'degraded', action: 'revoke', to: 'revoked' },
    { from: 'offline', action: 'heartbeat', to: 'active' },
    { from: 'offline', action: 'revoke', to: 'revoked' },
  ],
  ['revoked'], // terminal para a credencial atual: exige novo pareamento
);

// --------------------------------------------------------------------------
// Campanha
// --------------------------------------------------------------------------

export const CAMPAIGN_ACTIONS = ['publish', 'start', 'pause', 'resume', 'finish', 'cancel'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

export const campaignMachine = new StateMachine<CampaignStatus, CampaignAction>(
  'campaign',
  'draft',
  [
    { from: 'draft', action: 'publish', to: 'scheduled' },
    { from: 'draft', action: 'cancel', to: 'cancelled' },
    { from: 'scheduled', action: 'start', to: 'running' },
    { from: 'scheduled', action: 'pause', to: 'paused' },
    { from: 'scheduled', action: 'cancel', to: 'cancelled' },
    { from: 'running', action: 'pause', to: 'paused' },
    { from: 'running', action: 'finish', to: 'finished' },
    { from: 'running', action: 'cancel', to: 'cancelled' },
    { from: 'paused', action: 'resume', to: 'running' },
    { from: 'paused', action: 'finish', to: 'finished' },
    { from: 'paused', action: 'cancel', to: 'cancelled' },
  ],
  ['finished', 'cancelled'],
);

// --------------------------------------------------------------------------
// Assinatura
// --------------------------------------------------------------------------

export const SUBSCRIPTION_ACTIONS = [
  'activate',
  'mark_past_due',
  'recover',
  'pause',
  'resume',
  'cancel',
  'expire',
  'fail_setup',
] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

/**
 * Nunca apagar conteudo ao cancelar: `cancelled` e `expired` bloqueiam escrita,
 * preservam audio e campanhas e permitem reativacao (blueprint 7.3).
 */
export const subscriptionMachine = new StateMachine<SubscriptionStatus, SubscriptionAction>(
  'subscription',
  'trialing',
  [
    { from: 'incomplete', action: 'activate', to: 'active' },
    { from: 'incomplete', action: 'fail_setup', to: 'expired' },
    { from: 'trialing', action: 'activate', to: 'active' },
    { from: 'trialing', action: 'cancel', to: 'cancelled' },
    { from: 'trialing', action: 'expire', to: 'expired' },
    { from: 'active', action: 'mark_past_due', to: 'past_due' },
    { from: 'active', action: 'pause', to: 'paused' },
    { from: 'active', action: 'cancel', to: 'cancelled' },
    { from: 'active', action: 'activate', to: 'active' }, // renovacao idempotente
    { from: 'past_due', action: 'recover', to: 'active' },
    { from: 'past_due', action: 'cancel', to: 'cancelled' },
    { from: 'past_due', action: 'expire', to: 'expired' },
    { from: 'paused', action: 'resume', to: 'active' },
    { from: 'paused', action: 'cancel', to: 'cancelled' },
    { from: 'cancelled', action: 'activate', to: 'active' }, // reativacao
    { from: 'expired', action: 'activate', to: 'active' },
  ],
  [],
);

/** Estados que liberam escrita de conteudo. `past_due` mantem grace period. */
export const WRITABLE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
];
