// What the two workers of a publish run share (feature 31, plan 31 sections 6.2 and 6.7): the errors that earn a row a second try, the
// text a run keeps for an unexpected error, the label of its audit rows, and the tally of a run switch. No database, no clock.
import { pgErrorInfo } from '../../../../infra/db/pg-errors';
import { MAX_RUN_ERROR_LENGTH } from './publish-item';

/** The SQLSTATEs of a transaction that lost to another one and is worth running again: a deadlock and a serialization failure. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/**
 * Tells whether a row's transaction failed only because it lost to another transaction.
 *
 * Why: plan 31 sections 6.2 and 6.7 and fact 20: `runInTransaction` does not retry a deadlock or a serialization failure, and such a
 * failure says nothing about the row, so it is tried once more before it counts as a failed row.
 *
 * @param error whatever the row's transaction threw
 * @returns true for SQLSTATE `40P01` or `40001`
 */
export function isRetryableConflict(error: unknown): boolean {
  const code = pgErrorInfo(error)?.code;
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Runs a row's transaction, and once more when it lost to another transaction.
 *
 * Why: plan 31 sections 6.2 and 6.7: one retry and no more, so a row that keeps losing ends as a failed row and the run goes on. The
 * work is a whole transaction: the failed try rolled back, so the retry starts from nothing.
 *
 * @param work the row's transaction
 * @returns what it returned
 * @throws whatever the last try threw
 */
export async function retryingConflictOnce<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isRetryableConflict(error)) throw error;
    return work();
  }
}

/**
 * The text a run keeps for an unexpected error (`error`, `switch_error`).
 *
 * Why: the console shows it to staff, so a database error is reduced to its SQLSTATE and constraint (the driver's message carries the
 * statement), as Quick add does; any other error keeps its message. The full error goes to the log.
 *
 * @param error whatever was thrown
 * @returns the text, at most `MAX_RUN_ERROR_LENGTH` characters
 */
export function runErrorText(error: unknown): string {
  const database = pgErrorInfo(error);
  const message = database
    ? `Database error ${database.code}${database.constraint ? ` (${database.constraint})` : ''}.`
    : error instanceof Error && error.message.trim() !== ''
      ? error.message.trim()
      : 'unexpected error';
  return message.slice(0, MAX_RUN_ERROR_LENGTH);
}

/**
 * The label of a run in the audit log.
 *
 * Why: plan 31 section 6.6: every audit row about a run (`entity_type = 'publish_run'`) carries this label.
 *
 * @param runId the run
 * @returns `Publish run #<id>`
 */
export function publishRunLabel(runId: number): string {
  return `Publish run #${runId}`;
}

/**
 * Why a run switch left a listing as it is.
 *
 * Why: plan 31 section 6.7: the reasons are counted in the audit row of the close and not stored per row (the result table shows each
 * listing as it is now).
 */
export const SWITCH_SKIP_REASONS = [
  'service_gone',
  'listing_gone',
  'service_disabled',
  'b2b_only',
  'no_price',
  'failed',
] as const;

/** One value of {@link SWITCH_SKIP_REASONS}. */
export type SwitchSkipReason = (typeof SWITCH_SKIP_REASONS)[number];

/**
 * What one attempt of a run switch has done so far.
 *
 * Why: plan 31 section 6.7: the heartbeat after each chunk and the close write `switched` and the number skipped; the audit row of the
 * close adds `unchanged` (a listing already at the target, which is neither) and the count of each reason.
 */
export class SwitchTally {
  /** Listings this switch changed. */
  switched = 0;
  /** Listings already at the target. */
  unchanged = 0;
  private readonly reasons = new Map<SwitchSkipReason, number>();

  /**
   * Counts one listing left as it is.
   *
   * @param reason why
   * @returns how many listings have this reason now
   */
  skip(reason: SwitchSkipReason): number {
    const count = (this.reasons.get(reason) ?? 0) + 1;
    this.reasons.set(reason, count);
    return count;
  }

  /**
   * Counts the listings left as they are.
   *
   * @returns the number, over every reason
   */
  skipped(): number {
    return [...this.reasons.values()].reduce((sum, count) => sum + count, 0);
  }

  /**
   * The count of each reason, for the audit row of the close.
   *
   * @returns the reasons that occurred, in the order of {@link SWITCH_SKIP_REASONS}
   */
  skippedByReason(): Partial<Record<SwitchSkipReason, number>> {
    return Object.fromEntries(
      SWITCH_SKIP_REASONS.flatMap((reason) => {
        const count = this.reasons.get(reason);
        return count === undefined ? [] : [[reason, count]];
      }),
    );
  }
}

/**
 * The `after` of the audit row `cancelled publishing run`.
 *
 * Why: plan 31 section 6.6: the counts so far, and `replacedBy` when "Check again" cancelled the draft to make a new one; the cancel
 * route and "Check again" write the same row.
 *
 * @param run the run that was cancelled
 * @param counts the rows by result when it was cancelled
 * @param replacedBy the run "Check again" made, when it did
 * @returns the audit payload
 */
export function cancelledRunAudit(
  run: { readonly total: number },
  counts: { readonly published: number; readonly skipped: number; readonly refused: number },
  replacedBy?: number,
): Record<string, unknown> {
  return {
    status: 'cancelled',
    total: run.total,
    published: counts.published,
    skipped: counts.skipped,
    refused: counts.refused,
    ...(replacedBy === undefined ? {} : { replacedBy }),
  };
}
