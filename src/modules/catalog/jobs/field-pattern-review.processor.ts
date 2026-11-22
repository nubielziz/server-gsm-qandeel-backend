// The worker job that reviews the stored field patterns (catalog module, queue maintenance, job field_patterns_review; decision 051).
import { Injectable } from '@nestjs/common';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import {
  FIELD_PATTERNS_REVIEW_JOB,
  FieldPatternReview,
  type FieldPatternReviewResult,
} from '../application/field-pattern-review';

/**
 * Runs the pass migration 0048 asks for.
 *
 * Why: decision 051: the check of a pattern is application code a SQL migration does not have, so the migration only writes the outbox
 * event and the worker does the work. The pass is idempotent: a second delivery or a retry finds nothing left to clear. The job id is
 * the outbox row's (`outbox-<id>`). Not recorded in `job_runs` (it is not a schedule); 3 attempts with the queue's backoff.
 *
 * @see docs/queues.md (maintenance)
 */
@Injectable()
@QueueProcessor('maintenance', FIELD_PATTERNS_REVIEW_JOB)
export class FieldPatternReviewProcessor implements JobProcessor<OutboxJobData, FieldPatternReviewResult> {
  constructor(private readonly review: FieldPatternReview) {}

  /**
   * Handles the job.
   *
   * @returns what the pass did
   */
  process(): Promise<FieldPatternReviewResult> {
    return this.review.run();
  }
}
