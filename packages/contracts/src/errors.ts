/**
 * Codigos de erro estaveis. O cliente trata pelo `code`, nunca pela mensagem.
 * Mensagens sao seguras para exibicao: nunca carregam stack, SQL ou segredo.
 */
export const ERROR_CODES = {
  // 400
  validation_failed: 400,
  invalid_state_transition: 400,
  unsupported_media_type: 400,
  checksum_mismatch: 400,
  // 401
  unauthenticated: 401,
  invalid_credentials: 401,
  session_expired: 401,
  device_token_invalid: 401,
  // 403
  forbidden: 403,
  csrf_token_invalid: 403,
  device_revoked: 403,
  plan_limit_reached: 403,
  approval_required: 403,
  // 404
  not_found: 404,
  // 409
  conflict: 409,
  already_exists: 409,
  pairing_code_used: 409,
  idempotency_key_reused: 409,
  // 413 / 422 / 429
  payload_too_large: 413,
  unprocessable_media: 422,
  rate_limited: 429,
  // 500 / 503
  internal_error: 500,
  dependency_unavailable: 503,
  /** Nenhum provedor de IA/TTS configurado. Acao fica indisponivel, produto segue. */
  provider_not_configured: 503,
  /** `PAYMENTS_PROVIDER=disabled`: checkout bloqueado com motivo acionavel. */
  payments_not_configured: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /** Como o usuario resolve. Presente em erros acionaveis (ex. gateway off). */
    readonly action?: string;
    readonly issues?: readonly FieldIssue[];
    readonly requestId: string;
  };
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly action: string | undefined;
  readonly issues: readonly FieldIssue[] | undefined;
  /** Contexto apenas para log estruturado. Nunca serializado na resposta. */
  readonly logContext: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      action?: string;
      issues?: readonly FieldIssue[];
      logContext?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.action = options?.action;
    this.issues = options?.issues;
    this.logContext = options?.logContext;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.action ? { action: this.action } : {}),
        ...(this.issues ? { issues: this.issues } : {}),
        requestId,
      },
    };
  }
}

export const notFound = (resource: string): DomainError =>
  new DomainError('not_found', `${resource} nao encontrado.`);

export const forbidden = (reason = 'Voce nao tem permissao para esta acao.'): DomainError =>
  new DomainError('forbidden', reason);

export const conflict = (message: string): DomainError => new DomainError('conflict', message);
