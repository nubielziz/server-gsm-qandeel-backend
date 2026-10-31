// Unit tests of the queue registry (decision 020) and of docs/queues.md: every queue is documented, with the numbers the
// registry has, and nothing is documented that does not exist.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPLETED_JOB_MAX_AGE_SECONDS,
  COMPLETED_JOB_MAX_COUNT,
  FAILED_JOB_MAX_AGE_SECONDS,
  QUEUES,
  QUEUE_NAMES,
  defaultJobOptions,
  isQueueName,
} from './queue-definitions';

const docs = readFileSync(join(import.meta.dir, '../../../docs/queues.md'), 'utf8');

/** 5000 becomes "5 s", 600000 "10 min": the way docs/queues.md writes a backoff. */
function duration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1_000} s`;
}

/** The text of the `## <name>` section of the document, up to the next `## ` heading. */
function section(name: string): string | undefined {
  const start = docs.indexOf(`\n## ${name}\n`);
  if (start === -1) return undefined;
  const next = docs.indexOf('\n## ', start + 4);
  return docs.slice(start, next === -1 ? undefined : next);
}

describe('QUEUES', () => {
  it('has the ten queues of decision 020', () => {
    expect<string[]>([...QUEUE_NAMES].sort()).toEqual(
      [
        'alerts',
        'files',
        'imports',
        'maintenance',
        'merchant-webhooks',
        'notifications',
        'outbox-relay',
        'supplier-dispatch',
        'supplier-poll',
        'supplier-sync',
      ].sort(),
    );
  });

  it('uses names BullMQ accepts (no colon) and a sane concurrency and retry policy', () => {
    for (const name of QUEUE_NAMES) {
      const queue = QUEUES[name];
      expect(name, name).not.toContain(':');
      expect(queue.concurrency, name).toBeGreaterThanOrEqual(1);
      expect(queue.attempts, name).toBeGreaterThanOrEqual(1);
      expect(queue.maxStalledCount, name).toBeGreaterThanOrEqual(0);
      // A queue that retries needs a backoff, and a queue that does not retry needs none.
      expect(queue.attempts > 1, name).toBe('backoff' in queue);
    }
  });

  it('never re-runs a supplier dispatch on its own after a worker died (decision 025)', () => {
    expect(QUEUES['supplier-dispatch'].maxStalledCount).toBe(0);
  });

  it('knows which names are queues', () => {
    expect(isQueueName('maintenance')).toBe(true);
    expect(isQueueName('nope')).toBe(false);
    expect(isQueueName('toString')).toBe(false);
  });
});

describe('defaultJobOptions', () => {
  it('keeps completed jobs 24 hours (at most 10 000) and failed jobs 14 days', () => {
    expect(COMPLETED_JOB_MAX_AGE_SECONDS).toBe(24 * 3600);
    expect(COMPLETED_JOB_MAX_COUNT).toBe(10_000);
    expect(FAILED_JOB_MAX_AGE_SECONDS).toBe(14 * 24 * 3600);
    for (const name of QUEUE_NAMES) {
      const options = defaultJobOptions(name);
      expect(options.removeOnComplete, name).toEqual({ age: 86_400, count: 10_000 });
      expect(options.removeOnFail, name).toEqual({ age: 1_209_600 });
    }
  });

  it('retries with exponential backoff and jitter, as the registry says', () => {
    expect(defaultJobOptions('supplier-dispatch')).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
    });
    expect(defaultJobOptions('merchant-webhooks')).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 600_000, jitter: 0.2 },
    });
    expect(defaultJobOptions('outbox-relay')).toMatchObject({ attempts: 1 });
    expect(defaultJobOptions('outbox-relay').backoff).toBeUndefined();
  });
});

describe('docs/queues.md', () => {
  it('has a section for every queue, and a section for no queue that does not exist', () => {
    // Queue names are lower case; the other headings ("Rules for every queue", "Schedulers", ...) start with a capital.
    const documented = [...docs.matchAll(/^## ([a-z][a-z-]*)$/gm)].map((match) => match[1]);
    expect(documented.sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it('answers the five questions in every section: jobs, payload, idempotency key, retry policy, schedule', () => {
    for (const name of QUEUE_NAMES) {
      const text = section(name);
      expect(text, `docs/queues.md has no section for ${name}`).toBeDefined();
      for (const label of ['Concurrency', 'Jobs', 'Payload', 'Idempotency', 'Retry policy', 'Schedule']) {
        expect(text, `${name}: missing "- **${label}:**"`).toContain(`- **${label}:**`);
      }
    }
  });

  it('writes the concurrency, attempts and backoff of the registry in each section', () => {
    for (const name of QUEUE_NAMES) {
      const queue: { concurrency: number; attempts: number; backoff?: { delayMs: number; jitter: number } } =
        QUEUES[name];
      const text = section(name) ?? '';
      expect(text, `${name}: concurrency`).toContain(`- **Concurrency:** ${queue.concurrency} per worker process`);
      const retry = /- \*\*Retry policy:\*\* ([^\n]*)/.exec(text)?.[1] ?? '';
      if (queue.backoff) {
        expect(retry, `${name}: retry policy`).toContain(
          `${queue.attempts} attempts, exponential backoff from ${duration(queue.backoff.delayMs)} (jitter ${Math.round(queue.backoff.jitter * 100)} %)`,
        );
      } else {
        expect(retry, `${name}: retry policy`).toContain('1 attempt, no retry');
      }
    }
  });

  it('lists every queue in the overview table with its numbers', () => {
    for (const name of QUEUE_NAMES) {
      const queue: {
        concurrency: number;
        attempts: number;
        maxStalledCount: number;
        backoff?: { delayMs: number; jitter: number };
      } = QUEUES[name];
      const backoff = queue.backoff
        ? `${duration(queue.backoff.delayMs)}, jitter ${Math.round(queue.backoff.jitter * 100)} %`
        : 'none';
      const row = `| \`${name}\` | ${queue.concurrency} | ${queue.attempts} | ${backoff} | ${queue.maxStalledCount} |`;
      expect(docs, `overview row for ${name}`).toContain(row);
    }
  });

  it('says that job ids use a hyphen, because BullMQ refuses a colon', () => {
    expect(docs).toContain('BullMQ refuses');
    expect(docs).toContain('`outbox-<event id>`');
  });
});
