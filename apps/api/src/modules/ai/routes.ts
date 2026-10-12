import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AiProviderError,
  DomainError,
  zCopyGenerationInput,
  zSpeechSynthesisInput,
} from '@castwave/contracts';
import { assertWithinQuota } from '@castwave/core';
import { authorize, type AppServices } from '../../http/context';
import { parseBody } from '../../http/validate';
import { loadUsage, recordUsage } from '../billing/usage';
import { createAiRegistry, defaultCallOptions } from './registry';

/**
 * Rotas de IA.
 *
 * Sem provedor configurado -- o padrao -- devolvem 503
 * `provider_not_configured` com instrucao do que fazer. Nunca um texto
 * generico inventado, nunca um audio falso apresentado como locucao.
 *
 * Quando houver provedor:
 *  - a chamada parte do servidor, nunca do browser;
 *  - a cota e verificada ANTES e contabilizada DEPOIS, com chave de
 *    idempotencia, para que um retry nao cobre duas vezes;
 *  - o resultado NAO vai direto para o ar: vira rascunho de versao, sujeito a
 *    previa, edicao e aprovacao como qualquer texto escrito a mao.
 */

export function registerAiRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, config } = services;
  const registry = createAiRegistry(config);

  const unavailable = (what: string): never => {
    throw new DomainError('provider_not_configured', `${what} ainda nao esta disponivel nesta instalacao.`, {
      action:
        'Escreva o roteiro manualmente ou use um modelo pronto. Para habilitar, configure um provedor de IA.',
    });
  };

  server.get('/api/v1/ai/status', (req) => {
    authorize(req, 'announcements:read');
    return {
      copy: { state: registry.copyState, provider: registry.copy?.name ?? null },
      speech: { state: registry.speechState, provider: registry.speech?.name ?? null },
      // A UI usa isto para desabilitar o botao COM motivo, em vez de escondê-lo.
      disabledReason:
        registry.copyState === 'not_configured'
          ? 'Nenhum provedor de IA conectado. A escrita manual e os modelos continuam disponiveis.'
          : null,
    };
  });

  server.get('/api/v1/ai/voices', async (req) => {
    authorize(req, 'announcements:read');
    if (!registry.speech) unavailable('A geracao de locucao');
    return { voices: await registry.speech!.listVoices() };
  });

  server.post('/api/v1/ai/copy', async (req) => {
    const principal = authorize(req, 'ai:generate');
    const input = parseBody(req, zCopyGenerationInput);

    if (!registry.copy) unavailable('A geracao de roteiro por IA');

    // Cota antes da chamada: nao gastamos credito para recusar depois.
    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('ai_copy', usage.quotas, usage.snapshot);

    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ?? `${principal.userId}:${Date.now()}`;

    try {
      const result = await registry.copy!.generate(
        input,
        defaultCallOptions(idempotencyKey, null),
      );

      // Mesma chave em retry: o uso e contabilizado uma unica vez.
      await recordUsage(db, {
        organizationId: principal.organizationId,
        metric: 'ai_copy_generations',
        quantity: 1,
        periodStart: usage.periodStart,
        source: `ai:${registry.copy!.name}`,
        idempotencyKey,
      });

      return {
        ...result,
        // Explicito: o resultado ainda nao e um anuncio. Precisa virar versao,
        // ser revisado e aprovado antes de qualquer reproducao.
        status: 'draft_suggestion',
        note: 'Revise e edite antes de publicar. Nada vai ao ar sem aprovacao.',
      };
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw new DomainError(
          error.kind === 'budget_exceeded' ? 'plan_limit_reached' : 'dependency_unavailable',
          error.kind === 'timeout'
            ? 'O provedor de IA demorou demais para responder.'
            : 'Nao foi possivel gerar o roteiro agora.',
          {
            action: 'Tente novamente ou escreva o roteiro manualmente.',
            logContext: { kind: error.kind, retryable: error.retryable },
          },
        );
      }
      throw error;
    }
  });

  server.post('/api/v1/ai/speech', async (req) => {
    const principal = authorize(req, 'ai:generate');
    const input = parseBody(req, zSpeechSynthesisInput);

    if (!registry.speech) unavailable('A geracao de locucao');

    const usage = await loadUsage(db, principal.organizationId);
    assertWithinQuota('ai_tts', usage.quotas, usage.snapshot, Math.ceil(input.scriptText.length / 15));

    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ?? `${principal.userId}:${Date.now()}`;

    const result = await registry.speech!.synthesize(input, defaultCallOptions(idempotencyKey, null));

    await recordUsage(db, {
      organizationId: principal.organizationId,
      metric: 'ai_tts_seconds',
      quantity: Math.round(result.durationMs / 1000),
      periodStart: usage.periodStart,
      source: `tts:${result.providerName}`,
      idempotencyKey,
    });

    /*
     * O audio entra na biblioteca pelo MESMO caminho de um upload manual --
     * com checksum, validacao e previa. Nao existe atalho que coloque bytes
     * de um provedor direto na grade.
     */
    return {
      durationMs: result.durationMs,
      checksumSha256: result.checksumSha256,
      providerName: result.providerName,
      voiceId: result.voiceId,
      sizeBytes: result.audio.byteLength,
      status: 'draft_suggestion',
      note: 'Escute a previa e aprove antes de usar na programacao.',
    };
  });

  void z;
}
