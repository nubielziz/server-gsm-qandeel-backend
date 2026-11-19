// PublishSwitch: the undo of a publish run (feature 31, plan 31 section 6.7): the worker takes every listing the run published off the
// shop, or puts it back, one service per transaction. It touches the switch of each listing and nothing else.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { RetailPrices } from '../../../catalog';
import { AuditService } from '../../../platform';
import { switchListing, switchRefusal } from '../../application/listing-writes';
import { lockOf } from '../../domain/listing-rules';
import { findServiceFacts } from '../../infra/foreign-reads.repository';
import { lockListingOfService } from '../../infra/listing.repository';
import { SearchSignals } from '../../search/application/search-signals';
import { MAX_ITEM_FAILURES, PUBLISH_CHUNK, TOO_MANY_FAILURES_ERROR } from '../domain/publish-item';
import {
  type SwitchSkipReason,
  SwitchTally,
  publishRunLabel,
  retryingConflictOnce,
  runErrorText,
} from '../domain/publish-run';
import {
  type PublishedItem,
  type RunWorker,
  type SwitchClosing,
  beatSwitch,
  claimSwitch,
  closeSwitch,
  holdSwitch,
  publishedItems,
} from '../infra/publish.repository';

/** How a call of {@link PublishSwitch.run} ended. */
export type PublishSwitchOutcome = 'not_queued' | 'stopped' | 'done' | 'failed';

/** The seam of the tests: what to do between two chunks (product code passes nothing). */
export interface PublishSwitchHooks {
  /**
   * Called after each chunk, once its heartbeat is written: a test claims a newer switch here (plan 31 section 8.3).
   *
   * @param chunk the worker, and how many rows the chunk held
   */
  readonly afterChunk?: (chunk: RunWorker & { readonly rows: number }) => Promise<void> | void;
}

/** A switch at work: the worker, the target, who pressed the button, and what it has done. */
interface SwitchJob {
  readonly worker: RunWorker;
  readonly listed: boolean;
  readonly requestedBy: number | null;
  readonly tally: SwitchTally;
}

/** What one row came to: changed, already at the target, left as it is for a reason, or the worker lost the run. */
type SwitchStep = 'switched' | 'unchanged' | 'stopped' | { readonly skipped: SwitchSkipReason };

const skipped = (reason: SwitchSkipReason): SwitchStep => ({ skipped: reason });

const errorText = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

/**
 * Switches everything a publish run published off the shop, or back on.
 *
 * Why: plan 31 sections 3.1 and 6.7: a mistaken run of a few hundred services must be undone with one button. No listing is deleted, no
 * title or price changes and a following price keeps following. Each listing is judged again under the service lock with the listing
 * route's own rule (`switchRefusal`): switching off never refuses; switching on leaves out a service that is disabled, closed to the
 * shop or has no retail price any more (never "on with no price"). A listing already at the target is left alone, so a second press or
 * a second delivery changes nothing. The claim raises the run's `attempt`, so a newer switch stops this one before its next row.
 *
 * Side effects: `listing_publish_runs` (the claim, the heartbeat with the two counters, the close); per listing that changed
 * `service_listings.is_listed` and, on a first switch-on, `listed_at`, one `audit_logs` row by `system` and one
 * `storefront.listing_changed` event; one `audit_logs` row by `system` at the close. No cache key.
 *
 * @see docs/briefs/31-bulk-publish.md (section 6.7)
 * @see docs/queues.md (imports)
 */
@Injectable()
export class PublishSwitch {
  private readonly logger = new Logger(PublishSwitch.name);

  constructor(
    private readonly db: DbService,
    private readonly retail: RetailPrices,
    private readonly audit: AuditService,
    private readonly signals: SearchSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs a queued switch to its end.
   *
   * Idempotent: only a `queued` switch of this target is claimed, and a listing at the target is not touched.
   *
   * @param runId the `listing_publish_runs` row
   * @param listed the target: on the shop, or off it
   * @param requestedBy the staff member who pressed the button (the audit rows carry it; the worker acts as `system`)
   * @param hooks the seam of the tests; product code passes nothing
   * @returns `not_queued` when no such switch was queued; `stopped` when a newer claim took the run (nothing more was written); else how
   *   it closed
   * @throws {Error} what an unexpected error outside the rows threw, after the switch was closed `failed`
   */
  async run(
    runId: number,
    listed: boolean,
    requestedBy: number | null,
    hooks: PublishSwitchHooks = {},
  ): Promise<PublishSwitchOutcome> {
    const claimed = await claimSwitch(this.db.db, runId, listed, this.clock.now());
    if (claimed === undefined) return 'not_queued';
    const job: SwitchJob = {
      worker: { runId, attempt: claimed.attempt },
      listed,
      requestedBy,
      tally: new SwitchTally(),
    };
    try {
      return await this.work(job, hooks);
    } catch (error) {
      this.logger.error(`The switch of publish run ${runId} failed: ${errorText(error)}`);
      // A failing close must not hide the error that brought us here; the switch then reads as stalled.
      await this.close(job, 'failed', runErrorText(error)).catch((closeError: unknown) => {
        this.logger.error(`The switch of publish run ${runId} could not be closed: ${errorText(closeError)}`);
      });
      throw error;
    }
  }

  /** The chunks over the rows the run published, then the close (plan 31 section 6.7, steps 2 and 3). */
  private async work(job: SwitchJob, hooks: PublishSwitchHooks): Promise<PublishSwitchOutcome> {
    const { worker, tally } = job;
    let afterId = 0;
    for (;;) {
      const chunk = await publishedItems(this.db.db, worker.runId, afterId, PUBLISH_CHUNK);
      if (chunk.length === 0) return this.close(job, 'done', null);
      for (const item of chunk) {
        afterId = item.id;
        const step = await this.switchItem(job, item);
        if (step === 'stopped') return 'stopped';
        if (step === 'switched') tally.switched += 1;
        else if (step === 'unchanged') tally.unchanged += 1;
        else {
          const count = tally.skip(step.skipped);
          if (step.skipped === 'failed' && count >= MAX_ITEM_FAILURES) {
            return this.close(job, 'failed', TOO_MANY_FAILURES_ERROR);
          }
        }
      }
      const counts = { switched: tally.switched, skipped: tally.skipped() };
      if (!(await beatSwitch(this.db.db, worker, counts, this.clock.now()))) return 'stopped';
      await hooks.afterChunk?.({ ...worker, rows: chunk.length });
    }
  }

  /** One listing: its transaction, once more after a deadlock or a serialization failure; any other error skips it as `failed`. */
  private async switchItem(job: SwitchJob, item: PublishedItem): Promise<SwitchStep> {
    try {
      return await retryingConflictOnce(() => this.switchRow(job, item));
    } catch (error) {
      this.logger.error(
        `The switch of publish run ${job.worker.runId}: service ${item.serviceId} failed: ${errorText(error)}`,
      );
      return skipped('failed');
    }
  }

  /**
   * The transaction of one listing. Lock order of plan 31 section 6.5: the service, the run (`FOR SHARE`: a worker that lost the run
   * stops here and writes nothing), the listing. Every refusal is decided before the first write.
   */
  private switchRow(job: SwitchJob, item: PublishedItem): Promise<SwitchStep> {
    const { worker, listed, requestedBy } = job;
    return this.db.runInTransaction(async ({ tx }) => {
      const service = await this.retail.lockLiveService(tx, item.serviceId);
      if (!(await holdSwitch(tx, worker))) return 'stopped';
      if (service === undefined) return skipped('service_gone');
      const listing = await lockListingOfService(tx, service.id);
      if (listing === undefined || listing.id !== item.listingId) return skipped('listing_gone');
      if (listing.isListed === listed) return 'unchanged';

      const facts = await findServiceFacts(tx, service.id);
      if (facts === undefined) return skipped('service_gone');
      const switchFacts = {
        serviceStatus: service.status,
        lock: lockOf({
          serviceStatus: service.status,
          categoryName: facts.categoryName,
          categoryAllowedGroupIds: facts.allowedGroupIds,
          retailGroupId: facts.retailGroupId ?? undefined,
        }),
      };
      const refusal = switchRefusal(switchFacts, listed);
      if (refusal === 'service_disabled') return skipped('service_disabled');
      if (refusal === 'locked') return skipped('b2b_only');
      if (listed) {
        // Never "on with no price" from this feature (plan 31 section 3.1): a listing on without a price is invisible, with no error.
        const quote = (await this.retail.quotes(tx, [service.id])).get(service.id);
        if (quote?.retailPrice == null) return skipped('no_price');
      }

      const updated = await switchListing(tx, listing.id, listed, this.clock.now(), switchFacts);
      await this.audit.record(tx, {
        action: updated.isListed ? 'listed on storefront' : 'unlisted from storefront',
        entityType: 'listing',
        entityId: listing.id,
        entityLabel: service.name,
        before: { isListed: listing.isListed },
        after: { isListed: updated.isListed, runId: worker.runId, requestedBy },
      });
      await this.signals.listingsChanged(tx, [service.id]);
      return 'switched';
    });
  }

  /**
   * Closes the switch, with the audit row of the whole switch.
   *
   * @returns how the switch closed, or `stopped` when it is no longer this worker's (nothing is written)
   */
  private close(job: SwitchJob, status: SwitchClosing['status'], error: string | null): Promise<PublishSwitchOutcome> {
    const { worker, listed, requestedBy, tally } = job;
    return this.db.runInTransaction(async ({ tx }) => {
      const run = await closeSwitch(tx, worker, {
        status,
        error,
        switched: tally.switched,
        skipped: tally.skipped(),
        now: this.clock.now(),
      });
      if (run === undefined) return 'stopped';
      await this.audit.record(tx, {
        action: 'switched publishing run',
        entityType: 'publish_run',
        entityId: run.id,
        entityLabel: publishRunLabel(run.id),
        after: {
          listed,
          switched: tally.switched,
          unchanged: tally.unchanged,
          skipped: tally.skippedByReason(),
          requestedBy,
          ...(error === null ? {} : { error }),
        },
      });
      return status;
    });
  }
}
