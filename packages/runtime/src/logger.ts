import { redact } from '@castwave/core';

/**
 * Log estruturado em JSON.
 *
 * Uma linha = um objeto JSON, sempre com `requestId`, para que uma requisicao
 * possa ser seguida de ponta a ponta num agregador. Todo payload passa por
 * `redact()` antes de sair: token, senha, cookie e assinatura viram
 * `[redacted]`. Roteiro de anuncio tambem nao entra em log -- e conteudo
 * comercial do cliente, nao dado de operacao.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface Logger {
  readonly level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** `pretty` so em desenvolvimento; producao sempre JSON de uma linha. */
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
  readonly sink?: (line: string) => void;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: '\u001B[90m',
  debug: '\u001B[36m',
  info: '\u001B[32m',
  warn: '\u001B[33m',
  error: '\u001B[31m',
};
const RESET = '\u001B[0m';

export function createLogger(options: LoggerOptions): Logger {
  const { level, pretty = false, bindings = {} } = options;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const threshold = LEVEL_ORDER[level];

  const emit = (entryLevel: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) return;

    const payload = {
      time: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...bindings,
      ...(data ? (redact(data) as Record<string, unknown>) : {}),
    };

    if (!pretty) {
      sink(JSON.stringify(payload));
      return;
    }

    const { time, level: lvl, msg, ...rest } = payload;
    const stamp = String(time).slice(11, 23);
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    sink(`${LEVEL_COLOR[entryLevel]}${String(lvl).toUpperCase().padEnd(5)}${RESET} ${stamp} ${String(msg)}${extra}`);
  };

  return {
    level,
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
    trace: (m, d) => emit('trace', m, d),
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

/** Logger silencioso para testes que nao verificam saida. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => undefined });
