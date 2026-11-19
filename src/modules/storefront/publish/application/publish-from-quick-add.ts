// PublishFromQuickAdd: the storefront's side of the Quick add hand-over (feature 31, decision 040, plan 31 section 6.3): makes the one
// automatic publish run of a Quick add run that asked to publish, and prepares it in the same job.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { NAMING_RULES_VERSION } from '../domain/naming';
import { insertQuickAddRun } from '../infra/publish.repository';
import { type PublishPrepareOutcome, PublishPreparer } from './publish-preparer';

/** What a Quick add run hands over: the run, the staff member who started it and whether the services go on the shop switched on. */
export interface QuickAddHandOver {
  /** The `supplier_import_runs` row that ended. */
  readonly quickAddRunId: number;
  /** The staff member who started the Quick add (they held `storefront:publish`), or `null`. */
  readonly requestedBy: number | null;
  /** Whether the publish switches the listings on. */
  readonly listed: boolean;
}

/** How a call of {@link PublishFromQuickAdd.run} ended: `exists` when the Quick add run already had its publish run. */
export type PublishFromQuickAddOutcome = PublishPrepareOutcome | 'exists';

/**
 * Makes and prepares the publish run of a finished Quick add run.
 *
 * Why: plan 31 section 6.3, the owner's "one step from Quick add": the services a Quick add created are named, priced and, for the ready
 * rows, published without another click. The run is `auto` (its apply starts when the preview closes with a row ticked) and `source =
 * quick_add`; the hard flags keep every doubtful name out until a person ticks it, and the run switch takes the whole run off the shop. The
 * staff member who started the Quick add held `storefront:publish` (checked at the start); the worker acts as `system` and records them as
 * `requested_by`.
 *
 * Side effects: inserts one `listing_publish_runs` row, then everything {@link PublishPreparer.run} writes (its rows, and for a run with a
 * row ticked the apply event and the start audit row by `system`). Nothing is written when the Quick add run already has its publish run.
 *
 * @see docs/briefs/31-bulk-publish.md (section 6.3)
 * @see docs/queues.md (imports)
 */
@Injectable()
export class PublishFromQuickAdd {
  constructor(
    private readonly db: DbService,
    private readonly preparer: PublishPreparer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Makes the publish run of a Quick add run and prepares it.
   *
   * Idempotent: `listing_publish_runs_source_run_uq` allows one publish run per Quick add run, so a second delivery of the job inserts
   * nothing and does nothing more; the first delivery's preparer claims its run once.
   *
   * @param handOver the Quick add run and what it asked for
   * @returns `exists` when the Quick add run already had its run; else how the preparation ended (`draft` when no row is ticked, `queued`
   *   when the automatic apply was asked for)
   * @throws {Error} what the preparer threw after it closed the run `failed`; a database error of the insert
   */
  async run(handOver: QuickAddHandOver): Promise<PublishFromQuickAddOutcome> {
    const created = await insertQuickAddRun(this.db.db, {
      status: 'preparing',
      source: 'quick_add',
      sourceRunId: handOver.quickAddRunId,
      scope: { kind: 'quickAddRun', runId: handOver.quickAddRunId },
      listed: handOver.listed,
      auto: true,
      rulesVersion: NAMING_RULES_VERSION,
      requestedBy: handOver.requestedBy,
      heartbeatAt: this.clock.now(),
    });
    if (created === undefined) return 'exists';
    return this.preparer.run(created.id);
  }
}
