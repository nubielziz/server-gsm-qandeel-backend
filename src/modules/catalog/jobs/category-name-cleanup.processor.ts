// The worker job that cleans the names of the existing categories (catalog module, queue maintenance, job category_names_clean; feature 31).
import { Injectable } from '@nestjs/common';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import {
  CATEGORY_NAMES_CLEAN_JOB,
  CategoryNameCleanup,
  type CategoryNameCleanupResult,
} from '../application/category-name-cleanup';

/**
 * Runs the pass migration 0046 asks for.
 *
 * Why: the final review of feature 31: the categories that exist must carry clean names before the shop goes live. The rename needs the
 * application's cleaning rules, its search signal and its audit row, none of which a SQL migration has, so the migration only writes the
 * outbox event and the worker does the work. The pass is idempotent: a second delivery or a retry finds the names clean. The job id is the
 * outbox row's (`outbox-<id>`). Not recorded in `job_runs` (it is not a schedule); 3 attempts with the queue's backoff.
 *
 * @see docs/queues.md (maintenance)
 */
@Injectable()
@QueueProcessor('maintenance', CATEGORY_NAMES_CLEAN_JOB)
export class CategoryNameCleanupProcessor implements JobProcessor<OutboxJobData, CategoryNameCleanupResult> {
  constructor(private readonly cleanup: CategoryNameCleanup) {}

  /**
   * Handles the job.
   *
   * @returns what the pass did
   */
  process(): Promise<CategoryNameCleanupResult> {
    return this.cleanup.run();
  }
}
