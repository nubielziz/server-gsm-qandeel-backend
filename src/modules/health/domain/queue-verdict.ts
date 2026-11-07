// The server's verdict on a queue and on a scheduled job (docs/contract/endpoints/health.md, `GET /admin/system/queues` and
// `/jobs`). Pure.
import { type MetricState, worst } from './measure';
import { SPEC, stateOf } from './measure';

/** The numbers a queue's verdict is built from. */
export interface QueueFacts {
  /** Age of the oldest waiting job in seconds (0 when nothing waits). */
  readonly oldestAgeSeconds: number;
  readonly failed: number;
  readonly paused: boolean;
  readonly workers: number;
}

/** Failed jobs from which a queue is `warn`. */
export const FAILED_WARN = 10;
/** Failed jobs from which a queue is `crit`. */
export const FAILED_CRIT = 50;

/**
 * The state of one queue.
 *
 * Why: the worst of the oldest waiting job (warn 120 s, crit 600 s), the failed count (10 warn, 50 crit), a paused queue (warn)
 * and no worker at all (crit): a queue nobody works on cannot be calm.
 *
 * @param facts the queue's numbers
 * @returns the verdict
 */
export function queueState(facts: QueueFacts): MetricState {
  return worst([
    stateOf(SPEC.queueAge, facts.oldestAgeSeconds),
    facts.failed >= FAILED_CRIT ? 'crit' : facts.failed >= FAILED_WARN ? 'warn' : 'ok',
    facts.paused ? 'warn' : 'ok',
    facts.workers <= 0 ? 'crit' : 'ok',
  ]);
}

/**
 * The state of a scheduled job from the status of its last finished run.
 *
 * Why: failed is `crit`, skipped is `warn`, succeeded is `ok`, no run yet is `unknown`.
 *
 * @param lastStatus the last finished run's status, or `null` when the job never ran
 * @returns the verdict
 */
export function jobState(lastStatus: string | null): MetricState {
  if (lastStatus === 'failed') return 'crit';
  if (lastStatus === 'skipped') return 'warn';
  return lastStatus === 'succeeded' ? 'ok' : 'unknown';
}

/**
 * What a failed job was about, read from the ids its payload carries.
 *
 * Why: jobs carry ids only (decision 020), so the subject is `<kind> #<id>` built from the first `...Id` field (or the outbox
 * aggregate); the console shows it next to the failure. Anything else is `null`.
 *
 * @param data the job data
 * @returns for example `order #10422`, or `null`
 */
export function jobSubject(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const aggregateType = record.aggregateType;
  const aggregateId = record.aggregateId;
  if (typeof aggregateType === 'string' && (typeof aggregateId === 'number' || typeof aggregateId === 'string')) {
    return `${aggregateType} #${String(aggregateId)}`;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('Id') && key !== 'requestId' && (typeof value === 'number' || typeof value === 'string')) {
      const kind = key
        .slice(0, -2)
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim();
      return `${kind === '' ? 'record' : kind} #${String(value)}`;
    }
  }
  return null;
}
