import type { JobQueue } from '@castwave/contracts';
import type { SqlClient } from '@castwave/db';

/**
 * Runner de filas sobre PostgreSQL.
 *
 * `for update skip locked` e o que torna isso correto com varios workers: cada
 * um pega uma linha diferente sem bloquear os outros e sem entregar o mesmo
 * job duas vezes. O lease (`lock_expires_at`) devolve a fila o job de um
 * worker que morreu no meio -- sem isso, um `kill -9` deixaria trabalho preso
 * em `running` para sempre.
 *
 * Backoff exponencial com teto e limite de tentativas; esgotado o limite o job
 * vai para `dead`, visivel no painel Jumpers para reprocessamento auditado.
 */

export interface JobRow {
  readonly id: string;
  readonly queue: JobQueue;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly organization_id: string | null;
}

export interface JobHandlerContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly db: SqlClient;
  readonly signal: AbortSignal;
  readonly log: (message: string, data?: Record<string, unknown>) => void;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobHandlerContext) => Promise<void>;

export interface RunnerOptions {
  readonly db: SqlClient;
  readonly handlers: Partial<Record<JobQueue, JobHandler>>;
  readonly workerId: string;
  /** Quanto tempo o worker detem o job antes de o lease expirar. */
  readonly leaseSeconds?: number;
  readonly pollIntervalMs?: number;
  readonly jobTimeoutMs?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

/** Backoff exponencial: 5s, 10s, 20s, 40s... com teto de 10 minutos. */
export function backoffSeconds(attempt: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempt - 1), 600);
}

export class JobRunner {
  private running = false;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly jobTimeoutMs: number;
  private readonly log: NonNullable<RunnerOptions['log']>;

  constructor(private readonly options: RunnerOptions) {
    this.leaseSeconds = options.leaseSeconds ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 60_000;
    this.log = options.log ?? (() => undefined);
  }

  /** Devolve a fila os jobs cujo lease venceu (worker morto). */
  async reclaimStuckJobs(): Promise<number> {
    const { rowCount } = await this.options.db.query(
      `update jobs
          set status = 'pending', locked_at = null, locked_by = null, lock_expires_at = null,
              last_error = coalesce(last_error, 'lease expirado: worker encerrou sem finalizar')
        where status = 'running' and lock_expires_at < now()`,
    );
    if (rowCount > 0) this.log('warn', 'jobs recuperados de lease expirado', { count: rowCount });
    return rowCount;
  }

  private async claimNext(queues: readonly JobQueue[]): Promise<JobRow | null> {
    const { rows } = await this.options.db.query<JobRow>(
      `update jobs
          set status = 'running',
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = $1,
              lock_expires_at = now() + make_interval(secs => $2),
              started_at = now()
        where id = (
          select id from jobs
           where status = 'pending' and run_at <= now() and queue = any($3::text[])
           order by run_at
           for update skip locked
           limit 1
        )
    returning id, queue, payload, attempts, max_attempts, organization_id`,
      [this.options.workerId, this.leaseSeconds, [...queues]],
    );
    return rows[0] ?? null;
  }

  private async finish(job: JobRow, error: Error | null): Promise<void> {
    const db = this.options.db;

    if (!error) {
      await db.query(
        `update jobs set status = 'completed', finished_at = now(),
                duration_ms = extract(milliseconds from (now() - started_at))::int,
                locked_at = null, locked_by = null, lock_expires_at = null, last_error = null
          where id = $1`,
        [job.id],
      );
      return;
    }

    const exhausted = job.attempts >= job.max_attempts;
    // Mensagem truncada: um stack inteiro na coluna polui o painel e pode
    // carregar trecho de payload sensivel.
    const message = error.message.slice(0, 500);

    if (exhausted) {
      await db.query(
        `update jobs set status = 'dead', finished_at = now(), last_error = $2,
                locked_at = null, locked_by = null, lock_expires_at = null
          where id = $1`,
        [job.id, message],
      );
      this.log('error', 'job esgotou as tentativas', {
        jobId: job.id,
        queue: job.queue,
        attempts: job.attempts,
      });
      return;
    }

    await db.query(
      `update jobs set status = 'pending', last_error = $2,
              run_at = now() + make_interval(secs => $3),
              locked_at = null, locked_by = null, lock_expires_at = null
        where id = $1`,
      [job.id, message, backoffSeconds(job.attempts)],
    );
    this.log('warn', 'job falhou, reagendado', {
      jobId: job.id,
      queue: job.queue,
      attempt: job.attempts,
      retryInSeconds: backoffSeconds(job.attempts),
    });
  }

  /** Processa um job, se houver. Devolve `true` quando processou algo. */
  async tick(): Promise<boolean> {
    const queues = Object.keys(this.options.handlers) as JobQueue[];
    if (queues.length === 0) return false;

    const job = await this.claimNext(queues);
    if (!job) return false;

    const handler = this.options.handlers[job.queue];
    if (!handler) {
      await this.finish(job, new Error(`Nenhum handler registrado para a fila ${job.queue}.`));
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.jobTimeoutMs);
    const startedAt = Date.now();

    try {
      await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempts,
        db: this.options.db,
        signal: controller.signal,
        log: (message, data) => this.log('info', message, { jobId: job.id, ...data }),
      });
      await this.finish(job, null);
      this.log('info', 'job concluido', {
        jobId: job.id,
        queue: job.queue,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      await this.finish(job, error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** Laco principal. Drena a fila e so dorme quando nao ha trabalho. */
  async start(): Promise<void> {
    this.running = true;
    await this.reclaimStuckJobs();
    this.log('info', 'worker iniciado', {
      workerId: this.options.workerId,
      queues: Object.keys(this.options.handlers),
    });

    let sinceReclaim = 0;
    while (this.running) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (error) {
        this.log('error', 'falha no laco do worker', { message: (error as Error).message });
      }

      if (!worked) {
        sinceReclaim += 1;
        // A cada ~30 ciclos ociosos, procura jobs orfaos.
        if (sinceReclaim >= 30) {
          sinceReclaim = 0;
          await this.reclaimStuckJobs().catch(() => 0);
        }
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

/** Enfileira um job. `idempotencyKey` evita trabalho duplicado. */
export async function enqueue(
  db: SqlClient,
  queue: JobQueue,
  payload: Record<string, unknown>,
  options: { idempotencyKey?: string; runAt?: Date; maxAttempts?: number; organizationId?: string | null } = {},
): Promise<{ jobId: string | null; deduplicated: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `insert into jobs (queue, payload, idempotency_key, run_at, max_attempts, organization_id)
     values ($1, $2::jsonb, $3, coalesce($4, now()), $5, $6)
     on conflict (queue, idempotency_key) where idempotency_key is not null and status in ('pending','running')
     do nothing
     returning id`,
    [
      queue,
      JSON.stringify(payload),
      options.idempotencyKey ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? 5,
      options.organizationId ?? null,
    ],
  );
  const row = rows[0];
  return { jobId: row?.id ?? null, deduplicated: !row };
}
