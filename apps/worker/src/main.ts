import { hostname } from 'node:os';
import { createSqlClient } from '@castwave/db';
import { ConfigError, createLogger, describeConfig, loadConfig } from '@castwave/runtime';
import { buildHandlers } from './handlers.js';
import { enqueue, JobRunner } from './runner.js';

/**
 * Processo worker.
 *
 * Separado da API de proposito: processar audio e agregar metricas nao pode
 * competir por CPU com a requisicao de um lojista. Compartilha configuracao e
 * dominio, nunca codigo de UI.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(78);
    }
    throw error;
  }

  const workerId = `${hostname()}-${process.pid}`;
  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: !config.isProduction,
    bindings: { service: 'worker', workerId },
  });
  logger.info('configuracao carregada', describeConfig(config));

  const db = await createSqlClient({
    url: config.DATABASE_URL,
    maxConnections: Math.max(2, Math.floor(config.DATABASE_MAX_CONNECTIONS / 2)),
    ssl: config.DATABASE_SSL,
  });

  const runner = new JobRunner({
    db,
    workerId,
    handlers: buildHandlers({ deviceOfflineAfterSeconds: config.DEVICE_OFFLINE_AFTER_SECONDS }),
    log: (level, message, data) => logger[level](message, data),
  });

  /*
   * Tarefas periodicas entram como jobs normais, com chave de idempotencia por
   * minuto: varios workers rodando nao duplicam o trabalho, e a execucao fica
   * visivel no mesmo painel de filas que todo o resto.
   */
  const scheduleTick = setInterval(() => {
    const minute = new Date().toISOString().slice(0, 16);
    void enqueue(db, 'schedule-publish', { organizationId: null }, {
      idempotencyKey: `tick-${minute}`,
    }).catch((error: unknown) => {
      logger.error('falha ao enfileirar tarefa periodica', { message: (error as Error).message });
    });
  }, 60_000);
  scheduleTick.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('encerrando worker', { signal });
    clearInterval(scheduleTick);
    runner.stop();
    // Dá ao job em voo a chance de terminar antes de fechar o banco.
    setTimeout(() => {
      void db.close().finally(() => process.exit(0));
    }, 2000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runner.start();
}

await main();
