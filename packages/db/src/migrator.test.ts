import { afterEach, describe, expect, it } from 'vitest';
import { createSqlClient, type SqlClient } from './client.js';
import { listApplied, migrate, pendingMigrations, resetSchema } from './migrator.js';
import { MIGRATIONS } from './migrations/index.js';

/**
 * Estes testes rodam contra PostgreSQL de verdade (PGlite, WASM), do zero.
 * Nao ha mock: as constraints, FKs compostas e indices parciais exercitados
 * aqui sao exatamente os que vao para producao.
 */

let open: SqlClient[] = [];

async function freshDb(): Promise<SqlClient> {
  const db = await createSqlClient({ url: 'memory://' });
  open.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(open.map((db) => db.close().catch(() => undefined)));
  open = [];
});

describe('aplicacao do schema do zero', () => {
  it('aplica todas as migrations em um banco vazio', async () => {
    const db = await freshDb();
    const result = await migrate(db);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(result.skipped).toHaveLength(0);
    expect(await pendingMigrations(db)).toHaveLength(0);
  });

  it('cria todas as tabelas do modelo de dados', async () => {
    const db = await freshDb();
    await migrate(db);
    const { rows } = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tables = rows.map((r) => r.table_name);

    for (const expected of [
      'analytics_daily',
      'announcement_stores',
      'announcement_versions',
      'announcements',
      'audio_zones',
      'audit_logs',
      'campaign_announcements',
      'campaign_stores',
      'campaigns',
      'checkout_sessions',
      'device_heartbeats',
      'device_pairing_codes',
      'idempotency_keys',
      'jobs',
      'media_assets',
      'notifications',
      'organization_memberships',
      'organizations',
      'outbox_events',
      'password_reset_tokens',
      'payment_webhook_events',
      'plans',
      'playback_events',
      'playlist_items',
      'playlists',
      'player_devices',
      'schedule_exceptions',
      'schedules',
      'sessions',
      'store_memberships',
      'stores',
      'subscriptions',
      'support_messages',
      'support_tickets',
      'usage_ledger',
      'users',
    ]) {
      expect(tables, `tabela ausente: ${expected}`).toContain(expected);
    }
  });

  it('e idempotente: rodar de novo nao aplica nada', async () => {
    const db = await freshDb();
    await migrate(db);
    const second = await migrate(db);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('registra checksum e duracao de cada migration', async () => {
    const db = await freshDb();
    await migrate(db);
    const applied = await listApplied(db);
    expect(applied).toHaveLength(MIGRATIONS.length);
    for (const m of applied) {
      expect(m.checksum).toMatch(/^[0-9a-f]{32}$/);
      expect(m.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('recusa aplicar uma migration editada depois de aplicada', async () => {
    const db = await freshDb();
    await migrate(db);
    // Simula alguem editando o SQL de uma migration que ja rodou em producao.
    const tampered = MIGRATIONS.map((m) =>
      m.id === '0002_stores_devices' ? { ...m, sql: `${m.sql}\n-- alteracao indevida` } : m,
    );
    await expect(migrate(db, { migrations: tampered })).rejects.toThrow(/alterada depois de aplicada/);
  });

  it('resetSchema zera e permite reaplicar', async () => {
    const db = await freshDb();
    await migrate(db);
    await resetSchema(db);
    expect(await pendingMigrations(db)).toEqual(MIGRATIONS.map((m) => m.id));
    const again = await migrate(db);
    expect(again.applied).toHaveLength(MIGRATIONS.length);
  });
});

describe('integridade do schema', () => {
  async function seeded(): Promise<{ db: SqlClient; orgA: string; orgB: string; storeA: string; storeB: string; zoneA: string }> {
    const db = await freshDb();
    await migrate(db);
    const org = async (name: string, slug: string): Promise<string> =>
      (
        await db.query<{ id: string }>(
          'insert into organizations (name, slug, timezone) values ($1, $2, $3) returning id',
          [name, slug, 'America/Sao_Paulo'],
        )
      ).rows[0]!.id;
    const store = async (orgId: string, name: string, slug: string, tz: string): Promise<string> =>
      (
        await db.query<{ id: string }>(
          'insert into stores (organization_id, name, slug, timezone) values ($1, $2, $3, $4) returning id',
          [orgId, name, slug, tz],
        )
      ).rows[0]!.id;

    const orgA = await org('Rede Aurora', 'aurora');
    const orgB = await org('Rede Boreal', 'boreal');
    const storeA = await store(orgA, 'Aurora Centro', 'centro', 'America/Sao_Paulo');
    const storeB = await store(orgB, 'Boreal Manaus', 'manaus', 'America/Manaus');
    const zoneA = (
      await db.query<{ id: string }>(
        'insert into audio_zones (organization_id, store_id, name) values ($1, $2, $3) returning id',
        [orgA, storeA, 'Salao'],
      )
    ).rows[0]!.id;

    return { db, orgA, orgB, storeA, storeB, zoneA };
  }

  it('a FK composta impede associar recursos de organizacoes diferentes', async () => {
    const { db, orgA, storeB } = await seeded();
    // Zona da org A apontando para loja da org B: o BANCO recusa, mesmo que a
    // aplicacao tivesse um bug e deixasse passar.
    await expect(
      db.query('insert into audio_zones (organization_id, store_id, name) values ($1, $2, $3)', [
        orgA,
        storeB,
        'Invasora',
      ]),
    ).rejects.toThrow();
  });

  it('player nao pode pertencer a loja de uma organizacao e zona de outra', async () => {
    const { db, orgA, storeA, orgB, storeB } = await seeded();
    const zoneB = (
      await db.query<{ id: string }>(
        'insert into audio_zones (organization_id, store_id, name) values ($1, $2, $3) returning id',
        [orgB, storeB, 'Caixa'],
      )
    ).rows[0]!.id;

    await expect(
      db.query(
        'insert into player_devices (organization_id, store_id, zone_id, name, token_hash) values ($1,$2,$3,$4,$5)',
        [orgA, storeA, zoneB, 'Player cruzado', 'hash'],
      ),
    ).rejects.toThrow();
  });

  it('slug de loja e unico dentro da organizacao, mas livre entre organizacoes', async () => {
    const { db, orgA, orgB } = await seeded();
    await expect(
      db.query('insert into stores (organization_id, name, slug, timezone) values ($1,$2,$3,$4)', [
        orgA,
        'Outra',
        'centro',
        'America/Sao_Paulo',
      ]),
    ).rejects.toThrow();
    // Mesmo slug em outra organizacao e perfeitamente valido.
    await expect(
      db.query('insert into stores (organization_id, name, slug, timezone) values ($1,$2,$3,$4)', [
        orgB,
        'Boreal Centro',
        'centro',
        'America/Sao_Paulo',
      ]),
    ).resolves.toBeDefined();
  });

  it('media nao vira "ready" sem duracao, checksum e chave de storage', async () => {
    const { db, orgA } = await seeded();
    await expect(
      db.query(
        "insert into media_assets (organization_id, kind, title, original_filename, status) values ($1,'music','X','x.mp3','ready')",
        [orgA],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into media_assets (organization_id, kind, title, original_filename, status,
           storage_key, duration_ms, checksum_sha256) values ($1,'music','X','x.mp3','ready','k/1',1000,'abc')`,
        [orgA],
      ),
    ).resolves.toBeDefined();
  });

  it('campanha com fim antes do inicio e recusada', async () => {
    const { db, orgA } = await seeded();
    await expect(
      db.query('insert into campaigns (organization_id, name, starts_at, ends_at) values ($1,$2,$3,$4)', [
        orgA,
        'Invertida',
        '2026-05-10T00:00:00Z',
        '2026-05-01T00:00:00Z',
      ]),
    ).rejects.toThrow();
  });

  it('item de playlist exige exatamente uma origem', async () => {
    const { db, orgA } = await seeded();
    const playlistId = (
      await db.query<{ id: string }>(
        'insert into playlists (organization_id, name) values ($1,$2) returning id',
        [orgA, 'Ambiente'],
      )
    ).rows[0]!.id;

    // Nem arquivo nem anuncio.
    await expect(
      db.query('insert into playlist_items (organization_id, playlist_id, item_type) values ($1,$2,$3)', [
        orgA,
        playlistId,
        'music',
      ]),
    ).rejects.toThrow();
  });

  it('codigo de pareamento ativo e unico, mas pode repetir depois de usado', async () => {
    const { db, orgA, storeA, zoneA } = await seeded();
    const insert = (hash: string, used: boolean) =>
      db.query(
        `insert into device_pairing_codes (organization_id, store_id, zone_id, code_hash, device_name, expires_at, used_at)
         values ($1,$2,$3,$4,'Player',$5,$6)`,
        [orgA, storeA, zoneA, hash, '2030-01-01T00:00:00Z', used ? new Date().toISOString() : null],
      );

    await insert('hash-1', false);
    await expect(insert('hash-1', false)).rejects.toThrow(); // colide enquanto vivo

    await db.query("update device_pairing_codes set used_at = now() where code_hash = 'hash-1'");
    await expect(insert('hash-1', false)).resolves.toBeDefined(); // liberado apos uso
  });

  it('o mesmo evento de reproducao reenviado nao conta duas vezes', async () => {
    const { db, orgA, storeA, zoneA } = await seeded();
    const deviceId = (
      await db.query<{ id: string }>(
        `insert into player_devices (organization_id, store_id, zone_id, name, token_hash, status, paired_at)
         values ($1,$2,$3,'Player 1','h','active',now()) returning id`,
        [orgA, storeA, zoneA],
      )
    ).rows[0]!.id;

    const eventId = '11111111-2222-3333-4444-555555555555';
    const insertEvent = () =>
      db.query(
        `insert into playback_events (event_id, organization_id, store_id, zone_id, device_id, slot_id,
           item_type, event_type, occurred_at_device, local_date)
         values ($1,$2,$3,$4,$5,'slot-1','music','completed', now(), current_date)`,
        [eventId, orgA, storeA, zoneA, deviceId],
      );

    await insertEvent();
    // Reenvio apos reconexao: a PK e o event_id do player, entao o banco recusa.
    await expect(insertEvent()).rejects.toThrow();

    const { rows } = await db.query<{ n: string }>('select count(*)::text as n from playback_events');
    expect(rows[0]!.n).toBe('1');
  });

  it('webhook de pagamento deduplica por (provider, event_id)', async () => {
    const db = await freshDb();
    await migrate(db);
    const insert = () =>
      db.query(
        "insert into payment_webhook_events (provider, event_id, event_type, signature_valid) values ('acme','evt_1','sub.updated',true)",
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('uma organizacao tem no maximo uma assinatura viva', async () => {
    const { db, orgA } = await seeded();
    const planId = (
      await db.query<{ id: string }>(
        `insert into plans (code, name, price_cents, quotas) values ('pro','Pro',29900,'{}'::jsonb) returning id`,
      )
    ).rows[0]!.id;
    const insertSub = (status: string) =>
      db.query(
        'insert into subscriptions (organization_id, plan_id, status, current_period_end) values ($1,$2,$3,$4)',
        [orgA, planId, status, '2030-01-01T00:00:00Z'],
      );

    await insertSub('active');
    await expect(insertSub('trialing')).rejects.toThrow();
    // Uma cancelada nao disputa o indice parcial: historico fica preservado.
    await expect(insertSub('cancelled')).resolves.toBeDefined();
  });

  it('apagar a organizacao leva junto todo o conteudo dela', async () => {
    const { db, orgA, orgB } = await seeded();
    await db.query('delete from organizations where id = $1', [orgA]);
    const left = await db.query<{ n: string }>('select count(*)::text as n from stores');
    expect(left.rows[0]!.n).toBe('1'); // sobra apenas a loja da org B
    const orgs = await db.query<{ id: string }>('select id from organizations');
    expect(orgs.rows.map((r) => r.id)).toEqual([orgB]);
  });
});
