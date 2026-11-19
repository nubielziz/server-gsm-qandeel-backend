// Nest module of the pass that cleans the existing categories' names (catalog module, feature 31). Import it in the worker process only
// (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditService, OutboxRouteRegistry } from '../../platform';
import {
  CATEGORY_NAMES_CLEAN_EVENT,
  CATEGORY_NAMES_CLEAN_JOB,
  CategoryNameCleanup,
} from '../application/category-name-cleanup';
import { CatalogModule } from '../catalog.module';
import { CatalogPricesModule } from '../catalog-prices.module';
import { CategoryNameCleanupProcessor } from './category-name-cleanup.processor';

/**
 * Provides the pass and its processor, and routes the event migration 0046 writes to the `maintenance` queue.
 *
 * Why: only the migration writes this event and only the worker's relay reads it, so the route lives here and the API does not load it.
 *
 * Side effects: registers one outbox route at boot.
 *
 * @see docs/queues.md (maintenance, outbox event types)
 */
@Module({
  imports: [CatalogModule, CatalogPricesModule],
  // The worker has no global audit module: the module provides the writer itself, as every worker module does.
  providers: [AuditService, CategoryNameCleanup, CategoryNameCleanupProcessor],
  exports: [CategoryNameCleanup],
})
export class CategoryNameCleanupModule implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the route of the event. */
  onModuleInit(): void {
    this.routes.register({
      type: CATEGORY_NAMES_CLEAN_EVENT,
      queue: 'maintenance',
      jobName: CATEGORY_NAMES_CLEAN_JOB,
    });
  }
}
