// QuickAddOutbox: registers the outbox route of the supplier quick add job (`supplier.quick_add`) and writes its rows (ids only), and writes
// the hand-over event of a run that asked to publish (`supplier.quick_add_done`, feature 31). Loaded by the API (it writes) and by the worker
// (its relay only knows the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';
import type { QuickAddRunRecord } from '../domain/quick-add';

/** The outbox event type that starts a quick add run in the worker. */
export const QUICK_ADD_EVENT = 'supplier.quick_add';

/** The BullMQ job name of a quick add run on the `imports` queue. */
export const SUPPLIER_QUICK_ADD_JOB = 'supplier_quick_add';

/**
 * The outbox event a quick add run writes when it ends having created services and asked to publish them.
 *
 * Why: plan 31 section 6.3: the storefront consumes it (`publish_from_quick_add`) and registers its route; the suppliers module only
 * writes rows of this type and never imports the storefront (fact 17). The storefront's `QUICK_ADD_DONE_EVENT` is the same text.
 */
export const QUICK_ADD_DONE_EVENT = 'supplier.quick_add_done';

/**
 * Writes the quick add event to the transactional outbox.
 *
 * Why: feature 26 (B214), decision 020: the API only inserts the run and its event in one commit; the worker's job adds the services in
 * chunks. The payload is the run's id and the supplier's id only.
 *
 * Side effects: registers the event type with the `imports` queue and the job name `supplier_quick_add` at boot; `requested` inserts one
 * `outbox_events` row on the caller's transaction, and so does `done` (its route is the storefront's).
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
   * @param options `reconcile`: the lost-work reconcile asks again for a run whose job was lost (decision 055)
   */
  async requested(
    tx: DbExecutor,
    runId: number,
    supplierId: number,
    options: { readonly reconcile?: boolean } = {},
  ): Promise<void> {
    await this.outbox.add(tx, {
      type: QUICK_ADD_EVENT,
      aggregateType: 'supplier_import_runs',
      aggregateId: runId,
      payload: { runId, supplierId, ...(options.reconcile === true ? { reconcile: true } : {}) },
    });
  }

  /**
   * Hands a closed run's services to the bulk publish.
   *
   * Why: plan 31 section 6.3: written by the transaction that closes the run (the runner's close, or the start that closes a stalled run),
   * after every chunk committed, so the consumer sees every service the run created. The payload is ids and the switch's target only.
   *
   * @param tx the closing transaction
   * @param run the run as it was closed (it asked to publish and created at least one service)
   */
  async done(
    tx: DbExecutor,
    run: Pick<QuickAddRunRecord, 'id' | 'supplierId' | 'requestedBy' | 'publishMode'>,
  ): Promise<void> {
    await this.outbox.add(tx, {
      type: QUICK_ADD_DONE_EVENT,
      aggregateType: 'supplier_import_runs',
      aggregateId: run.id,
      payload: {
        runId: run.id,
        supplierId: run.supplierId,
        requestedBy: run.requestedBy,
        listed: run.publishMode === 'listed',
      },
    });
  }
}
