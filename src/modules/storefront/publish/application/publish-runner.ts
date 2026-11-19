// PublishRunner: the worker's side of a bulk publish (feature 31, decision 040, plan 31 section 6.2): claims a queued run, marks the rows
// left out, and publishes the rest one service per transaction, in chunks; every write requires the number the claim returned.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { Money } from '../../../../common/money';
import { DbService } from '../../../../infra/db';
import { CatalogPriceVersion } from '../../../catalog';
import { AuditService } from '../../../platform';
import { ListingPublisher, type PublishInput, type PublishOutcome } from '../../application/listing-publisher';
import type { ListingPublishItem } from '../../db/schema';
import { MAX_ITEM_FAILURES, PUBLISH_CHUNK, TOO_MANY_FAILURES_ERROR, failureReason } from '../domain/publish-item';
import { publishRunLabel, retryingConflictOnce, runErrorText } from '../domain/publish-run';
import {
  type ApplyClosing,
  type HeldRun,
  type ItemResult,
  type PendingItem,
  type RunWorker,
  beatApply,
  claimApply,
  closeApply,
  countItemResults,
  holdApply,
  lockApply,
  lockPendingItem,
  pendingItems,
  skipLeftOutItems,
  writeItemResult,
} from '../infra/publish.repository';

/** How a call of {@link PublishRunner.run} ended. */
export type PublishRunOutcome = 'not_queued' | 'stopped' | 'succeeded' | 'failed';

/** The seam of the tests: what to do between two chunks (product code passes nothing). */
export interface PublishRunHooks {
  /**
   * Called after each chunk, once its heartbeat is written: a test cancels or resumes the run here (plan 31 section 8.3).
   *
   * @param chunk the worker, and how many rows the chunk held
   */
  readonly afterChunk?: (chunk: RunWorker & { readonly rows: number }) => Promise<void> | void;
}

/** What one row came to: handled (whatever its result), failed unexpectedly, or the worker lost the run. */
type RowStep = 'done' | 'failed' | 'stopped';

const moneyOrNull = (value: string | null): Money | null => (value === null ? null : Money.of(value));

const errorText = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

/**
 * Builds what the publisher needs from a row and its run.
 *
 * Why: plan 31 section 6.2: the row holds what staff saw and chose; the publisher judges it again on the locked service.
 *
 * @param item the row, read under its lock
 * @param run what the worker read of the run under the run row lock
 * @returns the publisher's input
 */
export function publishInputOf(item: ListingPublishItem, run: HeldRun): PublishInput {
  return {
    serviceId: item.serviceId,
    runId: item.runId,
    requestedBy: run.requestedBy,
    listed: run.listed,
    title: item.title,
    slug: item.slug,
    slugSource: item.slugSource,
    brand: item.brand,
    carrier: item.carrier,
    country: item.country,
    price: {
      mode: item.priceMode,
      override: moneyOrNull(item.priceOverride),
      replacesPrice: moneyOrNull(item.replacesPrice),
      cost: Money.of(item.cost),
      rulePrice: moneyOrNull(item.rulePrice),
      existingPrice: moneyOrNull(item.existingPrice),
    },
  };
}

/** The row's result for an outcome of the publisher. */
function resultOf(outcome: PublishOutcome): ItemResult {
  return outcome.result === 'published'
    ? {
        result: 'published',
        reason: null,
        detail: outcome.detail,
        listingId: outcome.listingId,
        publishedPrice: outcome.price.toWire(),
      }
    : { result: outcome.result, reason: outcome.reason, detail: outcome.detail, listingId: null, publishedPrice: null };
}

/**
 * Publishes the rows of a queued run.
 *
 * Why: plan 31 section 6.2 (the model is Quick add, fact 9): the API only moves the run to `queued` and writes the event; this does the
 * work in the worker (queue `imports`, job `publish_apply`). A run keeps its id across a resume, so two workers could meet on it: the
 * claim counts (`attempt`), and every later write requires the number this worker got. A worker that lost the run writes nothing and
 * stops. Each row is its own transaction, in the lock order of section 6.5: the service, the run (`FOR SHARE`, so a cancel or a resume
 * waits for the row in flight), the item, then what `ListingPublisher` writes. A stop, a cancel and a crash each leave rows that a resume
 * finishes: a row has its whole result or none.
 *
 * Side effects: `listing_publish_runs` is claimed, beaten and closed; `listing_publish_items` get their results; per published row what
 * `ListingPublisher` writes (the listing, the retail price, one `storefront.listing_changed` event, one audit row); one `audit_logs` row
 * by `system` at the close; the catalog price version moves once, after the close, when something was published. No cache key of its own.
 *
 * @see docs/briefs/31-bulk-publish.md (sections 6.2 and 6.5)
 * @see docs/queues.md (imports)
 */
@Injectable()
export class PublishRunner {
  private readonly logger = new Logger(PublishRunner.name);

  constructor(
    private readonly db: DbService,
    private readonly publisher: ListingPublisher,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs a queued run to its end.
   *
   * Idempotent: only a `queued` run is claimed, so a second delivery, a second worker or a run that was cancelled does nothing.
   *
   * @param runId the `listing_publish_runs` row
   * @param hooks the seam of the tests; product code passes nothing
   * @returns `not_queued` when the run was not `queued`; `stopped` when it was cancelled or claimed again while this worker ran (nothing
   *   more was written); else how it closed. A run closed `failed` by too many failed rows returns `failed`
   * @throws {Error} what an unexpected error outside the rows threw, after the run was closed `failed` (the job shows in the failed list,
   *   and a repeat finds the run not `queued`)
   */
  async run(runId: number, hooks: PublishRunHooks = {}): Promise<PublishRunOutcome> {
    const claimed = await claimApply(this.db.db, runId, this.clock.now());
    if (claimed === undefined) return 'not_queued';
    const worker: RunWorker = { runId, attempt: claimed.attempt };
    try {
      return await this.work(worker, hooks);
    } catch (error) {
      this.logger.error(`Publish run ${runId} (attempt ${worker.attempt}) failed: ${errorText(error)}`);
      // A failing close must not hide the error that brought us here; the run then stays `running` and reads as stalled.
      await this.close(worker, 'failed', runErrorText(error)).catch((closeError: unknown) => {
        this.logger.error(`Publish run ${runId} could not be closed: ${errorText(closeError)}`);
      });
      throw error;
    }
  }

  /** The rows left out, then the chunks, then the close (plan 31 section 6.2, steps 2 to 5). */
  private async work(worker: RunWorker, hooks: PublishRunHooks): Promise<PublishRunOutcome> {
    if (!(await this.skipLeftOut(worker))) return 'stopped';
    let afterId = 0;
    let failures = 0;
    for (;;) {
      const chunk = await pendingItems(this.db.db, worker.runId, afterId, PUBLISH_CHUNK);
      if (chunk.length === 0) return this.close(worker, 'succeeded', null);
      for (const item of chunk) {
        afterId = item.id;
        const step = await this.publishItem(worker, item);
        if (step === 'stopped') return 'stopped';
        if (step === 'failed') {
          failures += 1;
          if (failures >= MAX_ITEM_FAILURES) return this.close(worker, 'failed', TOO_MANY_FAILURES_ERROR);
        }
      }
      if (!(await beatApply(this.db.db, worker, this.clock.now()))) return 'stopped';
      await hooks.afterChunk?.({ ...worker, rows: chunk.length });
    }
  }

  /**
   * Gives the rows nobody ticked their result.
   *
   * The run row is held `FOR SHARE` while the rows are written: the guard of plan 31 section 6.2 step 2 as a lock, so a cancel that
   * counts the rows waits for this and never finds them changing after it counted.
   *
   * @returns false when the run is no longer this worker's
   */
  private skipLeftOut(worker: RunWorker): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      if ((await holdApply(tx, worker)) === undefined) return false;
      await skipLeftOutItems(tx, worker.runId, this.clock.now());
      return true;
    });
  }

  /** One row: its transaction, once more after a deadlock or a serialization failure; any other error makes it `refused: failed`. */
  private async publishItem(worker: RunWorker, item: PendingItem): Promise<RowStep> {
    try {
      return await retryingConflictOnce(() => this.publishRow(worker, item));
    } catch (error) {
      return this.failItem(worker, item, error);
    }
  }

  /**
   * The transaction of one row. The order of the steps is the lock order of plan 31 section 6.5, and nothing is decided before the run
   * and the item are held: a worker of an old attempt, or a second delivery, writes nothing at all.
   */
  private publishRow(worker: RunWorker, item: PendingItem): Promise<RowStep> {
    return this.db.runInTransaction(async ({ tx }) => {
      const service = await this.publisher.lock(tx, item.serviceId);
      const run = await holdApply(tx, worker);
      if (run === undefined) return 'stopped';
      const row = await lockPendingItem(tx, worker.runId, item.id);
      if (row === undefined) return 'done';
      const outcome = await this.publisher.publishLocked(tx, service, publishInputOf(row, run));
      // Under the item lock the row still has no result; if it had, the listing must not stay without the row that reports it.
      if (!(await writeItemResult(tx, item.id, resultOf(outcome), this.clock.now()))) {
        throw new Error(`Publish row ${item.id} got a result under its lock.`);
      }
      return 'done';
    });
  }

  /**
   * Records a row that failed unexpectedly, in a small transaction of its own (the row's transaction rolled back whole).
   *
   * @returns `failed` when it was recorded; `done` when the row had a result; `stopped` when the run is no longer this worker's
   */
  private failItem(worker: RunWorker, item: PendingItem, error: unknown): Promise<RowStep> {
    this.logger.error(`Publish run ${worker.runId}: service ${item.serviceId} failed: ${errorText(error)}`);
    return this.db.runInTransaction(async ({ tx }) => {
      if ((await holdApply(tx, worker)) === undefined) return 'stopped';
      const written = await writeItemResult(
        tx,
        item.id,
        { result: 'refused', reason: 'failed', detail: failureReason(error), listingId: null, publishedPrice: null },
        this.clock.now(),
      );
      return written ? 'failed' : 'done';
    });
  }

  /**
   * Closes the run with the counters of its rows, and the audit row of the run.
   *
   * The run row is locked before the rows are counted, so no row in flight is missing from the counters. The version moves once per
   * close when the run published something, also what an earlier attempt that died published: its close never ran.
   *
   * @returns how the run closed, or `stopped` when it is no longer this worker's (nothing is written)
   */
  private close(worker: RunWorker, status: ApplyClosing['status'], error: string | null): Promise<PublishRunOutcome> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      if (!(await lockApply(tx, worker))) return 'stopped';
      const counts = await countItemResults(tx, worker.runId);
      const run = await closeApply(tx, worker, { status, error, counts, now: this.clock.now() });
      if (run === undefined) return 'stopped';
      await this.audit.record(tx, {
        action: 'published services to the storefront',
        entityType: 'publish_run',
        entityId: run.id,
        entityLabel: publishRunLabel(run.id),
        after: {
          status,
          total: run.total,
          published: counts.published,
          skipped: counts.skipped,
          refused: counts.refused,
          listed: run.listed,
          requestedBy: run.requestedBy,
          ...(error === null ? {} : { error }),
        },
      });
      if (counts.published > 0) this.priceVersion.bumpAfterCommit(work);
      return status;
    });
  }
}
