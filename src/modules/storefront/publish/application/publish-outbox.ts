// PublishOutbox: the outbox events that start a publish run's work in the worker (feature 31, plan 31 section 6): ids and one flag only,
// written in the transaction that moves the run.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { OutboxService } from '../../../platform';

/** The outbox event that starts the preparation of a new run's draft (`{ runId }`, aggregate `listing_publish_runs`). */
export const PUBLISH_PREPARE_EVENT = 'storefront.publish_prepare';

/** The outbox event that starts the apply of a queued run (`{ runId }`, aggregate `listing_publish_runs`). */
export const PUBLISH_APPLY_EVENT = 'storefront.publish_apply';

/** The outbox event that starts a queued run switch (`{ runId, listed, requestedBy }`, aggregate `listing_publish_runs`). */
export const PUBLISH_SET_LISTED_EVENT = 'storefront.publish_set_listed';

/**
 * The outbox event a Quick add run writes when it ends having created services and asked to publish them (`{ runId, supplierId,
 * requestedBy, listed }`, aggregate `supplier_import_runs`).
 *
 * Why: plan 31 section 6.3: the suppliers module writes it and never imports the storefront (fact 17), so this module registers its route
 * and consumes it. The suppliers module's `QUICK_ADD_DONE_EVENT` is the same text; the integration test of the hand-over pins it.
 */
export const QUICK_ADD_DONE_EVENT = 'supplier.quick_add_done';

/**
 * The job names of a publish run on the `imports` queue.
 *
 * Why: the processors, the outbox routes and `docs/queues.md` must agree on them.
 */
export const PUBLISH_JOBS = {
  prepare: 'publish_prepare',
  apply: 'publish_apply',
  setListed: 'publish_set_listed',
  fromQuickAdd: 'publish_from_quick_add',
} as const;

/** The aggregate of the events of a run. */
const RUN_AGGREGATE = 'listing_publish_runs';

/**
 * Writes the events of a publish run.
 *
 * Why: decision 020 and plan 31 section 6: the API only moves the run and writes the event in one commit; the worker does the slow work.
 * A payload carries ids only (fact 14): the worker re-reads everything else from the run. The lost-work reconcile writes the same
 * events again with `reconcile: true` when a job was lost (decision 055).
 *
 * Side effects: inserts `outbox_events` rows on the caller's transaction.
 *
 * @see docs/queues.md (imports, outbox event types)
 */
@Injectable()
export class PublishOutbox {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Asks for the preparation of a new run's draft.
   *
   * @param tx the transaction that inserted the run (`preparing`)
   * @param runId the run
   * @param options `reconcile`: the lost-work reconcile asks again (decision 055)
   */
  async prepareRequested(tx: DbExecutor, runId: number, options: { readonly reconcile?: boolean } = {}): Promise<void> {
    await this.outbox.add(tx, {
      type: PUBLISH_PREPARE_EVENT,
      aggregateType: RUN_AGGREGATE,
      aggregateId: runId,
      payload: { runId, ...(options.reconcile === true ? { reconcile: true } : {}) },
    });
  }

  /**
   * Asks for the apply of a queued run.
   *
   * @param tx the transaction that moved the run to `queued`
   * @param runId the run
   * @param options `reconcile`: the lost-work reconcile asks again (decision 055)
   */
  async applyRequested(tx: DbExecutor, runId: number, options: { readonly reconcile?: boolean } = {}): Promise<void> {
    await this.outbox.add(tx, {
      type: PUBLISH_APPLY_EVENT,
      aggregateType: RUN_AGGREGATE,
      aggregateId: runId,
      payload: { runId, ...(options.reconcile === true ? { reconcile: true } : {}) },
    });
  }

  /**
   * Asks for a queued run switch.
   *
   * @param tx the transaction that queued the switch
   * @param runId the run
   * @param listed the target: on the shop, or off it
   * @param requestedBy the staff member who pressed the button (the audit rows carry it; the worker acts as `system`)
   * @param options `reconcile`: the lost-work reconcile asks again (decision 055)
   */
  async switchRequested(
    tx: DbExecutor,
    runId: number,
    listed: boolean,
    requestedBy: number | null,
    options: { readonly reconcile?: boolean } = {},
  ): Promise<void> {
    await this.outbox.add(tx, {
      type: PUBLISH_SET_LISTED_EVENT,
      aggregateType: RUN_AGGREGATE,
      aggregateId: runId,
      payload: { runId, listed, requestedBy, ...(options.reconcile === true ? { reconcile: true } : {}) },
    });
  }
}
