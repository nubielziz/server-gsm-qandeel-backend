// PublishOutboxRoutes: registers the outbox routes of the bulk publish (feature 31, plan 31 section 6): the prepare, the apply, the run
// switch and the Quick add hand-over go to the `imports` queue. Loaded by the API (the writers' OutboxService.add needs the routes) and by the worker (its relay only knows
// the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxRouteRegistry } from '../../../platform';
import {
  PUBLISH_APPLY_EVENT,
  PUBLISH_JOBS,
  PUBLISH_PREPARE_EVENT,
  PUBLISH_SET_LISTED_EVENT,
  QUICK_ADD_DONE_EVENT,
} from '../application/publish-outbox';

/**
 * Maps the events of a publish run to their jobs.
 *
 * Why: plan 31 section 6: the runs are staff-started bulk work, like a Quick add, so they share its queue: one attempt, no re-run of a
 * stalled job. Without these routes `OutboxService.add` refuses the events. The fourth is the Quick add hand-over: the suppliers module
 * writes `supplier.quick_add_done` and the storefront, which it never imports, owns its route (plan 31 section 6.3).
 *
 * Side effects: registers four routes at boot.
 *
 * @see docs/queues.md (imports, outbox event types)
 */
@Injectable()
export class PublishOutboxRoutes implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the routes. */
  onModuleInit(): void {
    this.routes.register({ type: PUBLISH_PREPARE_EVENT, queue: 'imports', jobName: PUBLISH_JOBS.prepare });
    this.routes.register({ type: PUBLISH_APPLY_EVENT, queue: 'imports', jobName: PUBLISH_JOBS.apply });
    this.routes.register({ type: PUBLISH_SET_LISTED_EVENT, queue: 'imports', jobName: PUBLISH_JOBS.setListed });
    this.routes.register({ type: QUICK_ADD_DONE_EVENT, queue: 'imports', jobName: PUBLISH_JOBS.fromQuickAdd });
  }
}
