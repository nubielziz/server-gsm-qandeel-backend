// Helpers for the queue, outbox and worker integration tests: a private BullMQ key prefix per test file, cleanup of the
// keys it left on the queue Redis, and a poll for a job state. Tests never FLUSHDB: other files share the database.
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { eventually } from './infra';

/**
 * A BullMQ prefix that only the calling test file uses, so files cannot see each other's jobs or schedulers.
 *
 * @returns `gsm:test:bull-<8 hex digits>`, valid for `BULL_PREFIX`
 */
export function testBullPrefix(): string {
  return `gsm:test:bull-${randomUUID().slice(0, 8)}`;
}

/**
 * Deletes every key that starts with a prefix on the queue Redis (SCAN, never KEYS). A test file that uses several
 * prefixes (`<prefix>-producers`, `<prefix>-workers`) deletes them all with the common start.
 *
 * @param redis a client of the queue Redis (the test database)
 * @param prefix the prefix a test used
 * @returns how many keys were deleted
 */
export async function deleteBullKeys(redis: Redis, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}

/**
 * Lists the keys under a prefix.
 *
 * @param redis a client of the queue Redis
 * @param prefix the prefix a test used
 * @returns the keys, sorted
 */
export async function bullKeys(redis: Redis, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found.sort();
}

/**
 * Waits until a job reaches a state.
 *
 * @param getJob reads the job by id (for example `() => queue.getJob(id)`)
 * @param state the state to wait for (`completed`, `failed`, `active`, ...)
 * @param timeoutMs how long to wait
 * @returns the job in that state
 */
export async function waitForState(
  getJob: () => Promise<Job | undefined>,
  state: 'completed' | 'failed' | 'active' | 'waiting' | 'delayed',
  timeoutMs = 8_000,
): Promise<Job> {
  return eventually(async () => {
    const job = await getJob();
    if (!job || (await job.getState()) !== state) return undefined;
    // The job read above may be older than its state: read it again so that its fields (return value, reason) are current.
    return (await getJob()) ?? job;
  }, timeoutMs);
}
