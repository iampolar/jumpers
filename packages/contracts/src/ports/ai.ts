import { z } from 'zod';
import { zSafeText } from '../schemas/common';
import { MAX_SCRIPT_CHARS, zPronunciationDictionary } from '../schemas/content';

/**
 * Portas de IA.
 *
 * Geracao de roteiro e sintese de voz sao *dois* contratos separados: o
 * fornecedor de texto e o de voz quase nunca sao o mesmo, e trocar um nao pode
 * obrigar a trocar o outro.
 *
 * Nada aqui conhece OpenAI, Anthropic, ElevenLabs ou qualquer outro nome. O
 * dominio depende destas interfaces; os adapters concretos entram depois, com
 * credencial fornecida pelo operador (Fase 13 do roadmap).
 *
 * Regras que os adapters herdam e os testes de contrato verificam:
 *  - chamada parte sempre do servidor, nunca do browser;
 *  - timeout obrigatorio e numero de tentativas limitado;
 *  - retry reusa a mesma `idempotencyKey` e NAO contabiliza uso duas vezes;
 *  - resultado passa por validacao de schema antes de virar versao de anuncio;
 *  - sem credencial o `AiRegistry` devolve `not_configured` -- a acao fica
 *    indisponivel e o resto do produto segue funcionando.
 */

export const zCopyGenerationInput = z.object({
  locale: z.literal('pt-BR'),
  objective: zSafeText(3, 200),
  product: zSafeText(0, 160).optional(),
  offer: zSafeText(0, 200).optional(),
  priceText: zSafeText(0, 80).optional(),
  conditions: zSafeText(0, 300).optional(),
  tone: z.enum(['neutro', 'energetico', 'acolhedor', 'sofisticado', 'urgente']).default('neutro'),
  targetDurationSeconds: z.number().int().min(5).max(90).default(20),
  brandNotes: zSafeText(0, 300).optional(),
  pronunciationDictionary: zPronunciationDictionary.optional(),
  /** Termos que o roteiro nao pode conter (compliance da organizacao). */
  forbiddenTerms: z.array(zSafeText(1, 60)).max(100).default([]),
});
export type CopyGenerationInput = z.infer<typeof zCopyGenerationInput>;

export const zCopyGenerationResult = z.object({
  scriptText: z.string().min(1).max(MAX_SCRIPT_CHARS),
  estimatedDurationMs: z.number().int().positive(),
  /** Alternativas opcionais para o editor escolher. Nunca publicadas sozinhas. */
  variants: z.array(z.string().max(MAX_SCRIPT_CHARS)).max(3).default([]),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().nullable(),
  }),
  providerName: z.string(),
  modelId: z.string(),
});
export type CopyGenerationResult = z.infer<typeof zCopyGenerationResult>;

export const zSpeechSynthesisInput = z.object({
  locale: z.literal('pt-BR'),
  scriptText: z.string().min(1).max(MAX_SCRIPT_CHARS),
  voiceId: z.string().min(1).max(80),
  speakingRate: z.number().min(0.5).max(2).default(1),
  pronunciationDictionary: zPronunciationDictionary.optional(),
  outputFormat: z.enum(['mp3', 'wav', 'ogg']).default('mp3'),
  maxDurationSeconds: z.number().int().min(5).max(180).default(90),
});
export type SpeechSynthesisInput = z.infer<typeof zSpeechSynthesisInput>;

/**
 * O TTS devolve *bytes*, nunca uma URL publica permanente: o audio entra na
 * biblioteca privada da organizacao pelo mesmo caminho de um upload manual,
 * com checksum, validacao e previa antes de qualquer reproducao.
 */
export interface SpeechSynthesisResult {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly checksumSha256: string;
  readonly usage: { readonly characters: number; readonly costMicros: number | null };
  readonly providerName: string;
  readonly voiceId: string;
}

export interface AiCallOptions {
  /** Mesma chave em retry: o uso e contabilizado uma unica vez. */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Orcamento restante em micros. O adapter aborta antes de estourar. */
  readonly budgetMicrosRemaining: number | null;
}

export interface AnnouncementCopyProvider {
  readonly name: string;
  generate(input: CopyGenerationInput, options: AiCallOptions): Promise<CopyGenerationResult>;
}

export interface SpeechSynthesisProvider {
  readonly name: string;
  listVoices(): Promise<readonly { id: string; label: string; gender: string | null }[]>;
  synthesize(input: SpeechSynthesisInput, options: AiCallOptions): Promise<SpeechSynthesisResult>;
}

export const AI_ERROR_KINDS = [
  'not_configured',
  'timeout',
  'rate_limited',
  'invalid_response',
  'budget_exceeded',
  'content_rejected',
  'upstream_error',
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}
