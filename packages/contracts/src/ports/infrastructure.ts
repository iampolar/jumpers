import type { JobQueue } from '../enums.js';

/**
 * Portas de infraestrutura. Cada uma tem pelo menos um driver que roda hoje,
 * sem servico externo, e um driver de producao selecionado por ambiente.
 */

// --------------------------------------------------------------------------
// Storage de objetos
// --------------------------------------------------------------------------

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksumSha256: string;
}

export interface ObjectStorage {
  readonly driver: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /**
   * URL de leitura com TTL curto. Nunca permanente, nunca adivinhavel: o token
   * carrega `key`, expiracao e assinatura HMAC do servidor.
   */
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
}

// --------------------------------------------------------------------------
// Filas
// --------------------------------------------------------------------------

export interface JobPayloadMap {
  'media-process': { mediaAssetId: string; organizationId: string };
  'announcement-ai': { announcementId: string; organizationId: string; kind: 'copy' | 'tts' };
  'schedule-publish': { organizationId: string | null };
  'analytics-rollup': { organizationId: string | null; localDate: string | null };
  'notification-delivery': { notificationId: string; organizationId: string };
  'billing-events': { webhookEventId: string };
}

export interface EnqueueOptions {
  /** Mesma chave = mesmo job. Reenfileirar nao duplica trabalho. */
  readonly idempotencyKey?: string;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  readonly organizationId?: string | null;
}

export interface JobQueuePort {
  readonly driver: string;
  enqueue<Q extends JobQueue>(
    queue: Q,
    payload: JobPayloadMap[Q],
    options?: EnqueueOptions,
  ): Promise<{ jobId: string; deduplicated: boolean }>;
}

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type JobHandler<Q extends JobQueue> = (
  payload: JobPayloadMap[Q],
  ctx: JobContext,
) => Promise<void>;

// --------------------------------------------------------------------------
// Sonda de audio
// --------------------------------------------------------------------------

export interface AudioProbeResult {
  readonly container: string;
  readonly codec: string | null;
  readonly durationMs: number;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly bitrateKbps: number | null;
  /** Presente apenas com FFmpeg. `null` no driver nativo. */
  readonly loudnessLufs: number | null;
  /** Qual driver produziu este resultado. Vai para o log e para a UI. */
  readonly probedBy: 'ffprobe' | 'native-header';
}

export interface AudioProbe {
  readonly driver: string;
  readonly available: boolean;
  probe(bytes: Uint8Array, filename: string): Promise<AudioProbeResult>;
}

// --------------------------------------------------------------------------
// E-mail
// --------------------------------------------------------------------------

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Sem SMTP configurado o driver registra `not_configured` e a notificacao fica
 * dentro do app. Nunca reportar entrega que nao aconteceu.
 */
export interface Mailer {
  readonly driver: string;
  readonly configured: boolean;
  send(email: OutboundEmail): Promise<{ delivered: boolean; reason: string | null }>;
}

// --------------------------------------------------------------------------
// Relogio
// --------------------------------------------------------------------------

/** Injetado em todo lugar que decide "agora": torna DST e vigencia testaveis. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(d: Date | string): void {
    this.current = typeof d === 'string' ? new Date(d) : d;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
