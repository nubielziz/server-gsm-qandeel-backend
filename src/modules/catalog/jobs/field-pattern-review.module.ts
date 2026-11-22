// Nest module of the pass that reviews the stored field patterns (catalog module, decision 051). Import it in the worker process only
// (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditService, OutboxRouteRegistry } from '../../platform';
import {
  FIELD_PATTERNS_REVIEW_EVENT,
  FIELD_PATTERNS_REVIEW_JOB,
  FieldPatternReview,
} from '../application/field-pattern-review';
import { CatalogModule } from '../catalog.module';
import { FieldPatternReviewProcessor } from './field-pattern-review.processor';

/**
 * Provides the pass and its processor, and routes the event migration 0048 writes to the `maintenance` queue.
 *
 * Why: only the migration writes this event and only the worker's relay reads it, so the route lives here and the API does not load it.
 *
 * Side effects: registers one outbox route at boot.
 *
 * @see docs/queues.md (maintenance, outbox event types)
 */
@Module({
  imports: [CatalogModule],
  // The worker has no global audit module: the module provides the writer itself, as every worker module does.
  providers: [AuditService, FieldPatternReview, FieldPatternReviewProcessor],
  exports: [FieldPatternReview],
})
export class FieldPatternReviewModule implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the route of the event. */
  onModuleInit(): void {
    this.routes.register({
      type: FIELD_PATTERNS_REVIEW_EVENT,
      queue: 'maintenance',
      jobName: FIELD_PATTERNS_REVIEW_JOB,
    });
  }
}
