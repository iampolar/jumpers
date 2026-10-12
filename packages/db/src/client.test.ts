import { afterEach, describe, expect, it } from 'vitest';
import { createSqlClient, pingDatabase, type SqlClient } from './client.js';
import { migrate } from './migrator.js';
import { seed } from './seed.js';

let open: SqlClient[] = [];

async function db(): Promise<SqlClient> {
  const client = await createSqlClient({ url: 'memory://' });
  open.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(open.map((c) => c.close().catch(() => undefined)));
  open = [];
});

describe('contrato do cliente SQL', () => {
  it('rejeita DATABASE_URL desconhecida com mensagem acionavel', async () => {
    await expect(createSqlClient({ url: 'mysql://localhost/x' })).rejects.toThrow(/memory:\/\//);
  });

  it('responde ao ping com latencia medida', async () => {
    const c = await db();
    const r = await pingDatabase(c);
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('rowCount', () => {
  /*
   * Regressao: o driver PGlite reportava rows.length tambem para
   * INSERT/UPDATE/DELETE, o que da zero quando nao ha RETURNING. O padrao
   * "update ... where id = $1 and organization_id = $2; rowCount === 0 -> 404"
   * passaria a negar operacoes legitimas de todo mundo.
   */
  it('conta linhas afetadas em INSERT, UPDATE e DELETE', async () => {
    const c = await db();
    await c.exec('create table t (id serial primary key, n int)');

    expect((await c.query('insert into t (n) values (1),(2),(3)')).rowCount).toBe(3);
    expect((await c.query('update t set n = n * 10 where n > 1')).rowCount).toBe(2);
    expect((await c.query('delete from t where n = 10')).rowCount).toBe(0);
    expect((await c.query('delete from t where n >= 20')).rowCount).toBe(2);
  });

  it('conta linhas retornadas em SELECT e em RETURNING', async () => {
    const c = await db();
    await c.exec('create table t (id serial primary key, n int)');
    expect((await c.query('insert into t (n) values (1),(2) returning id')).rowCount).toBe(2);
    expect((await c.query('select * from t')).rowCount).toBe(2);
    expect((await c.query('select * from t where n = 99')).rowCount).toBe(0);
  });

  it('vale igual dentro de transacao', async () => {
    const c = await db();
    await c.exec('create table t (id serial primary key, n int)');
    await c.transaction(async (tx) => {
      expect((await tx.query('insert into t (n) values (1),(2),(3),(4)')).rowCount).toBe(4);
      expect((await tx.query('update t set n = 0')).rowCount).toBe(4);
    });
  });
});

describe('transacoes', () => {
  it('faz commit do caminho feliz', async () => {
    const c = await db();
    await c.exec('create table t (n int)');
    await c.transaction(async (tx) => {
      await tx.query('insert into t (n) values (1)');
    });
    expect((await c.query('select * from t')).rowCount).toBe(1);
  });

  it('faz rollback quando o callback lanca', async () => {
    const c = await db();
    await c.exec('create table t (n int)');
    await expect(
      c.transaction(async (tx) => {
        await tx.query('insert into t (n) values (1)');
        throw new Error('falha de dominio no meio da operacao');
      }),
    ).rejects.toThrow('falha de dominio');
    // Nada parcial ficou gravado.
    expect((await c.query('select * from t')).rowCount).toBe(0);
  });

  it('faz rollback quando uma constraint e violada', async () => {
    const c = await db();
    await c.exec('create table t (n int primary key)');
    await c.query('insert into t (n) values (1)');
    await expect(
      c.transaction(async (tx) => {
        await tx.query('insert into t (n) values (2)');
        await tx.query('insert into t (n) values (1)'); // viola a PK
      }),
    ).rejects.toThrow();
    expect((await c.query('select * from t')).rowCount).toBe(1);
  });
});

describe('seed', () => {
  it('cria planos, organizacao demo, lojas em fusos diferentes e agendas', async () => {
    const c = await db();
    await migrate(c);
    const result = await seed(c);

    expect(result.plans).toBe(3);
    expect(result.stores).toBe(2);
    expect(result.zones).toBe(3);
    expect(result.schedules).toBe(2);

    const stores = await c.query<{ name: string; timezone: string }>(
      'select name, timezone from stores order by name',
    );
    expect(stores.rows.map((s) => s.timezone)).toEqual(['America/Sao_Paulo', 'America/Manaus']);
  });

  it('e idempotente: rodar duas vezes nao duplica nem apaga', async () => {
    const c = await db();
    await migrate(c);
    await seed(c);
    const second = await seed(c);

    expect(second.plans).toBe(0);
    expect(second.stores).toBe(0);
    expect(second.notes.join(' ')).toContain('ja existia');

    const counts = await c.query<{ orgs: string; stores: string; plans: string }>(
      `select (select count(*) from organizations)::text as orgs,
              (select count(*) from stores)::text        as stores,
              (select count(*) from plans)::text         as plans`,
    );
    expect(counts.rows[0]).toEqual({ orgs: '1', stores: '2', plans: '3' });
  });

  it('nao cria audio fantasma: a biblioteca nasce vazia', async () => {
    const c = await db();
    await migrate(c);
    await seed(c);
    // Playlist com faixa que nao existe no storage seria demo bonita e produto quebrado.
    expect((await c.query('select 1 from media_assets')).rowCount).toBe(0);
    expect((await c.query('select 1 from playlist_items')).rowCount).toBe(0);
  });

  it('a assinatura demo nasce sem gateway, em trial', async () => {
    const c = await db();
    await migrate(c);
    await seed(c);
    const sub = await c.query<{ status: string; provider: string }>(
      'select status, provider from subscriptions',
    );
    expect(sub.rows[0]).toEqual({ status: 'trialing', provider: 'disabled' });
  });

  it('a senha do owner e gravada como hash, nunca em claro', async () => {
    const c = await db();
    await migrate(c);
    const result = await seed(c);
    const user = await c.query<{ password_hash: string }>('select password_hash from users');
    expect(user.rows[0]!.password_hash).not.toContain(result.ownerPassword!);
    expect(user.rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('recusa rodar com NODE_ENV=production', async () => {
    const c = await db();
    await migrate(c);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seed(c)).rejects.toThrow(/NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('permite semear apenas o catalogo de planos', async () => {
    const c = await db();
    await migrate(c);
    const result = await seed(c, { withDemoOrganization: false });
    expect(result.plans).toBe(3);
    expect(result.organizationId).toBeNull();
    expect((await c.query('select 1 from organizations')).rowCount).toBe(0);
  });
});
