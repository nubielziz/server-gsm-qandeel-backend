// The registry of repeating jobs (decision 020). Modules register their schedules in onModuleInit; the worker upserts them
// all on every boot (QueueWorkers), which is idempotent: the same id and settings change nothing.
import { Injectable } from '@nestjs/common';
import type { JobSchedulerTemplateOptions } from 'bullmq';
import { type QueueName, isQueueName } from './queue-definitions';

/**
 * One repeating job.
 *
 * Why: scheduled work (the nightly integrity check, price sync, group promotion, the outbox relay tick) is declared next
 * to the code that owns it and created in Redis by the worker at boot, so a fresh Redis or a new deploy needs no manual
 * step.
 */
export interface JobSchedulerSpec {
  /** Unique within its queue; it is the BullMQ scheduler id, so renaming it creates a second scheduler. */
  readonly id: string;
  readonly queue: QueueName;
  /** The name of the jobs it creates; a `@QueueProcessor(queue, jobName)` handles them. */
  readonly jobName: string;
  /** Repeat every this many milliseconds. Exactly one of `every` and `pattern`. */
  readonly every?: number;
  /** Repeat on a cron pattern (five fields). Exactly one of `every` and `pattern`. */
  readonly pattern?: string;
  /** Time zone of `pattern`; UTC when omitted. */
  readonly tz?: string;
  /** Job data: ids only. */
  readonly data?: Record<string, unknown>;
  /** Job options on top of the queue's defaults (for example a short `removeOnComplete` for a job that runs every second). */
  readonly jobOptions?: JobSchedulerTemplateOptions;
  /** What the schedule is for, in one line (docs/queues.md repeats it). */
  readonly description: string;
}

/**
 * Collects the repeating jobs of the application.
 *
 * Why: modules declare schedules, the worker creates them; the API process may load the same modules and registers the
 * same entries, but never creates anything in Redis.
 */
@Injectable()
export class JobSchedulerRegistry {
  private readonly specs = new Map<string, JobSchedulerSpec>();
  private readonly retiredIds = new Map<string, { queue: QueueName; id: string }>();

  /**
   * Adds a schedule.
   *
   * @param spec the schedule
   * @throws {Error} when the id is already registered for the queue, when neither or both of `every` and `pattern` are
   *   given, or when `every` is not a positive whole number of milliseconds
   */
  register(spec: JobSchedulerSpec): void {
    if (!isQueueName(spec.queue))
      throw new Error(`Scheduler "${spec.id}" names an unknown queue "${String(spec.queue)}".`);
    if ((spec.every === undefined) === (spec.pattern === undefined)) {
      throw new Error(`Scheduler "${spec.id}" needs exactly one of "every" and "pattern".`);
    }
    if (spec.every !== undefined && (!Number.isInteger(spec.every) || spec.every <= 0)) {
      throw new Error(`Scheduler "${spec.id}": "every" must be a positive whole number of milliseconds.`);
    }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(spec.id)) {
      throw new Error(`Scheduler id "${spec.id}" must be lower case letters, digits, "_" or "-" (at most 64).`);
    }
    const key = `${spec.queue}/${spec.id}`;
    if (this.specs.has(key)) throw new Error(`Scheduler "${spec.id}" is already registered for queue "${spec.queue}".`);
    if (this.retiredIds.has(key)) throw new Error(`Scheduler "${spec.id}" is registered and retired at the same time.`);
    this.specs.set(key, spec);
  }

  /**
   * Marks a scheduler id that no longer exists, so the worker removes it from Redis at boot.
   *
   * Why: upserting never deletes. When a schedule is renamed or dropped, the old scheduler would keep creating jobs that
   * nobody processes; listing its id here removes it on the next worker start. Keep the line until every environment has
   * booted a worker once.
   *
   * @param queue the queue the old scheduler belonged to
   * @param id its scheduler id
   * @throws {Error} when the same id is also registered as a live schedule
   */
  retire(queue: QueueName, id: string): void {
    const key = `${queue}/${id}`;
    if (this.specs.has(key)) throw new Error(`Scheduler "${id}" is registered and retired at the same time.`);
    this.retiredIds.set(key, { queue, id });
  }

  /**
   * Lists the registered schedules.
   *
   * @returns the schedules in registration order
   */
  list(): readonly JobSchedulerSpec[] {
    return [...this.specs.values()];
  }

  /**
   * Lists the schedulers to remove.
   *
   * @returns queue and id pairs
   */
  retired(): ReadonlyArray<{ readonly queue: QueueName; readonly id: string }> {
    return [...this.retiredIds.values()];
  }
}
