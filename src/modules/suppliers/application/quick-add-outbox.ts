// QuickAddOutbox: registers the outbox route of the supplier quick add job (`supplier.quick_add`) and writes its rows (ids only). Loaded by the API (it writes) and by the worker (its relay only knows the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';

/** The outbox event type that starts a quick add run in the worker. */
export const QUICK_ADD_EVENT = 'supplier.quick_add';

/** The BullMQ job name of a quick add run on the `imports` queue. */
export const SUPPLIER_QUICK_ADD_JOB = 'supplier_quick_add';

/**
 * Writes the quick add event to the transactional outbox.
 *
 * Why: feature 26 (B214), decision 020: the API only inserts the run and its event in one commit; the worker's job adds the services in
 * chunks. The payload is the run's id and the supplier's id only.
 *
 * Side effects: registers the event type with the `imports` queue and the job name `supplier_quick_add` at boot; `requested` inserts one
 * `outbox_events` row on the caller's transaction.
 *
 * @see docs/queues.md (imports, outbox event types)
 */
@Injectable()
export class QuickAddOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers `supplier.quick_add`. */
  onModuleInit(): void {
    this.routes.register({ type: QUICK_ADD_EVENT, queue: 'imports', jobName: SUPPLIER_QUICK_ADD_JOB });
  }

  /**
   * Queues the run of a quick add.
   *
   * @param tx the start's transaction
   * @param runId the `supplier_import_runs` row
   * @param supplierId the supplier
   */
  async requested(tx: DbExecutor, runId: number, supplierId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: QUICK_ADD_EVENT,
      aggregateType: 'supplier_import_runs',
      aggregateId: runId,
      payload: { runId, supplierId },
    });
  }
}
