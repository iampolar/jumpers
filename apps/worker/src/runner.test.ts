import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueue } from '@castwave/contracts';
import { createSqlClient, migrate, type SqlClient } from '@castwave/db';
import { backoffSeconds, enqueue, JobRunner, type JobHandler } from './runner';
import { buildHandlers } from './handlers';

let db: SqlClient;

beforeEach(async () => {
  db = await createSqlClient({ url: 'memory://' });
  await migrate(db);
});

afterEach(async () => {
  await db.close();
});

type Handlers = Partial<Record<JobQueue, JobHandler>>;

const runnerWith = (handlers: Handlers): JobRunner =>
  new JobRunner({ db, workerId: 'worker-teste', handlers });

const statusOf = async (jobId: string) =>
  (
    await db.query<{ status: string; attempts: number; last_error: string | null }>(
      'select status, attempts, last_error from jobs where id = $1',
      [jobId],
    )
  ).rows[0]!;

describe('enfileiramento', () => {
  it('cria o job e o devolve pendente', async () => {
    const { jobId, deduplicated } = await enqueue(db, 'analytics-rollup', { organizationId: null });
    expect(jobId).toBeTruthy();
    expect(deduplicated).toBe(false);
    expect((await statusOf(jobId!)).status).toBe('pending');
  });

  it('deduplica pela chave de idempotencia enquanto o job esta vivo', async () => {
    const first = await enqueue(db, 'analytics-rollup', {}, { idempotencyKey: 'dia-2026-05-01' });
    const second = await enqueue(db, 'analytics-rollup', {}, { idempotencyKey: 'dia-2026-05-01' });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBeNull();
    expect((await db.query('select 1 from jobs')).rowCount).toBe(1);
  });

  it('permite reenfileirar a mesma chave depois que o job terminou', async () => {
    const first = await enqueue(db, 'analytics-rollup', {}, { idempotencyKey: 'k' });
    await db.query("update jobs set status = 'completed' where id = $1", [first.jobId]);
    const second = await enqueue(db, 'analytics-rollup', {}, { idempotencyKey: 'k' });
    expect(second.deduplicated).toBe(false);
  });

  it('respeita runAt agendado para o futuro', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await enqueue(db, 'analytics-rollup', {}, { runAt: future });
    let ran = false;
    const runner = runnerWith({ 'analytics-rollup': () => { ran = true; return Promise.resolve(); } });
    expect(await runner.tick()).toBe(false);
    expect(ran).toBe(false);
  });
});

describe('execucao', () => {
  it('processa o job e o marca como concluido com duracao', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', { organizationId: null });
    const runner = runnerWith({ 'analytics-rollup': () => Promise.resolve() });

    expect(await runner.tick()).toBe(true);
    const job = await statusOf(jobId!);
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(1);

    const { rows } = await db.query<{ duration_ms: number | null }>(
      'select duration_ms from jobs where id = $1',
      [jobId],
    );
    expect(rows[0]!.duration_ms).not.toBeNull();
  });

  it('entrega o payload ao handler', async () => {
    await enqueue(db, 'notification-delivery', { notificationId: 'abc', organizationId: 'org' });
    let seen: Record<string, unknown> | null = null;
    const runner = runnerWith({
      'notification-delivery': (payload) => {
        seen = payload;
        return Promise.resolve();
      },
    });
    await runner.tick();
    expect(seen).toMatchObject({ notificationId: 'abc' });
  });

  it('devolve false quando nao ha trabalho', async () => {
    const runner = runnerWith({ 'analytics-rollup': () => Promise.resolve() });
    expect(await runner.tick()).toBe(false);
  });

  it('nao pega job de fila sem handler registrado', async () => {
    await enqueue(db, 'media-process', { mediaAssetId: 'm', organizationId: 'o' });
    const runner = runnerWith({ 'analytics-rollup': () => Promise.resolve() });
    expect(await runner.tick()).toBe(false);
  });
});

describe('falha e retentativa', () => {
  const failing: JobHandler = () => {
    throw new Error('provedor externo recusou a chamada');
  };

  it('reagenda com backoff em vez de perder o job', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', {}, { maxAttempts: 3 });
    const runner = runnerWith({ 'analytics-rollup': failing });

    await runner.tick();
    const job = await statusOf(jobId!);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain('provedor externo');

    const { rows } = await db.query<{ future: boolean }>(
      'select run_at > now() as future from jobs where id = $1',
      [jobId],
    );
    expect(rows[0]!.future).toBe(true);
  });

  it('vai para "dead" ao esgotar as tentativas, sem sumir', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', {}, { maxAttempts: 2 });
    const runner = runnerWith({ 'analytics-rollup': failing });

    await runner.tick();
    await db.query("update jobs set run_at = now() where id = $1", [jobId]);
    await runner.tick();

    const job = await statusOf(jobId!);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(2);
    // Continua visivel no painel de operacao para reprocessamento auditado.
    expect(job.last_error).toBeTruthy();
  });

  it('o backoff cresce e tem teto', () => {
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(10);
    expect(backoffSeconds(3)).toBe(20);
    expect(backoffSeconds(99)).toBe(600);
  });

  it('nao armazena mensagem de erro gigante', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', {});
    const runner = runnerWith({
      'analytics-rollup': () => {
        throw new Error('x'.repeat(5000));
      },
    });
    await runner.tick();
    expect((await statusOf(jobId!)).last_error!.length).toBeLessThanOrEqual(500);
  });
});

describe('lease e recuperacao', () => {
  it('devolve a fila o job de um worker que morreu', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', {});
    // Simula worker que travou: job em running com lease ja vencido.
    await db.query(
      `update jobs set status = 'running', locked_by = 'worker-morto',
              locked_at = now() - interval '10 minutes',
              lock_expires_at = now() - interval '5 minutes'
        where id = $1`,
      [jobId],
    );

    const runner = runnerWith({ 'analytics-rollup': () => Promise.resolve() });
    expect(await runner.reclaimStuckJobs()).toBe(1);
    expect((await statusOf(jobId!)).status).toBe('pending');
    expect((await statusOf(jobId!)).last_error).toContain('lease expirado');
  });

  it('nao rouba job cujo lease ainda esta valido', async () => {
    const { jobId } = await enqueue(db, 'analytics-rollup', {});
    await db.query(
      `update jobs set status = 'running', lock_expires_at = now() + interval '2 minutes' where id = $1`,
      [jobId],
    );
    const runner = runnerWith({ 'analytics-rollup': () => Promise.resolve() });
    expect(await runner.reclaimStuckJobs()).toBe(0);
    expect((await statusOf(jobId!)).status).toBe('running');
  });

  it('dois workers nao processam o mesmo job', async () => {
    await enqueue(db, 'analytics-rollup', {});
    const processed: string[] = [];
    const handler: JobHandler = (_p, ctx) => {
      processed.push(ctx.jobId);
      return Promise.resolve();
    };
    const a = new JobRunner({ db, workerId: 'a', handlers: { 'analytics-rollup': handler } });
    const b = new JobRunner({ db, workerId: 'b', handlers: { 'analytics-rollup': handler } });

    await a.tick();
    await b.tick(); // nao ha mais nada pendente
    expect(processed).toHaveLength(1);
  });
});

describe('handlers de producao', () => {
  const handlers = buildHandlers({ deviceOfflineAfterSeconds: 180 });

  it('filas ainda nao implementadas falham explicitamente, nao em silencio', async () => {
    // Um job que "passa" sem fazer nada esconde o buraco no painel.
    for (const queue of ['media-process', 'announcement-ai', 'billing-events'] as const) {
      const { jobId } = await enqueue(db, queue, {}, { maxAttempts: 1 });
      const runner = runnerWith({ [queue]: handlers[queue]! });
      await runner.tick();
      const job = await statusOf(jobId!);
      expect(job.status, queue).toBe('dead');
      expect(job.last_error, queue).toMatch(/ainda nao implementado/);
    }
  });

  it('encerra campanha vencida e expira anuncio fora da vigencia', async () => {
    const orgId = (
      await db.query<{ id: string }>(
        "insert into organizations (name, slug, timezone) values ('X','x','UTC') returning id",
      )
    ).rows[0]!.id;

    const campaignId = (
      await db.query<{ id: string }>(
        `insert into campaigns (organization_id, name, status, starts_at, ends_at)
         values ($1,'Vencida','running', now() - interval '10 days', now() - interval '1 day') returning id`,
        [orgId],
      )
    ).rows[0]!.id;

    const announcementId = (
      await db.query<{ id: string }>(
        `insert into announcements (organization_id, title, status, valid_until)
         values ($1,'Oferta antiga','active', now() - interval '1 hour') returning id`,
        [orgId],
      )
    ).rows[0]!.id;

    await enqueue(db, 'schedule-publish', { organizationId: null });
    const runner = runnerWith({ 'schedule-publish': handlers['schedule-publish']! });
    await runner.tick();

    const campaign = await db.query<{ status: string }>('select status from campaigns where id = $1', [campaignId]);
    const announcement = await db.query<{ status: string }>('select status from announcements where id = $1', [
      announcementId,
    ]);
    expect(campaign.rows[0]!.status).toBe('finished');
    expect(announcement.rows[0]!.status).toBe('expired');
  });

  it('marca como offline o player sem heartbeat na janela', async () => {
    const orgId = (
      await db.query<{ id: string }>(
        "insert into organizations (name, slug, timezone) values ('Y','y','UTC') returning id",
      )
    ).rows[0]!.id;
    const storeId = (
      await db.query<{ id: string }>(
        "insert into stores (organization_id, name, slug, timezone) values ($1,'L','l','UTC') returning id",
        [orgId],
      )
    ).rows[0]!.id;
    const zoneId = (
      await db.query<{ id: string }>(
        "insert into audio_zones (organization_id, store_id, name) values ($1,$2,'Z') returning id",
        [orgId, storeId],
      )
    ).rows[0]!.id;

    const mk = async (name: string, secondsAgo: number): Promise<string> =>
      (
        await db.query<{ id: string }>(
          `insert into player_devices (organization_id, store_id, zone_id, name, token_hash, status, last_seen_at, paired_at)
           values ($1,$2,$3,$4,$5,'active', now() - make_interval(secs => $6), now()) returning id`,
          [orgId, storeId, zoneId, name, `hash-${name}`, secondsAgo],
        )
      ).rows[0]!.id;

    const recente = await mk('recente', 30);
    const sumido = await mk('sumido', 600);

    await enqueue(db, 'schedule-publish', {});
    await runnerWith({ 'schedule-publish': handlers['schedule-publish']! }).tick();

    const states = await db.query<{ id: string; status: string }>('select id, status from player_devices');
    const byId = Object.fromEntries(states.rows.map((r) => [r.id, r.status]));
    expect(byId[recente]).toBe('active');
    // Estado vem do relogio do servidor, nao do navegador avisar que caiu.
    expect(byId[sumido]).toBe('offline');
  });
});
