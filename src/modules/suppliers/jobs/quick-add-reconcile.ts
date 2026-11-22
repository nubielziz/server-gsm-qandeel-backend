// QuickAddReconcilePass: the lost-work pass of Quick add runs whose job was lost (suppliers module, decision 055).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import {
  type LostWorkApplied,
  type LostWorkContext,
  type LostWorkItem,
  type LostWorkPass,
  type LostWorkPlan,
  LostWorkRegistry,
  applyLostWorkItems,
  lostWorkAction,
} from '../../platform';
import { QUICK_ADD_EVENT, QuickAddOutbox } from '../application/quick-add-outbox';
import { lockQueuedRun, queuedRuns } from '../infra/quick-add.repository';

/** Runs one reconcile looks at. */
const QUICK_ADD_RECONCILE_BATCH = 100;
const AGGREGATE = 'supplier_import_runs';

/**
 * Asks again for the job of a queued Quick add run whose job was lost.
 *
 * Why: decision 055 and feature 26: a run waits in `queued` for its `supplier.quick_add` job; with no live request for 10 minutes the
 * event is written again (`reconcile: true`), at most three times. Then nothing is written: the run reads as stalled and staff start it
 * again (the start closes the old run, so its late job claims nothing). The hand-over to the bulk publish (`supplier.quick_add_done`) is
 * not reconciled: the Quick add progress offers to prepare the preview by hand.
 *
 * Side effects: `apply` inserts `supplier.quick_add` outbox rows under the run's lock.
 */
@Injectable()
export class QuickAddReconcilePass implements LostWorkPass, OnModuleInit {
  readonly kind = 'quick_add_runs';

  constructor(
    private readonly db: DbService,
    private readonly outbox: QuickAddOutbox,
    private readonly registry: LostWorkRegistry,
  ) {}

  /** Registers the pass with the platform's reconcile. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Finds the queued runs whose job was lost.
   *
   * @param context the run's time and the reader of outbox requests
   * @returns the runs to ask for again; writes nothing
   */
  async plan({ now, requests }: LostWorkContext): Promise<LostWorkPlan> {
    const db = this.db.db;
    const rows = await queuedRuns(db, QUICK_ADD_RECONCILE_BATCH);
    const items: LostWorkItem[] = [];
    let unknown = 0;
    let exhausted = 0;
    for (const run of rows) {
      const action = lostWorkAction({ ...(await requests.inspect(db, QUICK_ADD_EVENT, AGGREGATE, run.id)), now });
      if (action === 'unknown') unknown += 1;
      else if (action === 'give_up') exhausted += 1;
      else if (action === 'request') items.push({ action, id: run.id, data: { supplierId: run.supplierId } });
    }
    return { checked: rows.length, unknown, exhausted, items };
  }

  /**
   * Asks again for each planned run that is still queued under its lock.
   *
   * @param plan what {@link QuickAddReconcilePass.plan} found
   * @param context the run's time and the reader of outbox requests
   * @returns how many runs were asked for again
   * @throws {Error} after every item was tried, when one of them threw
   */
  apply(plan: LostWorkPlan, { requests }: LostWorkContext): Promise<LostWorkApplied> {
    return applyLostWorkItems(plan.items, async (item) => {
      const asked = await this.db.runInTransaction(async ({ tx }) => {
        const run = await lockQueuedRun(tx, item.id);
        if (!run) return false;
        // Under the run's lock: a parallel run (a manual one beside the schedule) that asked first left a live request.
        if ((await requests.inspect(tx, QUICK_ADD_EVENT, AGGREGATE, item.id)).state !== 'none') return false;
        await this.outbox.requested(tx, run.id, run.supplierId, { reconcile: true });
        return true;
      });
      return asked ? 'requested' : 'skipped';
    });
  }
}
