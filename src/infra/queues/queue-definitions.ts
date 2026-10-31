// The BullMQ queue registry (decision 020): the ten queues, each with its concurrency, retry policy and stall rule.
// Add a queue here and in docs/queues.md; src/infra/queues/queue-definitions.spec.ts fails when the two disagree.
import type { JobsOptions } from 'bullmq';

/**
 * How one queue runs and retries its jobs.
 *
 * Why: decision 020 gives every queue its own concurrency and retry policy, so a slow supplier cannot starve
 * notifications and a webhook that keeps failing is retried for about a day.
 */
export interface QueueDefinition {
  /** What the queue is for, in one line (docs/queues.md repeats it). */
  readonly purpose: string;
  /** How many jobs one worker process runs at the same time. */
  readonly concurrency: number;
  /** Tries per job, the first one included (1 means no retry). */
  readonly attempts: number;
  /**
   * Exponential backoff between tries: the first retry waits `delayMs`, then twice as long, and so on. `jitter` (0 to 1)
   * shaves up to that share off each wait so retries of many jobs do not arrive together. Omit when `attempts` is 1.
   */
  readonly backoff?: { readonly delayMs: number; readonly jitter: number };
  /**
   * How many times a job whose worker vanished (crash, kill) may be given back to the queue before it fails. 0 means a
   * job that was running when its worker died is never run again on its own.
   */
  readonly maxStalledCount: number;
}

/** Completed jobs are kept 24 hours (or the newest 10 000): enough to look at yesterday, bounded for the noeviction Redis. */
export const COMPLETED_JOB_MAX_AGE_SECONDS = 24 * 60 * 60;
/** See {@link COMPLETED_JOB_MAX_AGE_SECONDS}. */
export const COMPLETED_JOB_MAX_COUNT = 10_000;
/** Failed jobs are kept 14 days so that staff can look at them and retry them from the console. */
export const FAILED_JOB_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

/**
 * Every queue, by name.
 *
 * Why: decision 020 names the ten queues. The numbers are the starting point for one worker process; the feature that
 * owns a queue tunes them (and its section of docs/queues.md) when it knows the real load. `supplier-dispatch` has
 * `maxStalledCount: 0` because a dispatch that was running when its worker died may already have reached the supplier,
 * so it is never re-sent automatically (decision 025, scenario `timeout`).
 *
 * @see docs/queues.md and docs/decisions/020-outbox-and-queues.md
 */
export const QUEUES = {
  'outbox-relay': {
    purpose: 'Ticks that move pending outbox rows to the queues of their event types.',
    concurrency: 1,
    attempts: 1,
    maxStalledCount: 1,
  },
  'supplier-dispatch': {
    purpose: 'Sends accepted orders to their supplier.',
    concurrency: 10,
    attempts: 3,
    backoff: { delayMs: 5_000, jitter: 0.5 },
    maxStalledCount: 0,
  },
  'supplier-poll': {
    purpose: 'Asks suppliers for the status of orders they accepted.',
    concurrency: 20,
    attempts: 3,
    backoff: { delayMs: 10_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
  'merchant-webhooks': {
    purpose: 'Delivers signed events to the webhook endpoints of merchants.',
    concurrency: 20,
    attempts: 8,
    backoff: { delayMs: 10 * 60_000, jitter: 0.2 },
    maxStalledCount: 1,
  },
  notifications: {
    purpose: 'Sends emails and Telegram messages.',
    concurrency: 10,
    attempts: 5,
    backoff: { delayMs: 30_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
  'supplier-sync': {
    purpose: 'Refreshes supplier services, prices and balances.',
    concurrency: 2,
    attempts: 3,
    backoff: { delayMs: 60_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
  imports: {
    purpose: 'Runs bulk imports (service lists, inventory codes) started by staff.',
    concurrency: 2,
    attempts: 1,
    maxStalledCount: 0,
  },
  files: {
    purpose: 'Processes uploaded and generated files (exports, result files).',
    concurrency: 4,
    attempts: 3,
    backoff: { delayMs: 10_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
  maintenance: {
    purpose: 'Scheduled housekeeping: group promotion, data retention, integrity checks, FX refresh.',
    concurrency: 2,
    attempts: 3,
    backoff: { delayMs: 60_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
  alerts: {
    purpose: 'Evaluates alert rules and sends their messages.',
    concurrency: 2,
    attempts: 3,
    backoff: { delayMs: 10_000, jitter: 0.5 },
    maxStalledCount: 1,
  },
} as const satisfies Record<string, QueueDefinition>;

/**
 * The name of one queue of {@link QUEUES}.
 *
 * Why: a typo in a queue name must fail the type check, not enqueue into a queue nobody works.
 */
export type QueueName = keyof typeof QUEUES;

/** Every queue name, in the order of {@link QUEUES}. */
export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];

/**
 * Tells whether text is the name of a queue.
 *
 * Why: names that arrive as data (a route parameter such as `/admin/system/queues/:name/failed`, a stored event route)
 * must be checked before they index {@link QUEUES}.
 *
 * @param value the text to check
 * @returns true when `value` is a queue name
 */
export function isQueueName(value: string): value is QueueName {
  return Object.hasOwn(QUEUES, value);
}

/**
 * The job options every job of a queue starts from.
 *
 * Why: decision 020: attempts with exponential backoff and jitter for transient errors, completed jobs kept 24 hours
 * (at most 10 000) and failed jobs 14 days. A job that must not follow them overrides them in its own `add` call.
 *
 * @param name the queue
 * @returns BullMQ default job options for the queue
 */
export function defaultJobOptions(name: QueueName): JobsOptions {
  const definition: QueueDefinition = QUEUES[name];
  return {
    attempts: definition.attempts,
    ...(definition.backoff
      ? {
          backoff: {
            type: 'exponential',
            delay: definition.backoff.delayMs,
            jitter: definition.backoff.jitter,
          },
        }
      : {}),
    removeOnComplete: { age: COMPLETED_JOB_MAX_AGE_SECONDS, count: COMPLETED_JOB_MAX_COUNT },
    removeOnFail: { age: FAILED_JOB_MAX_AGE_SECONDS },
  };
}
