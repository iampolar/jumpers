import { createSqlClient } from '@castwave/db';
import { buildApp, prepareDatabase } from './app.js';
import { ConfigError, createLogger, describeConfig, loadConfig } from '@castwave/runtime';

/**
 * Ponto de entrada da API.
 *
 * Ordem deliberada: valida a configuracao ANTES de abrir conexao ou porta. Um
 * processo que sobe com configuracao invalida e pior do que um que nao sobe --
 * ele atende trafego real em estado indefinido.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n\nVeja .env.example para a lista completa.\n\n`);
      process.exit(78); // EX_CONFIG (sysexits.h)
    }
    throw error;
  }

  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: !config.isProduction,
    bindings: { service: 'api' },
  });

  logger.info('configuracao carregada', describeConfig(config));

  const db = await createSqlClient({
    url: config.DATABASE_URL,
    maxConnections: config.DATABASE_MAX_CONNECTIONS,
    ssl: config.DATABASE_SSL,
  });

  const app = await buildApp({ config, db, logger });
  await prepareDatabase(app);

  // Desligamento gracioso: para de aceitar conexao, termina o que esta em voo
  // e so entao fecha o banco. Um kill -9 no meio de um commit e evitavel.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('encerrando', { signal });
    void app.server
      .close()
      .then(() => db.close())
      .then(() => {
        logger.info('encerrado com sucesso');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('falha ao encerrar', { message: (error as Error).message });
        process.exit(1);
      });
    // Rede de seguranca: nao ficar pendurado para sempre.
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('promise rejeitada sem tratamento', { reason: String(reason) });
  });

  await app.server.listen({ port: config.PORT, host: config.HOST });
  logger.info('API no ar', {
    url: `http://${config.HOST}:${config.PORT}`,
    health: `http://${config.HOST}:${config.PORT}/health/ready`,
  });
}

await main();
