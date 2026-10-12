import {
  AiProviderError,
  zCopyGenerationInput,
  zCopyGenerationResult,
  type AiCallOptions,
  type AnnouncementCopyProvider,
  type CopyGenerationInput,
  type CopyGenerationResult,
  type SpeechSynthesisInput,
  type SpeechSynthesisProvider,
  type SpeechSynthesisResult,
} from '@castwave/contracts';
import { estimateScriptDurationMs, sha256Hex } from '@castwave/core';
import type { AppConfig } from '@castwave/runtime';

/**
 * Registro de provedores de IA.
 *
 * Nenhum fornecedor real e escolhido aqui. O registro devolve `null` quando a
 * integracao esta desligada -- que e o padrao -- e a rota transforma isso num
 * 503 `provider_not_configured` com instrucao. O produto inteiro continua
 * utilizavel: escrita manual, modelos prontos e upload de audio.
 *
 * O adapter concreto, quando existir, implementa as mesmas interfaces e passa
 * pela mesma validacao de saida que o mock. Trocar de fornecedor e trocar um
 * arquivo, nao reescrever o dominio.
 */

/**
 * Mock de desenvolvimento.
 *
 * Existe para exercitar o fluxo completo -- gerar, revisar, editar, aprovar --
 * sem credencial. A configuracao recusa `mock` em producao, e o resultado vem
 * marcado com `providerName: 'mock'` para que nenhuma tela o apresente como
 * locucao de verdade.
 */
class MockCopyProvider implements AnnouncementCopyProvider {
  readonly name = 'mock';

  // eslint-disable-next-line @typescript-eslint/require-await
  async generate(input: CopyGenerationInput, options: AiCallOptions): Promise<CopyGenerationResult> {
    if (options.budgetMicrosRemaining !== null && options.budgetMicrosRemaining <= 0) {
      throw new AiProviderError('budget_exceeded', 'Orcamento de IA esgotado.', false);
    }

    const partes = [
      input.product ? `${input.product}` : input.objective,
      input.offer ? `, ${input.offer}` : '',
      input.priceText ? ` por ${input.priceText}` : '',
      '.',
      input.conditions ? ` ${input.conditions}` : '',
    ];
    const scriptText = `Atencao, clientes! ${partes.join('')} Aproveite enquanto durar.`.slice(0, 1200);

    return zCopyGenerationResult.parse({
      scriptText,
      estimatedDurationMs: estimateScriptDurationMs(scriptText),
      variants: [],
      usage: { inputTokens: null, outputTokens: null, costMicros: 0 },
      providerName: 'mock',
      modelId: 'mock-copy-v1',
    });
  }
}

class MockSpeechProvider implements SpeechSynthesisProvider {
  readonly name = 'mock';

  // eslint-disable-next-line @typescript-eslint/require-await
  async listVoices(): Promise<readonly { id: string; label: string; gender: string | null }[]> {
    return [
      { id: 'mock-feminina', label: 'Voz feminina (simulada)', gender: 'female' },
      { id: 'mock-masculina', label: 'Voz masculina (simulada)', gender: 'male' },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
    /*
     * Gera um WAV real de silencio com a duracao estimada. E audio valido --
     * passa pela mesma sonda de qualquer upload -- mas inaudivel, para que
     * ninguem confunda com locucao de verdade.
     */
    const durationMs = Math.min(estimateScriptDurationMs(input.scriptText), input.maxDurationSeconds * 1000);
    const sampleRate = 22050;
    const frames = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
    const dataBytes = frames * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);

    const audio = new Uint8Array(buf);
    return {
      audio,
      mimeType: 'audio/wav',
      durationMs,
      checksumSha256: sha256Hex(audio),
      usage: { characters: input.scriptText.length, costMicros: 0 },
      providerName: 'mock',
      voiceId: input.voiceId,
    };
  }
}

export interface AiRegistry {
  readonly copy: AnnouncementCopyProvider | null;
  readonly speech: SpeechSynthesisProvider | null;
  readonly copyState: 'not_configured' | 'configured';
  readonly speechState: 'not_configured' | 'configured';
}

export function createAiRegistry(config: AppConfig): AiRegistry {
  // `mock` so e aceito fora de producao -- garantido tambem na validacao de
  // configuracao, que recusa o boot caso contrario.
  const copy = config.AI_COPY_PROVIDER === 'mock' && !config.isProduction ? new MockCopyProvider() : null;
  const speech = config.AI_TTS_PROVIDER === 'mock' && !config.isProduction ? new MockSpeechProvider() : null;

  return {
    copy,
    speech,
    copyState: copy ? 'configured' : 'not_configured',
    speechState: speech ? 'configured' : 'not_configured',
  };
}

/** Opcoes padrao: timeout obrigatorio e chave de idempotencia sempre presente. */
export function defaultCallOptions(idempotencyKey: string, budgetMicrosRemaining: number | null): AiCallOptions {
  return {
    idempotencyKey,
    // Sem timeout, um fornecedor lento prende a conexao do lojista.
    timeoutMs: 20_000,
    budgetMicrosRemaining,
  };
}

export { zCopyGenerationInput };
