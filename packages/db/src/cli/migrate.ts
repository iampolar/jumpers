#!/usr/bin/env tsx
/**
 * CLI de migration.
 *
 *   npm run db:migrate            aplica o que falta
 *   npm run db:migrate -- --status   so mostra o estado
 *   npm run db:reset              recria o schema (banco descartavel)
 */
import { createSqlClient } from '../client.js';
import { listApplied, migrate, pendingMigrations, resetSchema } from '../migrator.js';

const url = process.env.DATABASE_URL ?? 'file://./.data/castwave';
const args = new Set(process.argv.slice(2));

const db = await createSqlClient({ url });
const label = url.replace(/:\/\/[^@]*@/, '://***@'); // nunca imprime credencial

try {
  if (args.has('--status')) {
    const applied = await listApplied(db);
    const pending = await pendingMigrations(db);
    console.log(`banco: ${label} (${db.driver})`);
    for (const m of applied) console.log(`  aplicada  ${m.id}  ${m.durationMs}ms`);
    for (const p of pending) console.log(`  PENDENTE  ${p}`);
    if (!pending.length) console.log('  schema em dia.');
    process.exit(0);
  }

  if (args.has('--reset')) {
    await resetSchema(db, { allowDestructive: args.has('--yes-destroy-data') });
    console.log(`schema recriado em ${label}`);
  }

  const result = await migrate(db, {
    onProgress: (e) => {
      if (e.status === 'applied') console.log(`  aplicada  ${e.id}  ${e.ms}ms`);
      if (e.status === 'skipped') console.log(`  em dia    ${e.id}`);
    },
  });
  console.log(
    `\n${result.applied.length} aplicada(s), ${result.skipped.length} ja existente(s) em ${result.totalMs}ms.`,
  );
} catch (error) {
  console.error(`\nfalha na migration: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
