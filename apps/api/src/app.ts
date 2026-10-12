import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, type ApiErrorBody } from '@castwave/contracts';
import { truncateIp } from '@castwave/core';
import { migrate, type SqlClient } from '@castwave/db';
import type { AppConfig } from '@castwave/runtime';
import { buildHealthReport, describeIntegrations } from './health.js';
import { createLogger, type Logger } from '@castwave/runtime';
import { createAuditWriter } from './audit.js';
import { registerAuthentication } from './http/authenticate.js';
import type { AppServices } from './http/context.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerDomainRoutes } from './routes.js';
import { createStorage, type LocalObjectStorage } from './storage.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly db: SqlClient;
  readonly logger?: Logger;
  readonly storage?: LocalObjectStorage;
}

export interface CastWaveApp {
  readonly server: FastifyInstance;
  readonly config: AppConfig;
  readonly db: SqlClient;
  readonly logger: Logger;
  readonly storage: LocalObjectStorage;
  readonly services: AppServices;
}

export const API_VERSION = '0.1.0';

/**
 * Converte valor desconhecido em texto sem nunca produzir "[object Object]"
 * numa resposta HTTP ou numa linha de log.
 */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    log2: Logger;
  }
}

export async function buildApp(deps: AppDependencies): Promise<CastWaveApp> {
  const { config, db } = deps;
  const startedAt = Date.now();

  const logger =
    deps.logger ??
    createLogger({
      level: config.LOG_LEVEL,
      pretty: !config.isProduction,
      bindings: { service: 'api', version: API_VERSION },
    });

  const storage = deps.storage ?? createStorage(config);

  const server = Fastify({
    // Usamos nosso proprio logger estruturado; o do Fastify ficaria duplicado.
    logger: false,
    // Confiar em proxy so quando ha um na frente. Confiar sempre permitiria
    // forjar X-Forwarded-For e furar o rate limit por IP.
    trustProxy: config.isProduction,
    bodyLimit: 1024 * 1024, // 1 MiB; upload de audio tem rota propria
    genReqId: (req) => {
      // Aceita correlation id do cliente, mas so se tiver forma de UUID --
      // caso contrario um atacante poderia poluir o log com texto arbitrario.
      const header = req.headers['x-request-id'];
      const candidate = Array.isArray(header) ? header[0] : header;
      return candidate && /^[0-9a-fA-F-]{8,64}$/.test(candidate) ? candidate : randomUUID();
    },
  });

  // -------------------------------------------------------------------------
  // Cabecalhos de seguranca
  // -------------------------------------------------------------------------
  await server.register(helmet, {
    // A API serve JSON; nada de script deve nascer dela.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  await server.register(cors, {
    // Lista fixa, nunca reflexo do Origin recebido.
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'x-csrf-token', 'idempotency-key', 'authorization'],
    maxAge: 600,
  });

  if (config.RATE_LIMIT_ENABLED) {
    await server.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      // Chave por IP truncado: mesma granularidade que guardamos em auditoria.
      keyGenerator: (req) => truncateIp(req.ip) ?? req.ip,
      errorResponseBuilder: (req, context) => ({
        error: {
          code: 'rate_limited',
          message: `Muitas requisicoes. Tente novamente em ${Math.ceil(context.ttl / 1000)}s.`,
          requestId: req.id,
        },
      }),
    });
  }

  await server.register(cookie, {
    // Nao assinamos o cookie: o valor ja e um token opaco de 256 bits cujo
    // hash vive no banco. Assinar adicionaria um segredo a girar sem ganho.
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/' },
  });

  // -------------------------------------------------------------------------
  // Correlacao e log de requisicao
  // -------------------------------------------------------------------------
  server.addHook('onRequest', (req, reply, done) => {
    req.requestId = req.id;
    req.log2 = logger.child({ requestId: req.id });
    reply.header('x-request-id', req.id);
    done();
  });

  server.addHook('onResponse', (req, reply, done) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    req.log2[level]('request', {
      method: req.method,
      path: req.routeOptions?.url ?? req.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ip: truncateIp(req.ip),
    });
    done();
  });

  // -------------------------------------------------------------------------
  // Erros: forma unica, sem stack trace, sempre com requestId
  // -------------------------------------------------------------------------
  server.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) {
      req.log2[error.status >= 500 ? 'error' : 'warn']('erro de dominio', {
        code: error.code,
        status: error.status,
        ...error.logContext,
      });
      void reply.status(error.status).send(error.toBody(req.id));
      return;
    }

    if (error instanceof z.ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'validation_failed',
          message: 'Alguns campos precisam ser corrigidos.',
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
          requestId: req.id,
        },
      };
      void reply.status(400).send(body);
      return;
    }

    // Apos os dois `instanceof` acima o TypeScript estreita `error` para
    // `unknown`; normalizamos antes de ler qualquer propriedade.
    const fallback = error as { statusCode?: unknown; name?: unknown; message?: unknown; stack?: unknown };

    if (typeof fallback.statusCode === 'number' && fallback.statusCode < 500) {
      void reply.status(fallback.statusCode).send({
        error: {
          code: 'validation_failed',
          message: asText(fallback.message, 'Requisicao invalida.'),
          requestId: req.id,
        },
      });
      return;
    }

    // Erro nao previsto: detalhe so no log, nunca na resposta.
    req.log2.error('erro nao tratado', {
      name: asText(fallback.name, 'Error'),
      message: asText(fallback.message, ''),
      stack: typeof fallback.stack === 'string' ? fallback.stack : undefined,
    });
    void reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'Erro interno. A equipe foi notificada.',
        requestId: req.id,
      },
    });
  });

  server.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: 'Rota nao encontrada.', requestId: req.id },
    });
  });

  // -------------------------------------------------------------------------
  // Saude
  // -------------------------------------------------------------------------
  const healthDeps = {
    db,
    config,
    startedAt,
    version: API_VERSION,
    storagePing: () => storage.ping(),
  };

  /** Liveness: o processo responde. Nao toca dependencia nenhuma. */
  server.get('/health/live', { config: { rateLimit: false } }, () => ({
    status: 'ok' as const,
    version: API_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  /** Readiness: da para mandar trafego? 503 enquanto nao der. */
  server.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    const report = await buildHealthReport(healthDeps);
    return reply.status(report.status === 'down' ? 503 : 200).send(report);
  });

  /**
   * Estado das integracoes: o que esta ligado, o que nao esta e o que fica
   * indisponivel por causa disso. Nunca expoe valor de variavel de ambiente.
   */
  server.get('/api/v1/status/integrations', () => ({
    integrations: describeIntegrations(config),
  }));

  const services: AppServices = { db, config, storage, audit: createAuditWriter(db) };

  // A autenticacao roda como hook global: nenhuma rota pode "esquecer" de
  // exigir credencial, porque a lista de excecoes e explicita e fechada.
  registerAuthentication(server, services);
  registerAuthRoutes(server, services);
  registerDomainRoutes(server, services);

  return { server, config, db, logger, storage, services };
}

/** Aplica migrations pendentes no boot, fora de producao. */
export async function prepareDatabase(app: CastWaveApp): Promise<void> {
  if (app.config.isProduction) {
    app.logger.info('migrations nao sao aplicadas automaticamente em producao');
    return;
  }
  const result = await migrate(app.db);
  if (result.applied.length > 0) {
    app.logger.info('migrations aplicadas', { count: result.applied.length, ids: result.applied });
  }
}
