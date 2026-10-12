import { createHash } from 'node:crypto';
import type { SqlClient } from './client';
import { MIGRATIONS, type Migration } from './migrations/index';

/**
 * Migrador.
 *
 * Tres garantias, nessa ordem de importancia:
 *
 *  1. **Atomicidade.** Cada migration roda dentro de uma transacao junto com o
 *     registro de que foi aplicada. Postgres tem DDL transacional, entao uma
 *     migration que falha no meio nao deixa meio schema aplicado.
 *  2. **Imutabilidade.** O checksum do SQL e gravado. Se alguem editar uma
 *     migration ja aplicada, o proximo deploy PARA com erro em vez de abrir um
 *     abismo silencioso entre o schema de producao e o do repositorio.
 *  3. **Exclusao mutua.** Um advisory lock impede que duas instancias subindo
 *     ao mesmo tempo apliquem a mesma migration em paralelo.
 */

const LOCK_KEY = 0x6361_7374; // "cast"

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly totalMs: number;
}

const checksum = (sql: string): string =>
  // Normaliza fim de linha: um clone com autocrlf no Windows nao pode
  // invalidar o checksum de uma migration que ja rodou no Linux.
  createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex').slice(0, 32);

async function ensureMigrationsTable(db: SqlClient): Promise<void> {
  await db.exec(`
    create table if not exists schema_migrations (
      id          text primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer     not null default 0
    );
  `);
}

export async function listApplied(db: SqlClient): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(db);
  const { rows } = await db.query<{
    id: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>('select id, checksum, applied_at, duration_ms from schema_migrations order by id');
  return rows.map((r) => ({
    id: r.id,
    checksum: r.checksum,
    appliedAt: new Date(r.applied_at),
    durationMs: Number(r.duration_ms),
  }));
}

export interface MigrateOptions {
  readonly migrations?: readonly Migration[];
  readonly onProgress?: (event: { id: string; status: 'applying' | 'applied' | 'skipped'; ms?: number }) => void;
}

export async function migrate(db: SqlClient, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  const startedAt = performance.now();

  // Advisory lock de sessao. PGlite e single-connection, entao e um no-op
  // inofensivo la; em Postgres real e o que serializa deploys concorrentes.
  const lockable = db.driver === 'postgres';
  if (lockable) await db.query('select pg_advisory_lock($1)', [LOCK_KEY]);

  try {
    await ensureMigrationsTable(db);
    const applied = new Map((await listApplied(db)).map((m) => [m.id, m]));

    const appliedNow: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      const expected = checksum(migration.sql);
      const previous = applied.get(migration.id);

      if (previous) {
        if (previous.checksum !== expected) {
          throw new Error(
            `Migration "${migration.id}" foi alterada depois de aplicada ` +
              `(checksum ${previous.checksum} no banco, ${expected} no repositorio). ` +
              'Crie uma nova migration em vez de editar uma ja aplicada.',
          );
        }
        skipped.push(migration.id);
        options.onProgress?.({ id: migration.id, status: 'skipped' });
        continue;
      }

      options.onProgress?.({ id: migration.id, status: 'applying' });
      const t0 = performance.now();
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(
          'insert into schema_migrations (id, checksum, duration_ms) values ($1, $2, $3)',
          [migration.id, expected, Math.round(performance.now() - t0)],
        );
      });
      const ms = Math.round(performance.now() - t0);
      appliedNow.push(migration.id);
      options.onProgress?.({ id: migration.id, status: 'applied', ms });
    }

    return { applied: appliedNow, skipped, totalMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (lockable) await db.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
  }
}

/**
 * Apaga e recria o schema. Destrutivo por definicao, portanto recusa rodar
 * contra producao ou contra qualquer banco que nao seja descartavel, a nao ser
 * que o chamador assuma o risco explicitamente.
 */
export async function resetSchema(
  db: SqlClient,
  options: { readonly allowDestructive?: boolean } = {},
): Promise<void> {
  const isEphemeral = db.driver === 'pglite';
  if (!isEphemeral && !options.allowDestructive) {
    throw new Error(
      'resetSchema recusado: o banco alvo nao e efemero. ' +
        'Passe allowDestructive: true apenas em banco de teste descartavel.',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema e proibido com NODE_ENV=production.');
  }
  await db.exec('drop schema if exists public cascade; create schema public;');
}

/** Diferenca entre o que o repositorio tem e o que o banco aplicou. */
export async function pendingMigrations(db: SqlClient): Promise<string[]> {
  const applied = new Set((await listApplied(db)).map((m) => m.id));
  return MIGRATIONS.filter((m) => !applied.has(m.id)).map((m) => m.id);
}
