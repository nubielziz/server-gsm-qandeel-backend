// PublishReconcilePass: the lost-work pass of bulk publish runs whose preparation, apply or switch job was lost (storefront module,
// decision 055).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../../infra/db';
import {
  type LostWorkApplied,
  type LostWorkContext,
  type LostWorkItem,
  type LostWorkPass,
  type LostWorkPlan,
  LostWorkRegistry,
  applyLostWorkItems,
  lostWorkAction,
} from '../../../platform';
import type { ListingPublishRun } from '../../db/schema';
import {
  PUBLISH_APPLY_EVENT,
  PUBLISH_PREPARE_EVENT,
  PUBLISH_SET_LISTED_EVENT,
  PublishOutbox,
} from '../application/publish-outbox';
import { lockRun, runsAwaitingJobs } from '../infra/publish.repository';

/** Runs one reconcile looks at. */
const RUN_RECONCILE_BATCH = 100;
const AGGREGATE = 'listing_publish_runs';

/** The three waits of a run, each with its event. */
type RunStep = 'prepare' | 'apply' | 'switch';
const STEP_EVENTS: Readonly<Record<RunStep, string>> = {
  prepare: PUBLISH_PREPARE_EVENT,
  apply: PUBLISH_APPLY_EVENT,
  switch: PUBLISH_SET_LISTED_EVENT,
};

/** Whether a run (as read, or as locked) still waits for the job of a step. */
function waitsFor(run: ListingPublishRun, step: RunStep): boolean {
  switch (step) {
    case 'prepare':
      return run.status === 'preparing' && run.prepareClaimedAt === null;
    case 'apply':
      return run.status === 'queued';
    case 'switch':
      return run.switchStatus === 'queued';
  }
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/**
 * Asks again for the job of a publish run that waits for one whose job was lost.
 *
 * Why: decision 055 and plan 31 section 6: a run waits for a job in three places: a preparation nobody claimed, a queued apply and a
 * queued run switch. Each wait is judged by itself; with no live request for 10 minutes the same event is written again (`reconcile:
 * true`), at most three times. Then nothing is written: the run already reads as stalled after five minutes without a heartbeat, and
 * staff resume it. The switch's request repeats the target stored on the run and the staff member of the last request. Every job claims
 * with a guarded update, so a request that arrives after staff moved the run on claims nothing.
 *
 * Side effects: `apply` inserts `storefront.publish_*` outbox rows under the run's lock.
 */
@Injectable()
export class PublishReconcilePass implements LostWorkPass, OnModuleInit {
  readonly kind = 'publish_runs';

  constructor(
    private readonly db: DbService,
    private readonly outbox: PublishOutbox,
    private readonly registry: LostWorkRegistry,
  ) {}

  /** Registers the pass with the platform's reconcile. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Finds the waits whose job was lost.
   *
   * @param context the run's time and the reader of outbox requests
   * @returns one item per wait to ask for again; writes nothing
   */
  async plan({ now, requests }: LostWorkContext): Promise<LostWorkPlan> {
    const db = this.db.db;
    const rows = await runsAwaitingJobs(db, RUN_RECONCILE_BATCH);
    const items: LostWorkItem[] = [];
    let unknown = 0;
    let exhausted = 0;
    for (const run of rows) {
      for (const step of ['prepare', 'apply', 'switch'] as const) {
        if (!waitsFor(run, step)) continue;
        const info = await requests.inspect(db, STEP_EVENTS[step], AGGREGATE, run.id);
        const action = lostWorkAction({ ...info, now });
        if (action === 'unknown') unknown += 1;
        else if (action === 'give_up') exhausted += 1;
        else if (action === 'request') {
          const requestedBy =
            step === 'switch' && isId(info.newestPayload?.requestedBy) ? info.newestPayload.requestedBy : null;
          items.push({ action, id: run.id, data: { step, requestedBy } });
        }
      }
    }
    return { checked: rows.length, unknown, exhausted, items };
  }

  /**
   * Asks again for each planned wait that is still the same under the run's lock.
   *
   * @param plan what {@link PublishReconcilePass.plan} found
   * @param context the run's time and the reader of outbox requests
   * @returns how many waits were asked for again
   * @throws {Error} after every item was tried, when one of them threw
   */
  apply(plan: LostWorkPlan, { requests }: LostWorkContext): Promise<LostWorkApplied> {
    return applyLostWorkItems(plan.items, async (item) => {
      const step = item.data?.step;
      if (step !== 'prepare' && step !== 'apply' && step !== 'switch') return 'skipped';
      const requestedBy = isId(item.data?.requestedBy) ? item.data.requestedBy : null;
      const asked = await this.db.runInTransaction(async ({ tx }) => {
        const locked = await lockRun(tx, item.id);
        if (!locked || !waitsFor(locked, step)) return false;
        // Under the run's lock: a parallel run (a manual one beside the schedule) that asked first left a live request.
        if ((await requests.inspect(tx, STEP_EVENTS[step], AGGREGATE, item.id)).state !== 'none') return false;
        if (step === 'prepare') await this.outbox.prepareRequested(tx, item.id, { reconcile: true });
        else if (step === 'apply') await this.outbox.applyRequested(tx, item.id, { reconcile: true });
        else
          await this.outbox.switchRequested(tx, item.id, locked.switchListed === true, requestedBy, {
            reconcile: true,
          });
        return true;
      });
      return asked ? 'requested' : 'skipped';
    });
  }
}
