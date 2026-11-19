// The statements of the bulk publish's run engine on its two tables (feature 31, plan 31 sections 5.2, 6.2, 6.5 and 6.7): the claims of
// an apply and of a run switch, every write a worker makes (each requires the number its claim returned), and the guarded moves the
// routes make under the run row lock. Lock order, everywhere: the service row, the run row, the item row, the listing rows. Feature 31,
// slice B4a adds the statements of the draft: the insert of a run and of its rows, the claim and the guarded writes of the preparing
// worker, and the copy of a run's rows. Slice B4b adds the statements of the draft's edits (the run row `FOR SHARE`, the bulk writes) and
// the close of a run that stalled.
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../../infra/db';
import {
  type ListingPublishItem,
  type ListingPublishRun,
  type NewListingPublishItem,
  type NewListingPublishRun,
  type PublishItemResult,
  type PublishItemState,
  type PublishRunStatus,
  listingPublishItems as items,
  listingPublishRuns as runs,
} from '../../db/schema';
import type { DraftRow } from '../domain/publish-draft';

/** A worker of a run: the run, and the number its claim returned. Every write of the worker requires both. */
export interface RunWorker {
  readonly runId: number;
  /** `listing_publish_runs.attempt` as the worker's claim left it. */
  readonly attempt: number;
}

/** What a worker reads of its run under the run row lock. */
export interface HeldRun {
  /** Whether the run switches its listings on. */
  readonly listed: boolean;
  /** The staff member who asked, or `null`. */
  readonly requestedBy: number | null;
}

/** A row of a run still to publish. */
export interface PendingItem {
  readonly id: number;
  readonly serviceId: number;
}

/** A row of a run that published a listing. */
export interface PublishedItem extends PendingItem {
  readonly listingId: number;
}

/** What a row ended as. */
export interface ItemResult {
  readonly result: PublishItemResult;
  /** One of `PUBLISH_RESULT_REASONS`, or `null` for `published`. */
  readonly reason: string | null;
  readonly detail: string | null;
  readonly listingId: number | null;
  /** The retail price of the published listing, as wire text. */
  readonly publishedPrice: string | null;
}

/** The rows of a run by their result. */
export interface ItemResultCounts {
  readonly published: number;
  readonly skipped: number;
  readonly refused: number;
  /** Rows without a result. */
  readonly pending: number;
}

/** What the close of an apply writes. */
export interface ApplyClosing {
  readonly status: Extract<PublishRunStatus, 'succeeded' | 'failed'>;
  readonly error: string | null;
  readonly counts: ItemResultCounts;
  readonly now: Date;
}

/** What the close of a run switch writes. */
export interface SwitchClosing {
  readonly status: 'done' | 'failed';
  readonly error: string | null;
  readonly switched: number;
  readonly skipped: number;
  readonly now: Date;
}

/** The apply of this worker is still the run's: the guard of every write it makes. */
const isApplyOf = (worker: RunWorker) =>
  and(eq(runs.id, worker.runId), eq(runs.status, 'running'), eq(runs.attempt, worker.attempt));

/** The run switch of this worker is still the run's. */
const isSwitchOf = (worker: RunWorker) =>
  and(eq(runs.id, worker.runId), eq(runs.switchStatus, 'running'), eq(runs.attempt, worker.attempt));

/**
 * Claims a queued run for this worker: `running`, and the next `attempt`.
 *
 * Why: plan 31 section 6.2 step 1. A publish run keeps its id across a resume (its rows hold the edits and the results), so the claim
 * counts: a worker that was only slow and wakes up after staff pressed Continue finds that its number is no longer the row's. Two
 * deliveries of the job meet here, and one finds no `queued` row.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param runId the run
 * @param now the clock's time (`started_at` of the first claim, the heartbeat)
 * @returns the claimed run (`attempt` is this worker's number), or `undefined` when it was not `queued`
 */
export async function claimApply(db: DbExecutor, runId: number, now: Date): Promise<ListingPublishRun | undefined> {
  const [row] = await db
    .update(runs)
    .set({
      status: 'running',
      attempt: sql`${runs.attempt} + 1`,
      startedAt: sql`coalesce(${runs.startedAt}, ${now.toISOString()}::timestamptz)`,
      heartbeatAt: now,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
    .returning();
  return row;
}

/**
 * Takes the run row `FOR SHARE`, when the apply is still this worker's.
 *
 * Why: plan 31 sections 6.2 and 6.5: every row transaction of the worker holds it from here to its commit. A cancel or a resume takes the
 * row `FOR UPDATE`, so it waits for the row in flight, and whoever claims the run next never finds that row without its result. Under
 * read committed a row changed while this waited is judged again in its new version, so a cancel or a claim that just committed is seen.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the transaction (it holds the service row, when it has one)
 * @param worker the worker
 * @returns what the worker needs of the run, or `undefined` when the run was cancelled, closed or claimed again: the worker stops
 */
export async function holdApply(tx: DbExecutor, worker: RunWorker): Promise<HeldRun | undefined> {
  const [row] = await tx
    .select({ listed: runs.listed, requestedBy: runs.requestedBy })
    .from(runs)
    .where(isApplyOf(worker))
    .for('share');
  return row;
}

/**
 * Takes the run row `FOR UPDATE` for the close of this worker's apply.
 *
 * Why: plan 31 section 6.2 step 5: the three counters are read from the rows after this, so no row in flight can be missing from them.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the close's transaction
 * @param worker the worker
 * @returns false when the apply is no longer this worker's
 */
export async function lockApply(tx: DbExecutor, worker: RunWorker): Promise<boolean> {
  const rows = await tx.select({ id: runs.id }).from(runs).where(isApplyOf(worker)).for('update');
  return rows.length > 0;
}

/**
 * Moves the heartbeat of this worker's apply.
 *
 * Why: plan 31 section 6.2 step 3: a live run without a heartbeat for five minutes reads as stalled, and the guard tells the worker that
 * it lost the run.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param worker the worker
 * @param now the clock's time
 * @returns false when the apply is no longer this worker's: it stops
 */
export async function beatApply(db: DbExecutor, worker: RunWorker, now: Date): Promise<boolean> {
  const rows = await db.update(runs).set({ heartbeatAt: now }).where(isApplyOf(worker)).returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Closes this worker's apply.
 *
 * Why: plan 31 section 6.2 step 5: `succeeded` or `failed`, with the counters from the rows. No row: a cancel, a stalled close or a
 * newer claim came first, and the worker writes nothing else. A `succeeded` close with no error of its own leaves `error` as it is, so a
 * run that took only the first services of its scope still says so after it published them.
 *
 * Side effects: updates the run.
 *
 * @param tx the close's transaction, holding the run row ({@link lockApply})
 * @param worker the worker
 * @param closing the status, the error and the counters
 * @returns the closed run, or `undefined` when the apply is no longer this worker's
 */
export async function closeApply(
  tx: DbExecutor,
  worker: RunWorker,
  closing: ApplyClosing,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      status: closing.status,
      // A run that ends well says nothing of its own, so what `error` holds stays: the note that its scope was cut at the most a run takes
      // (plan 31 section 6.1 step 2). A failure writes its own text.
      ...(closing.status === 'succeeded' && closing.error === null ? {} : { error: closing.error }),
      publishedCount: closing.counts.published,
      skippedCount: closing.counts.skipped,
      refusedCount: closing.counts.refused,
      finishedAt: closing.now,
      heartbeatAt: closing.now,
    })
    .where(isApplyOf(worker))
    .returning();
  return row;
}

/**
 * Gives every row that is left out its result.
 *
 * Why: plan 31 section 6.2 step 2: a row nobody ticked is `skipped` with its blocking reason, or `left_out`; nothing is tried for it.
 * Rows that already have a result keep it, so a resume repeats this harmlessly.
 *
 * Side effects: updates `listing_publish_items`.
 *
 * @param tx the transaction, holding the run row ({@link holdApply})
 * @param runId the run
 * @param now the clock's time (`finished_at`)
 * @returns how many rows it marked
 */
export async function skipLeftOutItems(tx: DbExecutor, runId: number, now: Date): Promise<number> {
  const rows = await tx
    .update(items)
    .set({ result: 'skipped', resultReason: sql`coalesce(${items.blockedReason}, 'left_out')`, finishedAt: now })
    .where(and(eq(items.runId, runId), isNull(items.result), eq(items.included, false)))
    .returning({ id: items.id });
  return rows.length;
}

/**
 * Reads the next rows of a run that have no result.
 *
 * Why: plan 31 section 6.2 step 3: the work list comes from the rows, so a resume continues with what is left. The list decides
 * nothing: each row is re-read under its lock. The cursor means a row that ended without a result (the worker then stops) is never
 * taken twice by one attempt.
 *
 * @param db the database
 * @param runId the run
 * @param afterId the last row this worker handled, or 0
 * @param limit the size of a chunk
 * @returns the rows in id order
 */
export function pendingItems(db: DbExecutor, runId: number, afterId: number, limit: number): Promise<PendingItem[]> {
  return db
    .select({ id: items.id, serviceId: items.serviceId })
    .from(items)
    .where(and(eq(items.runId, runId), isNull(items.result), gt(items.id, afterId)))
    .orderBy(asc(items.id))
    .limit(limit);
}

/**
 * Locks a row of a run that still has no result.
 *
 * Why: plan 31 section 6.2, step 3 of the row transaction: a row that has a result already (a second delivery) is left alone, and its
 * transaction writes nothing.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the row's transaction, holding the service row and the run row
 * @param runId the run
 * @param itemId the row
 * @returns the row, or `undefined` when it has a result or is gone
 */
export async function lockPendingItem(
  tx: DbExecutor,
  runId: number,
  itemId: number,
): Promise<ListingPublishItem | undefined> {
  const [row] = await tx
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.runId, runId), isNull(items.result)))
    .for('update');
  return row;
}

/**
 * Writes what a row ended as, unless it has a result already.
 *
 * Why: plan 31 sections 6.2 and 6.5: this is the only place an outcome is written, and a `published` result is never overwritten.
 *
 * Side effects: updates the row.
 *
 * @param tx the transaction, holding the run row
 * @param itemId the row
 * @param outcome the result
 * @param now the clock's time (`finished_at`)
 * @returns false when the row had a result
 */
export async function writeItemResult(
  tx: DbExecutor,
  itemId: number,
  outcome: ItemResult,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(items)
    .set({
      result: outcome.result,
      resultReason: outcome.reason,
      resultDetail: outcome.detail,
      listingId: outcome.listingId,
      publishedPrice: outcome.publishedPrice,
      finishedAt: now,
    })
    .where(and(eq(items.id, itemId), isNull(items.result)))
    .returning({ id: items.id });
  return rows.length > 0;
}

/**
 * Counts the rows of a run by their result.
 *
 * Why: plan 31 sections 5.2 and 6.2: the counters of a close and of a cancel come from the rows, never from what one worker remembers,
 * so they stay true across attempts.
 *
 * @param db the database or the caller's transaction
 * @param runId the run
 * @returns the counts
 */
export async function countItemResults(db: DbExecutor, runId: number): Promise<ItemResultCounts> {
  const [row] = await db
    .select({
      published: sql<number>`(count(*) filter (where ${items.result} = 'published'))::int`,
      skipped: sql<number>`(count(*) filter (where ${items.result} = 'skipped'))::int`,
      refused: sql<number>`(count(*) filter (where ${items.result} = 'refused'))::int`,
      pending: sql<number>`(count(*) filter (where ${items.result} is null))::int`,
    })
    .from(items)
    .where(eq(items.runId, runId));
  return row!;
}

/**
 * Claims a queued run switch for this worker: `running`, and the next `attempt`.
 *
 * Why: plan 31 section 6.7 step 1. The target is part of the guard, so a job of an older press finds nothing once a newer press asked
 * for the other target. The claim raises the counter an apply raises too, so it stops any worker still on the run.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param runId the run
 * @param listed the target of the job
 * @param now the clock's time (the heartbeat)
 * @returns the claimed run (`attempt` is this worker's number), or `undefined` when no such switch is queued
 */
export async function claimSwitch(
  db: DbExecutor,
  runId: number,
  listed: boolean,
  now: Date,
): Promise<ListingPublishRun | undefined> {
  const [row] = await db
    .update(runs)
    .set({ switchStatus: 'running', attempt: sql`${runs.attempt} + 1`, heartbeatAt: now })
    .where(and(eq(runs.id, runId), eq(runs.switchStatus, 'queued'), eq(runs.switchListed, listed)))
    .returning();
  return row;
}

/**
 * Takes the run row `FOR SHARE`, when the run switch is still this worker's.
 *
 * Why: plan 31 section 6.7 step 2: the check of every row of the switch, after the service row and before the listing.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the row's transaction
 * @param worker the worker
 * @returns false when the switch is no longer this worker's: it stops
 */
export async function holdSwitch(tx: DbExecutor, worker: RunWorker): Promise<boolean> {
  const rows = await tx.select({ id: runs.id }).from(runs).where(isSwitchOf(worker)).for('share');
  return rows.length > 0;
}

/**
 * Reads the next rows of a run that published a listing.
 *
 * Why: plan 31 section 6.7 step 2: the run switch touches what the run published and nothing else.
 *
 * @param db the database
 * @param runId the run
 * @param afterId the last row this worker handled, or 0
 * @param limit the size of a chunk
 * @returns the rows in id order
 */
export async function publishedItems(
  db: DbExecutor,
  runId: number,
  afterId: number,
  limit: number,
): Promise<PublishedItem[]> {
  const rows = await db
    .select({ id: items.id, serviceId: items.serviceId, listingId: items.listingId })
    .from(items)
    .where(
      and(eq(items.runId, runId), eq(items.result, 'published'), isNotNull(items.listingId), gt(items.id, afterId)),
    )
    .orderBy(asc(items.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, serviceId: row.serviceId, listingId: row.listingId! }));
}

/**
 * Moves the heartbeat of this worker's run switch, with its two counters.
 *
 * Why: plan 31 section 6.7 step 2: the console shows the progress of a switch from these columns.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param worker the worker
 * @param counts the listings switched and skipped so far
 * @param now the clock's time
 * @returns false when the switch is no longer this worker's: it stops
 */
export async function beatSwitch(
  db: DbExecutor,
  worker: RunWorker,
  counts: { readonly switched: number; readonly skipped: number },
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ switchedCount: counts.switched, switchSkippedCount: counts.skipped, heartbeatAt: now })
    .where(isSwitchOf(worker))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Closes this worker's run switch.
 *
 * Why: plan 31 section 6.7 step 3.
 *
 * Side effects: updates the run.
 *
 * @param tx the close's transaction
 * @param worker the worker
 * @param closing the status, the error and the counters
 * @returns the run, or `undefined` when the switch is no longer this worker's
 */
export async function closeSwitch(
  tx: DbExecutor,
  worker: RunWorker,
  closing: SwitchClosing,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      switchStatus: closing.status,
      switchError: closing.error,
      switchedCount: closing.switched,
      switchSkippedCount: closing.skipped,
      heartbeatAt: closing.now,
    })
    .where(isSwitchOf(worker))
    .returning();
  return row;
}

/**
 * Locks a run row for a move that a route decides: apply, cancel, the run switch, "Check again".
 *
 * Why: plan 31 sections 5.2 and 6.5: every row transaction of a worker holds this row `FOR SHARE`, so the lock waits for the row in
 * flight and no worker is inside a row while the move runs.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the route's transaction
 * @param runId the run
 * @returns the run, or `undefined` when it does not exist
 */
export async function lockRun(tx: DbExecutor, runId: number): Promise<ListingPublishRun | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
  return row;
}

/**
 * Moves a run to `queued`: the first apply of a draft, or a resume.
 *
 * Why: plan 31 section 5.2: a draft that was never prepared is never applied, whatever the caller checked; a run that is finished for
 * good is not moved. `finished_at` of an earlier attempt is cleared, because the run is live again; so is the `error` of a run that failed
 * (any other run can hold only the note of a scope that was cut, which stays).
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @param options the clock's time and, when staff sent it, how the run publishes
 * @returns the queued run, or `undefined` when the move is not allowed
 */
export async function moveRunToQueued(
  tx: DbExecutor,
  runId: number,
  options: { readonly now: Date; readonly listed?: boolean },
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      status: 'queued',
      heartbeatAt: options.now,
      // A failed run's `error` is why it failed, and a resume clears it. Any other run can hold only the note of a scope cut at the most a
      // run takes (plan 31 section 6.1 step 2), which stays with the run.
      error: sql`case when ${runs.status} = 'failed' then null else ${runs.error} end`,
      finishedAt: null,
      ...(options.listed === undefined ? {} : { listed: options.listed }),
    })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, ['draft', 'failed', 'queued', 'running']),
        isNotNull(runs.preparedAt),
      ),
    )
    .returning();
  return row;
}

/**
 * Closes a run switch that is still `queued` or `running`, as `failed`.
 *
 * Why: plan 31 sections 5.2 and 6.7: a run and its switch share one heartbeat, so the resume that writes it would make a switch that
 * stalled read alive again (a false `409` after the run closes), and the switch's late job could still claim the run and stop the resumed
 * apply. Closed here, the job finds nothing to claim and a worker that wakes up fails its own guard. A switch that is `done` or `failed`
 * keeps what it says.
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @param error the text staff read (`SWITCH_STALLED_ERROR`)
 * @returns false when no switch was open
 */
export async function closeStalledSwitch(tx: DbExecutor, runId: number, error: string): Promise<boolean> {
  const rows = await tx
    .update(runs)
    .set({ switchStatus: 'failed', switchError: error })
    .where(and(eq(runs.id, runId), inArray(runs.switchStatus, ['queued', 'running'])))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Sets the rows that failed unexpectedly back to no result, so a resume tries them again.
 *
 * Why: plan 31 sections 5.2 and 6.2: this runs under the run row lock, where no worker can be inside a row, so it needs no other guard
 * and cannot race a claim. Every other result stays.
 *
 * Side effects: updates `listing_publish_items`.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @returns how many rows were reset
 */
export async function reopenFailedItems(tx: DbExecutor, runId: number): Promise<number> {
  const rows = await tx
    .update(items)
    .set({ result: null, resultReason: null, resultDetail: null, finishedAt: null })
    .where(and(eq(items.runId, runId), eq(items.result, 'refused'), eq(items.resultReason, 'failed')))
    .returning({ id: items.id });
  return rows.length;
}

/**
 * Cancels a run that is not finished, with the counters from its rows.
 *
 * Why: plan 31 section 5.2: rows already published stay published; the worker stops before its next row, because the status no longer
 * matches its guard.
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @param counts the rows by result, read under that lock
 * @param now the clock's time (`finished_at`)
 * @param replacedBy the run "Check again" made from this draft (plan 31 section 5.2), stored with the cancel; "Prepare again" repoints it when that run died before its preview was ready
 * @returns the cancelled run, or `undefined` when it was finished
 */
export async function cancelRunRow(
  tx: DbExecutor,
  runId: number,
  counts: ItemResultCounts,
  now: Date,
  replacedBy?: number,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      status: 'cancelled',
      publishedCount: counts.published,
      skippedCount: counts.skipped,
      refusedCount: counts.refused,
      finishedAt: now,
      heartbeatAt: now,
      ...(replacedBy === undefined ? {} : { replacedByRunId: replacedBy }),
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['preparing', 'draft', 'queued', 'running'])))
    .returning();
  return row;
}

/**
 * Moves the link of a replaced draft to the run that now carries its rows.
 *
 * Why: plan 31 sections 5.2 and 7.2: when the run "Check again" made died before its preview was ready, "Prepare again" copies the old
 * draft once more, and the draft must lead to the run that holds its edits. The draft stays `cancelled`: nothing else of it changes.
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the replaced draft
 * @param replacedBy the new run
 * @returns the run, or `undefined` when it is not a replaced draft
 */
export async function repointReplacedRun(
  tx: DbExecutor,
  runId: number,
  replacedBy: number,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({ replacedByRunId: replacedBy })
    .where(and(eq(runs.id, runId), eq(runs.status, 'cancelled'), isNotNull(runs.replacedByRunId)))
    .returning();
  return row;
}

/**
 * Queues a run switch of a finished run.
 *
 * Why: plan 31 section 5.2: the target is stored in `listed` too, so a later Continue follows the last choice; the counters are those
 * of the last switch, so they start again.
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @param listed the target
 * @param now the clock's time (the heartbeat)
 * @returns the run, or `undefined` when it is not finished
 */
export async function queueRunSwitch(
  tx: DbExecutor,
  runId: number,
  listed: boolean,
  now: Date,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      switchStatus: 'queued',
      switchListed: listed,
      listed,
      switchedCount: 0,
      switchSkippedCount: 0,
      switchError: null,
      heartbeatAt: now,
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['succeeded', 'failed', 'cancelled'])))
    .returning();
  return row;
}

/**
 * Inserts a run.
 *
 * Why: plan 31 section 5.2: `POST /admin/publish-runs` inserts the run (and the outbox event) in one transaction; the Quick add
 * hand-over (slice B6) inserts its own with a conflict target of its own.
 *
 * Side effects: inserts a `listing_publish_runs` row.
 *
 * @param db the caller's transaction
 * @param values the run (`status` `preparing` unless the caller says otherwise)
 * @returns the new run
 */
export async function insertRun(db: DbExecutor, values: NewListingPublishRun): Promise<ListingPublishRun> {
  const [row] = await db.insert(runs).values(values).returning();
  return row!;
}

/**
 * Inserts the run of a Quick add hand-over, unless the Quick add run already has one.
 *
 * Why: plan 31 section 6.3: one publish run per Quick add run. `listing_publish_runs_source_run_uq` is a partial unique index, so the
 * conflict target repeats its predicate (without it Postgres refuses the statement). A second delivery of the job finds the run and gets
 * nothing back.
 *
 * Side effects: inserts a `listing_publish_runs` row, or nothing.
 *
 * @param db the database or a transaction
 * @param values the run (`status` `preparing`, `source` `quick_add`, `source_run_id` set)
 * @returns the new run, or `undefined` when the Quick add run already has its publish run
 */
export async function insertQuickAddRun(
  db: DbExecutor,
  values: NewListingPublishRun & { readonly sourceRunId: number },
): Promise<ListingPublishRun | undefined> {
  const [row] = await db
    .insert(runs)
    .values(values)
    .onConflictDoNothing({ target: runs.sourceRunId, where: isNotNull(runs.sourceRunId) })
    .returning();
  return row;
}

/**
 * Locks the automatic run a Quick add started, when it has one.
 *
 * Why: plan 31 section 6.3: staff prepare the preview of a Quick add run by hand when its hand-over died; the automatic run that stalled is
 * closed in the same transaction, so a worker that only slept cannot publish beside them (`preparing` writes are guarded).
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the route's transaction
 * @param quickAddRunId the `supplier_import_runs` row
 * @returns the publish run of that Quick add, or `undefined` when none was made
 */
export async function lockQuickAddRun(tx: DbExecutor, quickAddRunId: number): Promise<ListingPublishRun | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.sourceRunId, quickAddRunId)).for('update');
  return row;
}

/**
 * Reads a run, without a lock.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @returns the run, or `undefined` when it does not exist
 */
export async function findRun(db: DbExecutor, runId: number): Promise<ListingPublishRun | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row;
}

/**
 * Claims a run that is waiting to be prepared.
 *
 * Why: plan 31 section 6.1 step 1: the claim makes the job idempotent. A second delivery, or a run that was cancelled, finds no row.
 * The queue `imports` has one attempt and no stalled re-run, so a worker that died leaves the claim set and the run reads `failed`.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param runId the run
 * @param now the clock's time (the claim and the heartbeat)
 * @returns the claimed run, or `undefined` when it is not `preparing` or was claimed already
 */
export async function claimPrepare(db: DbExecutor, runId: number, now: Date): Promise<ListingPublishRun | undefined> {
  const [row] = await db
    .update(runs)
    .set({ prepareClaimedAt: now, heartbeatAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, 'preparing'), isNull(runs.prepareClaimedAt)))
    .returning();
  return row;
}

/**
 * Moves the heartbeat of a run that is being prepared.
 *
 * Why: plan 31 section 6.1 step 5: after every batch and page; guarded on `preparing`, so no row means the run was cancelled and the
 * worker stops.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param runId the run
 * @param now the clock's time
 * @returns false when the run is no longer `preparing`
 */
export async function beatPrepare(db: DbExecutor, runId: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ heartbeatAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, 'preparing')))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Inserts the rows of a draft, `ON CONFLICT DO NOTHING`.
 *
 * Why: plan 31 section 6.1 step 3: the rows are inserted in batches before they are evaluated; a copied row arrives with the fields it
 * keeps. A repeat of the same batch (a second delivery that got past the claim) changes nothing.
 *
 * Side effects: inserts `listing_publish_items` rows.
 *
 * @param db the database or a transaction
 * @param rows the rows (`run_id`, `service_id`, and what a copy keeps)
 */
export async function insertDraftItems(db: DbExecutor, rows: readonly NewListingPublishItem[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(items)
    .values([...rows])
    .onConflictDoNothing({ target: [items.runId, items.serviceId] });
}

/**
 * Deletes the rows of services that vanished while the draft was prepared.
 *
 * Why: plan 31 section 6.1: a draft shows live services; a service archived between the insert of its row and its evaluation has no
 * facts to judge, and the preview must not show it.
 *
 * Side effects: deletes `listing_publish_items` rows.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param serviceIds the services to drop from the draft
 */
export async function deleteDraftItems(db: DbExecutor, runId: number, serviceIds: readonly number[]): Promise<void> {
  if (serviceIds.length === 0) return;
  await db.delete(items).where(and(eq(items.runId, runId), inArray(items.serviceId, [...serviceIds])));
}

/**
 * Writes the detection and the evaluation of a page of draft rows, in one statement.
 *
 * Why: plan 31 section 6.1 step 5: one `UPDATE ... FROM (VALUES ...)` per page writes the detection, the evaluation, the price mode
 * and the tick of every row of the page. The flags are a text array built from the closed list `PUBLISH_FLAGS` (letters, digits and
 * underscores), so the literal needs no escaping.
 *
 * Side effects: updates `listing_publish_items`.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param rows the evaluated rows of a page (at most a few hundred)
 * @param now the clock's time (`evaluated_at`)
 */
export async function writeDraftRows(
  db: DbExecutor,
  runId: number,
  rows: readonly DraftRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.serviceId}::bigint, ${JSON.stringify(row.detected)}::jsonb, ${row.title}::text, ${row.slug}::text, ${row.slugSource}::text, ${row.brand}::text, ${row.carrier}::text, ${row.country}::text, ${row.priceMode}::text, ${row.priceOverride}::numeric, ${row.replacesPrice}::numeric, ${row.existingPrice}::numeric, ${row.cost}::numeric, ${row.floorPrice}::numeric, ${row.ruleId}::bigint, ${row.rulePrice}::numeric, ${row.state}::text, ${row.blockedReason}::text, ${`{${row.flags.join(',')}}`}::text[], ${row.included}::boolean, ${row.edited}::boolean)`,
    ),
    sql`, `,
  );
  await db.execute(sql`
    update ${items} as target
    set detected = changed.detected, title = changed.title, slug = changed.slug, slug_source = changed.slug_source,
        brand = changed.brand, carrier = changed.carrier, country = changed.country, price_mode = changed.price_mode,
        price_override = changed.price_override, replaces_price = changed.replaces_price, existing_price = changed.existing_price,
        cost = changed.cost, floor_price = changed.floor_price, rule_id = changed.rule_id, rule_price = changed.rule_price,
        state = changed.state, blocked_reason = changed.blocked_reason, flags = changed.flags, included = changed.included,
        edited = changed.edited, evaluated_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
    from (values ${values}) as changed(service_id, detected, title, slug, slug_source, brand, carrier, country, price_mode,
        price_override, replaces_price, existing_price, cost, floor_price, rule_id, rule_price, state, blocked_reason, flags,
        included, edited)
    where target.run_id = ${runId} and target.service_id = changed.service_id`);
}

/** What the close of a prepare writes. */
export interface PrepareClosing {
  /** `draft`, or `queued` for an automatic run with a row to publish. */
  readonly status: Extract<PublishRunStatus, 'draft' | 'queued'>;
  readonly total: number;
  /** A note for staff (a scope cut at the most a run takes), or `null`. */
  readonly error: string | null;
  readonly now: Date;
}

/**
 * Closes the prepare of a run: the draft is ready (or, for an automatic run, queued to be published).
 *
 * Why: plan 31 section 6.1 step 6: guarded on `preparing`, so a run that was cancelled while it was prepared stays cancelled and the
 * worker writes nothing else.
 *
 * Side effects: updates the run.
 *
 * @param tx the close's transaction
 * @param runId the run
 * @param closing the status, the total, the note and the clock's time
 * @returns the closed run, or `undefined` when the run is no longer `preparing`
 */
export async function closePrepare(
  tx: DbExecutor,
  runId: number,
  closing: PrepareClosing,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      status: closing.status,
      total: closing.total,
      error: closing.error,
      preparedAt: closing.now,
      heartbeatAt: closing.now,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'preparing')))
    .returning();
  return row;
}

/**
 * Closes a run that failed while it was prepared.
 *
 * Why: plan 31 section 6.1 step 7: the run reads `failed` with the error; `prepared_at` stays null, so a half-evaluated draft is never
 * applied. Guarded on `preparing`.
 *
 * Side effects: updates the run.
 *
 * @param db the database
 * @param runId the run
 * @param error the text staff read (at most 500 characters)
 * @param now the clock's time
 * @returns false when the run is no longer `preparing`
 */
export async function failPrepare(db: DbExecutor, runId: number, error: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ status: 'failed', error, finishedAt: now, heartbeatAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, 'preparing')))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Reads the rows of an earlier run that a new draft takes: every row without a `published` result, after an id.
 *
 * Why: plan 31 section 5.2 (scope `run`): "Check again" takes every row of a draft (none has a result); "Review the rest" takes the rows
 * of a finished run that were left out, refused or never reached.
 *
 * @param db the database or a transaction
 * @param runId the earlier run
 * @param afterId the last row id of the previous page, or 0
 * @param limit the page size
 * @returns the rows in id order
 */
export function itemsToCopy(
  db: DbExecutor,
  runId: number,
  afterId: number,
  limit: number,
): Promise<ListingPublishItem[]> {
  return db
    .select()
    .from(items)
    .where(and(eq(items.runId, runId), gt(items.id, afterId), sql`${items.result} is distinct from 'published'`))
    .orderBy(asc(items.id))
    .limit(limit);
}

/**
 * Counts the rows of a run and its ticked rows.
 *
 * Why: plan 31 sections 5.2 and 6.1: the close of a prepare writes the total from the rows, and an automatic run is applied only when
 * a row is ticked.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @returns the rows and the ticked rows
 */
export async function countDraftRows(
  db: DbExecutor,
  runId: number,
): Promise<{ readonly total: number; readonly included: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      included: sql<number>`(count(*) filter (where ${items.included}))::int`,
    })
    .from(items)
    .where(eq(items.runId, runId));
  return row!;
}

/**
 * Takes the run row `FOR SHARE` for an edit of its draft.
 *
 * Why: plan 31 sections 5.2 and 6.5: apply, cancel and "Check again" take the row `FOR UPDATE`, so an edit and a move of the run never
 * interleave: either the edit commits first and apply publishes the edited row, or the run moved first and the edit finds it is no
 * longer a draft. Several edits share the lock; the row lock of each item serializes two edits of one row.
 *
 * Side effects: a row lock until the end of the transaction.
 *
 * @param tx the edit's transaction
 * @param runId the run
 * @returns the run, or `undefined` when it does not exist
 */
export async function shareRun(tx: DbExecutor, runId: number): Promise<ListingPublishRun | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('share');
  return row;
}

/**
 * Closes a run whose worker stopped: `failed`, with the stalled sentence and the counters from its rows.
 *
 * Why: plan 31 section 5.2 (the switch route): a `queued` or `running` run that has gone five minutes without a heartbeat is closed
 * `failed` by the transaction that switches it, as Quick add closes a stalled run at a restart. A worker that wakes up later finds
 * the status changed and stops at its next row.
 *
 * Side effects: updates the run.
 *
 * @param tx the route's transaction, holding the run row ({@link lockRun})
 * @param runId the run
 * @param counts the rows by result, read under that lock
 * @param error the text staff read (`STALLED_ERROR`)
 * @param now the clock's time (`finished_at`)
 * @returns the closed run, or `undefined` when it was not `queued` or `running`
 */
export async function closeStalledRun(
  tx: DbExecutor,
  runId: number,
  counts: ItemResultCounts,
  error: string,
  now: Date,
): Promise<ListingPublishRun | undefined> {
  const [row] = await tx
    .update(runs)
    .set({
      status: 'failed',
      error,
      publishedCount: counts.published,
      skippedCount: counts.skipped,
      refusedCount: counts.refused,
      finishedAt: now,
      heartbeatAt: now,
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['queued', 'running'])))
    .returning();
  return row;
}

/**
 * Reads some rows of a run, with every column.
 *
 * Why: plan 31 section 5.2 (`bulk`): the facts of a page of rows are read, recomputed and written back in one statement.
 *
 * @param tx the bulk's transaction, holding the run row `FOR UPDATE`
 * @param runId the run
 * @param itemIds the rows
 * @returns the rows of this run among them, in id order
 */
export function itemsByIds(tx: DbExecutor, runId: number, itemIds: readonly number[]): Promise<ListingPublishItem[]> {
  if (itemIds.length === 0) return Promise.resolve([]);
  return tx
    .select()
    .from(items)
    .where(and(eq(items.runId, runId), inArray(items.id, [...itemIds])))
    .orderBy(asc(items.id));
}

/**
 * Counts, among some rows, those that are blocked.
 *
 * Why: plan 31 section 5.2 (`bulk`): `refused` is the number of rows that could not take `included: true`.
 *
 * @param tx the bulk's transaction
 * @param runId the run
 * @param itemIds the selected rows
 * @returns how many of them are `blocked`
 */
export async function countBlockedAmong(tx: DbExecutor, runId: number, itemIds: readonly number[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  const [row] = await tx
    .select({ blocked: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.runId, runId), inArray(items.id, [...itemIds]), eq(items.state, 'blocked')));
  return row?.blocked ?? 0;
}

/**
 * Sets the tick of some rows, in one statement checked against the stored state.
 *
 * Why: plan 31 section 5.2 (`bulk`): a row that is `blocked` is never ticked (the statement leaves it out, and the table's CHECK would
 * refuse it otherwise); only a row whose tick differs is written, so the answer counts real changes.
 *
 * Side effects: updates `listing_publish_items`.
 *
 * @param tx the bulk's transaction, holding the run row `FOR UPDATE`
 * @param runId the run
 * @param itemIds the selected rows
 * @param included the tick to set
 * @returns the rows that changed
 */
export async function setIncluded(
  tx: DbExecutor,
  runId: number,
  itemIds: readonly number[],
  included: boolean,
): Promise<number[]> {
  if (itemIds.length === 0) return [];
  const rows = await tx
    .update(items)
    .set({ included })
    .where(
      and(
        eq(items.runId, runId),
        inArray(items.id, [...itemIds]),
        isNull(items.result),
        ne(items.included, included),
        included ? ne(items.state, 'blocked') : undefined,
      ),
    )
    .returning({ id: items.id });
  return rows.map((row) => row.id);
}

/** What a bulk change of the facts writes for one row. */
export interface FactsWrite {
  readonly id: number;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly flags: readonly string[];
  readonly state: PublishItemState;
}

/**
 * Writes the brand, carrier, country, flags and state of a page of rows, in one statement.
 *
 * Why: plan 31 section 5.2 (`bulk`): one `UPDATE ... FROM (VALUES ...)` per page of 500 rows, so the badges are right after a bulk fix.
 * The rows become `edited` (a copy of the draft keeps their facts). The flags are a text array built from the closed list
 * `PUBLISH_FLAGS` (letters, digits and underscores), so the literal needs no escaping; the three facts are bound parameters.
 *
 * Side effects: updates `listing_publish_items`.
 *
 * @param tx the bulk's transaction, holding the run row `FOR UPDATE`
 * @param runId the run
 * @param rows the rows to write (at most a page)
 * @param now the clock's time (`updated_at`)
 */
export async function writeFacts(tx: DbExecutor, runId: number, rows: readonly FactsWrite[], now: Date): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::bigint, ${row.brand}::text, ${row.carrier}::text, ${row.country}::text, ${`{${row.flags.join(',')}}`}::text[], ${row.state}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    update ${items} as target
    set brand = changed.brand, carrier = changed.carrier, country = changed.country, flags = changed.flags,
        state = changed.state, edited = true, updated_at = ${now.toISOString()}::timestamptz
    from (values ${values}) as changed(id, brand, carrier, country, flags, state)
    where target.run_id = ${runId} and target.id = changed.id and target.result is null`);
}
