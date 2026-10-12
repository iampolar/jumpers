import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '@castwave/contracts';

/**
 * Validacao de entrada.
 *
 * Nenhum handler toca `req.body` cru. Tudo passa por um schema Zod, e o que
 * sai daqui e um objeto tipado com os campos exatos que o dominio espera --
 * campos extras sao descartados, nao propagados. Isso tambem fecha a porta
 * para mass assignment: enviar `{"role":"owner"}` num update de perfil nao
 * tem efeito porque o schema simplesmente nao tem esse campo.
 */

function toIssues(error: z.ZodError): { path: string; code: string; message: string }[] {
  return error.issues.map((i) => ({
    path: i.path.join('.') || '(raiz)',
    code: i.code,
    message: i.message,
  }));
}

function parse<T extends z.ZodType>(schema: T, data: unknown, source: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DomainError('validation_failed', 'Alguns campos precisam ser corrigidos.', {
      issues: toIssues(result.error),
      logContext: { source },
    });
  }
  return result.data;
}

export const parseBody = <T extends z.ZodType>(req: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, req.body ?? {}, 'body');

export const parseQuery = <T extends z.ZodType>(req: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, req.query ?? {}, 'query');

export const parseParams = <T extends z.ZodType>(req: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, req.params ?? {}, 'params');

/** Parametro de rota com um unico id. O caso mais comum. */
export const zIdParam = z.object({ id: z.uuid('Identificador invalido.') });

export const idOf = (req: FastifyRequest): string => parseParams(req, zIdParam).id;

/**
 * Ordenacao com lista fechada de colunas permitidas.
 *
 * Receber o nome da coluna do cliente e interpola-lo no SQL e injecao. Aqui o
 * cliente escolhe entre chaves conhecidas e o mapa devolve o SQL -- nenhum
 * texto do usuario chega perto da query.
 */
export function sortClause<T extends Record<string, string>>(
  allowed: T,
  requested: string | undefined,
  direction: 'asc' | 'desc',
  fallback: keyof T,
): string {
  const key = requested && requested in allowed ? requested : String(fallback);
  const column = allowed[key as keyof T];
  return `${column} ${direction === 'asc' ? 'asc' : 'desc'}`;
}
