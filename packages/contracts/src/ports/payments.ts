import type { SubscriptionAction } from '../state-machines';

/**
 * Porta de pagamento.
 *
 * O dominio de assinatura nao conhece nenhum gateway. Nao ha "stripe" nem
 * "mercadopago" em lugar nenhum fora de um futuro `adapters/<nome>.ts`.
 *
 * Invariantes que o adapter concreto herda:
 *  - preco e moeda vem do catalogo no servidor; o browser nunca os informa;
 *  - redirect de navegador NAO comprova pagamento: so webhook validado muda estado;
 *  - `verifyWebhook` roda ANTES de qualquer efeito colateral;
 *  - deduplicacao por `(provider, eventId)`;
 *  - eventos fora de ordem sao resolvidos pela maquina de estados, nao pelo
 *    ultimo que chegou;
 *  - nunca armazenar cartao completo ou CVV.
 */

export interface CheckoutRequest {
  readonly organizationId: string;
  readonly planCode: string;
  /** Resolvido no servidor a partir do catalogo. Entra so para conferencia. */
  readonly priceCents: number;
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
  /** Minimo necessario para o gateway. Sem dado pessoal superfluo. */
  readonly customer: { readonly email: string; readonly name: string };
}

export interface CheckoutSession {
  readonly providerSessionId: string;
  readonly redirectUrl: string;
  readonly expiresAt: string;
}

export interface WebhookVerificationInput {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface VerifiedWebhookEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly organizationId: string | null;
  readonly providerSubscriptionId: string | null;
  /** Transicao pretendida. `null` = evento informativo, apenas registrado. */
  readonly intent: SubscriptionAction | null;
  /** Payload ja minimizado pelo adapter: sem PII alem do indispensavel. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RemoteSubscriptionState {
  readonly providerSubscriptionId: string;
  readonly status: string;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  /** `false` enquanto `PAYMENTS_PROVIDER=disabled`. */
  readonly enabled: boolean;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Valida assinatura criptografica e janela de replay. Lanca
   * `PaymentProviderError('invalid_signature')` sem efeito colateral algum.
   */
  verifyWebhook(input: WebhookVerificationInput): Promise<VerifiedWebhookEvent>;

  getSubscription(providerSubscriptionId: string): Promise<RemoteSubscriptionState>;

  cancelSubscription(
    providerSubscriptionId: string,
    options: { readonly atPeriodEnd: boolean },
  ): Promise<RemoteSubscriptionState>;
}

export const PAYMENT_ERROR_KINDS = [
  'not_configured',
  'invalid_signature',
  'replay_detected',
  'unknown_event',
  'upstream_error',
  'plan_not_found',
] as const;
export type PaymentErrorKind = (typeof PAYMENT_ERROR_KINDS)[number];

export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}
