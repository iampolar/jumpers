import * as m0001 from './0001_foundation.js';
import * as m0002 from './0002_stores_devices.js';
import * as m0003 from './0003_media_announcements.js';
import * as m0004 from './0004_programming.js';
import * as m0005 from './0005_playback_analytics.js';
import * as m0006 from './0006_billing.js';
import * as m0007 from './0007_operations.js';

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

/**
 * Registro ordenado das migrations.
 *
 * A lista e explicita, nao um glob de diretorio: a ordem de aplicacao e uma
 * decisao versionada em code review, nao um efeito colateral da ordenacao de
 * arquivos do sistema operacional -- que difere entre Windows e Linux.
 *
 * O SQL vive em modulos TypeScript em vez de arquivos .sql soltos porque o
 * mesmo codigo roda sob tsx, tsup, vitest e Next: importar texto de disco
 * quebraria assim que o bundle mudasse de forma. Ver docs/adr/0003.
 */
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007];

if (new Set(MIGRATIONS.map((m) => m.id)).size !== MIGRATIONS.length) {
  throw new Error('Ids de migration duplicados em MIGRATIONS.');
}
