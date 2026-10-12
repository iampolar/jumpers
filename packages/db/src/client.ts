import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Cliente SQL.
 *
 * Uma unica interface sobre dois drivers que falam o MESMO dialeto:
 *
 *  - `pglite`: PostgreSQL de verdade compilado para WASM, em memoria ou em
 *    disco. Sobe em ~700 ms, sem Docker, sem servico. E o que permite rodar
 *    `npm install && npm test` numa maquina limpa e exercitar migrations,
 *    constraints, indices parciais e isolamento de tenant contra um Postgres
 *    autentico -- nao contra um mock.
 *  - `postgres`: node-postgres com pool, para producao.
 *
 * O SQL e identico nos dois: nao ha "modo de teste" no codigo de dominio, e um
 * teste que passa aqui exercitou as mesmas constraints que vao rodar em
 * producao. Ver docs/adr/0002.
 */

export interface QueryResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
}

export interface SqlClient {
  readonly driver: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Executa multiplos comandos. Nao aceita parametros -- use em DDL/migration. */
  exec(text: string): Promise<void>;
  /**
   * Transacao real. Rollback automatico em excecao. Dentro do callback use
   * SEMPRE o `tx` recebido: usar o cliente externo escaparia da transacao.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// Driver PGlite
// --------------------------------------------------------------------------

/**
 * Numero de linhas que a instrucao realmente tocou.
 *
 * O PGlite expoe `affectedRows` para INSERT/UPDATE/DELETE e `rows` para
 * SELECT/RETURNING -- nunca os dois ao mesmo tempo. Contar so `rows.length`
 * faria todo UPDATE sem RETURNING reportar zero, e o padrao
 * `update ... where id = $1 and organization_id = $2` seguido de
 * "rowCount === 0 -> 404" passaria a negar operacoes legitimas. O node-postgres
 * ja devolve `rowCount` unificado; esta funcao iguala os dois drivers.
 */
function affectedOrReturned(result: { rows: unknown[]; affectedRows?: number }): number {
  return result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0);
}

class PgliteClient implements SqlClient {
  readonly driver = 'pglite' as const;

  constructor(private readonly db: PGlite) {}

  static async create(dataDir?: string): Promise<PgliteClient> {
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    await db.waitReady;
    return new PgliteClient(db);
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.db.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: affectedOrReturned(result) };
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction<T>(async (tx) => {
      const scoped: SqlClient = {
        driver: 'pglite',
        query: async <R>(text: string, params: readonly unknown[] = []) => {
          const r = await tx.query<R>(text, params as unknown[]);
          return { rows: r.rows, rowCount: affectedOrReturned(r) };
        },
        exec: async (text: string) => {
          await tx.exec(text);
        },
        // Postgres nao aninha transacoes; reentrar apenas reusa a mesma.
        transaction: async <R>(inner: (c: SqlClient) => Promise<R>) => inner(scoped),
        close: async () => {
          /* a transacao nao e dona da conexao */
        },
      };
      return fn(scoped);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

// --------------------------------------------------------------------------
// Driver node-postgres
// --------------------------------------------------------------------------

class PostgresClient implements SqlClient {
  readonly driver = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  static create(connectionString: string, options: { maxConnections?: number; ssl?: boolean } = {}): PostgresClient {
    const pool = new pg.Pool({
      connectionString,
      max: options.maxConnections ?? 10,
      // Derruba conexao ociosa antes de o balanceador fazer isso por nos.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    return new PostgresClient(pool);
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const r = await this.pool.query(text, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    const scoped: SqlClient = {
      driver: 'postgres',
      query: async <R>(text: string, params: readonly unknown[] = []) => {
        const r = await conn.query(text, params as unknown[]);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
      },
      exec: async (text: string) => {
        await conn.query(text);
      },
      transaction: async <R>(inner: (c: SqlClient) => Promise<R>) => inner(scoped),
      close: async () => {
        /* a transacao nao e dona do pool */
      },
    };
    try {
      await conn.query('begin');
      const out = await fn(scoped);
      await conn.query('commit');
      return out;
    } catch (error) {
      await conn.query('rollback').catch(() => {
        /* conexao ja perdida: o rollback acontece no servidor */
      });
      throw error;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// --------------------------------------------------------------------------
// Fabrica
// --------------------------------------------------------------------------

export interface DatabaseConfig {
  /**
   * `memory://`            -> PGlite em memoria (testes)
   * `file://./.data/db`    -> PGlite em disco (desenvolvimento sem Docker)
   * `postgres://user@host` -> node-postgres (producao e Docker Compose)
   */
  readonly url: string;
  readonly maxConnections?: number;
  readonly ssl?: boolean;
}

/**
 * Raiz do monorepo: o diretorio mais alto que declara `workspaces`.
 *
 * Um `DATABASE_URL` relativo precisa apontar para o mesmo lugar venha ele da
 * API, do worker ou da CLI de migration -- e cada um deles roda com um `cwd`
 * diferente (npm workspaces executa scripts dentro do pacote). Ancorar na raiz
 * garante um unico banco de desenvolvimento, nao tres.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  let found: string | null = null;
  for (let i = 0; i < 12; i += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) found = dir;
      } catch {
        /* manifest ilegivel: segue subindo */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found ?? process.cwd();
}

/**
 * Trava de processo unico para o PGlite em disco.
 *
 * PGlite e um PostgreSQL embarcado: um unico processo pode abrir o diretorio
 * de dados. Dois (API + worker, ou duas APIs apos um restart mal feito)
 * corrompem o cluster e o segundo morre com um `RuntimeError: Aborted()` do
 * WebAssembly -- erro que nao diz absolutamente nada sobre a causa real.
 *
 * O arquivo de trava guarda o PID. Se o dono nao existe mais, a trava e
 * considerada orfa e reaproveitada; se existe, falhamos com uma mensagem que
 * explica o problema e as duas saidas.
 */
function acquireSingleProcessLock(dataDir: string): void {
  const lockFile = join(dataDir, '.castwave-lock');

  if (existsSync(lockFile)) {
    const owner = Number(readFileSync(lockFile, 'utf8').trim());
    let alive: boolean;
    try {
      // Sinal 0 nao envia nada: so testa se o processo existe.
      process.kill(owner, 0);
      alive = owner !== process.pid;
    } catch {
      alive = false; // processo morto: trava orfa
    }

    if (alive) {
      throw new Error(
        [
          `O banco de desenvolvimento em "${dataDir}" ja esta aberto pelo processo ${owner}.`,
          'PGlite e um PostgreSQL embarcado de processo unico -- dois processos corrompem o cluster.',
          '  - para rodar API e worker juntos, use um PostgreSQL de verdade:',
          '      DATABASE_URL=postgres://castwave:castwave@localhost:5432/castwave',
          '  - ou encerre o outro processo antes de subir este.',
        ].join('\n'),
      );
    }
    rmSync(lockFile, { force: true });
  }

  writeFileSync(lockFile, String(process.pid), 'utf8');
  const release = (): void => {
    try {
      if (existsSync(lockFile) && readFileSync(lockFile, 'utf8').trim() === String(process.pid)) {
        rmSync(lockFile, { force: true });
      }
    } catch {
      /* encerrando: nada a fazer */
    }
  };
  process.once('exit', release);
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
}

function resolveDataDir(url: string): string {
  const raw = url.slice('file://'.length);
  const path = isAbsolute(raw) ? raw : resolve(repoRoot(), raw);
  // PGlite abre o diretorio mas nao cria a arvore de pais.
  mkdirSync(path, { recursive: true });
  acquireSingleProcessLock(path);
  return path;
}

export async function createSqlClient(config: DatabaseConfig): Promise<SqlClient> {
  const { url } = config;
  if (url === 'memory://' || url === 'memory:') return PgliteClient.create();
  if (url.startsWith('file://')) return PgliteClient.create(resolveDataDir(url));
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return PostgresClient.create(url, {
      ...(config.maxConnections !== undefined ? { maxConnections: config.maxConnections } : {}),
      ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
    });
  }
  throw new Error(
    `DATABASE_URL nao reconhecida: "${url}". Use memory://, file://<caminho> ou postgres://...`,
  );
}

/** Mede latencia de ida e volta para o /health/ready. */
export async function pingDatabase(client: SqlClient): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    await client.query('select 1 as ok');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}
