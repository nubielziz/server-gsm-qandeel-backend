// The processor of the `search-index` queue (feature 29, plan section 4.5): `search_sync` (catalog, listing and reconcile changes).
// Worker only. Decision 068 retired `search_settings` with the console's search settings.
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../../infra/queues';
import type { OutboxJobData } from '../../../platform';
import { SEARCH_JOBS } from '../application/search-signals';
import { SearchSync, type SyncInput, type SyncResult } from '../application/search-sync';

/** The data of a `search_sync` job: an outbox event, or the reconcile's `{ serviceIds }`. */
export type SyncJobData = OutboxJobData | { readonly serviceIds: readonly number[] };

const isIdList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && (id as number) > 0);

/**
 * Reads what a sync job is about.
 *
 * @param data the job data
 * @returns the services or the category
 * @throws {UnrecoverableError} for data that names neither (a programming error: never retried)
 */
export function syncInputOf(data: SyncJobData): SyncInput {
  const payload: Record<string, unknown> = 'payload' in data ? { ...data.payload } : { serviceIds: data.serviceIds };
  if (isIdList(payload.serviceIds)) return { serviceIds: payload.serviceIds };
  if (Number.isSafeInteger(payload.categoryId) && (payload.categoryId as number) > 0) {
    return { categoryId: payload.categoryId as number };
  }
  throw new UnrecoverableError('A search_sync job needs serviceIds or a categoryId.');
}

/**
 * Runs `search_sync`.
 *
 * Why: decision 038: the only writer of documents through the services alias; the queue's concurrency of 1 keeps two writes from racing
 * on one document. Not recorded in `job_runs` (event-driven: `search_index_state` and the metrics are the record).
 */
@Injectable()
@QueueProcessor('search-index', SEARCH_JOBS.sync)
export class SearchSyncProcessor implements JobProcessor<SyncJobData, SyncResult> {
  constructor(private readonly sync: SearchSync) {}

  /**
   * Handles one sync job.
   *
   * @param job the BullMQ job (its `timestamp` is when the change was handed to the queue)
   * @returns what was written
   */
  process(job: Job<SyncJobData, SyncResult, string>): Promise<SyncResult> {
    return this.sync.run(syncInputOf(job.data), job.timestamp);
  }
}
