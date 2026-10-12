#!/usr/bin/env tsx
/**
 * Semeia catalogo de planos e (opcionalmente) a organizacao de demonstracao.
 * Nao destrutivo e recusa rodar em producao.
 */
import { createSqlClient } from '../client';
import { migrate } from '../migrator';
import { seed } from '../seed';

const url = process.env.DATABASE_URL ?? 'file://./.data/castwave';
const plansOnly = process.argv.includes('--plans-only');

const db = await createSqlClient({ url });

try {
  await migrate(db);
  const result = await seed(db, { withDemoOrganization: !plansOnly });

  console.log(`planos inseridos: ${result.plans}`);
  if (result.organizationId) {
    console.log(`organizacao:      Rede Aurora (${result.stores} lojas, ${result.zones} zonas)`);
    console.log(`playlists:        ${result.playlists} | agendas: ${result.schedules}`);
    if (result.ownerPassword) {
      console.log(`\nacesso de desenvolvimento:`);
      console.log(`  e-mail: ${result.ownerEmail}`);
      console.log(`  senha:  ${result.ownerPassword}`);
      console.log(`  (credencial de demonstracao local; troque antes de expor o ambiente)`);
    }
  }
  for (const note of result.notes) console.log(`nota: ${note}`);
} catch (error) {
  console.error(`falha no seed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
