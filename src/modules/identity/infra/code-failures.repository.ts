// Drizzle queries of the daily cap on wrong authenticator codes on `staff_users` and `clients` (identity module): the count, the
// start of its 24 hours and the recorded closing live on the account's own row, so they end only by these statements.
import { type SQL, and, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '../../../infra/db';
import { clients, staffUsers } from '../db/schema';
import { CODE_FAILURE_WINDOW_MS, MAX_FAILED_CODES } from '../domain/code-step-lock';

/** The person whose code step is counted: a staff member (`staff`) or an account of any rank (`account`, a row of `clients`). */
export interface CodeStepAccount {
  readonly type: 'staff' | 'account';
  readonly id: number;
}

/** What one counted attempt finds on the account's row, after it was counted. */
export interface ChargedCodeAttempt {
  /** the attempts counted in the current 24 hours, this one included */
  readonly attempts: number;
  /** when the current 24 hours began */
  readonly since: Date;
  /** when the closing of the current 24 hours was recorded; null while the step was not closed */
  readonly lockedAt: Date | null;
}

/** The columns of the count on one of the two tables. */
interface CountColumns {
  readonly failures: AnyPgColumn;
  readonly since: AnyPgColumn;
  readonly lockedAt: AnyPgColumn;
  readonly updatedAt: AnyPgColumn;
}

const STAFF_COUNT: CountColumns = {
  failures: staffUsers.totpFailures,
  since: staffUsers.totpFailuresSince,
  lockedAt: staffUsers.totpLockedAt,
  updatedAt: staffUsers.updatedAt,
};
const CLIENT_COUNT: CountColumns = {
  failures: clients.totpFailures,
  since: clients.totpFailuresSince,
  lockedAt: clients.totpLockedAt,
  updatedAt: clients.updatedAt,
};

/** The start of the 24 hours still running at `now`: a count that began at or before it is over. */
function windowStart(now: Date): Date {
  return new Date(now.getTime() - CODE_FAILURE_WINDOW_MS);
}

/** The new count, start and closing of one attempt, written in one statement from the values the row holds. */
function chargeOf(
  c: CountColumns,
  now: Date,
): { totpFailures: SQL; totpFailuresSince: SQL; totpLockedAt: SQL; updatedAt: SQL } {
  const ended = sql`(${c.since} is null or ${c.since} <= ${windowStart(now).toISOString()}::timestamptz)`;
  return {
    // The 24 hours of the count are over: the count starts again with this attempt, and a closed step is open again.
    totpFailures: sql`case when ${ended} then 1 else ${c.failures} + 1 end`,
    totpFailuresSince: sql`case when ${ended} then ${now.toISOString()}::timestamptz else ${c.since} end`,
    totpLockedAt: sql`case when ${ended} then null else ${c.lockedAt} end`,
    // A counted code is no change of the account: its `updated_at` stays.
    updatedAt: sql`${c.updatedAt}`,
  };
}

/** One attempt taken back, never below 0; when nothing stays counted, no 24 hours run (the next wrong code starts them). */
function giveBackOf(c: CountColumns): { totpFailures: SQL; totpFailuresSince: SQL; updatedAt: SQL } {
  const lastOne = sql`(${c.failures} <= 1 and ${c.lockedAt} is null)`;
  return {
    totpFailures: sql`greatest(${c.failures} - 1, 0)`,
    totpFailuresSince: sql`case when ${lastOne} then null else ${c.since} end`,
    updatedAt: sql`${c.updatedAt}`,
  };
}

/** The attempt as read back, or `undefined` when the account is gone. */
function charged(
  row: { attempts: number; since: Date | null; lockedAt: Date | null } | undefined,
  now: Date,
): ChargedCodeAttempt | undefined {
  // The statement always leaves a start on the row; `now` only satisfies the type.
  return row === undefined ? undefined : { attempts: row.attempts, since: row.since ?? now, lockedAt: row.lockedAt };
}

/**
 * Counts one code attempt of an account before its code is checked, and starts new 24 hours when the last ones are over.
 *
 * Why: one `UPDATE` of the account's row counts and reads in one atomic step, so attempts sent at the same moment each get their own
 * number and none is checked on a count read before the others were counted. The count is truth kept in Postgres, not in the cache
 * Redis: no eviction, restart or fallback can end it early. It ends when its 24 hours end (the next attempt starts a new count, and a
 * closed step opens again), or by `clearCodeFailures`.
 *
 * @param db the database (the count must be visible to parallel attempts at once, so not the caller's transaction)
 * @param account the staff member or account
 * @param now the clock's time
 * @returns the count after this attempt, or `undefined` when the account is gone
 */
export async function chargeCodeAttempt(
  db: DbExecutor,
  account: CodeStepAccount,
  now: Date,
): Promise<ChargedCodeAttempt | undefined> {
  if (account.type === 'staff') {
    const [row] = await db
      .update(staffUsers)
      .set(chargeOf(STAFF_COUNT, now))
      .where(eq(staffUsers.id, account.id))
      .returning({
        attempts: staffUsers.totpFailures,
        since: staffUsers.totpFailuresSince,
        lockedAt: staffUsers.totpLockedAt,
      });
    return charged(row, now);
  }
  const [row] = await db
    .update(clients)
    .set(chargeOf(CLIENT_COUNT, now))
    .where(eq(clients.id, account.id))
    .returning({ attempts: clients.totpFailures, since: clients.totpFailuresSince, lockedAt: clients.totpLockedAt });
  return charged(row, now);
}

/**
 * Takes one counted attempt back, never below 0: its code was correct, or it was refused before any code was checked.
 *
 * Why: only the attempt's own count goes; the failures of other attempts stay, so a correct code never resets the count. When nothing
 * stays counted, the start of the 24 hours goes too, so they begin with the first counted wrong code.
 *
 * @param db the database
 * @param account the staff member or account
 */
export async function giveBackCodeAttempt(db: DbExecutor, account: CodeStepAccount): Promise<void> {
  if (account.type === 'staff') {
    await db.update(staffUsers).set(giveBackOf(STAFF_COUNT)).where(eq(staffUsers.id, account.id));
    return;
  }
  await db.update(clients).set(giveBackOf(CLIENT_COUNT)).where(eq(clients.id, account.id));
}

/**
 * Records the closing of the code step of the current 24 hours, once: only when it is not recorded yet and the row still counts
 * twenty attempts in them.
 *
 * Why: two requests that reach the cap (a wrong code checked while a correct one is still counted, then given back) must write one audit
 * row, and the recorded closing keeps the step closed for the rest of the 24 hours (`codeStepClosed`). A password or a 2FA reset that
 * cleared the count in the meantime finds no row to close.
 *
 * @param db the transaction that writes the audit row
 * @param account the staff member or account
 * @param now the clock's time
 * @returns when the 24 hours of the closed count began, or `undefined` when this call closed nothing
 */
export async function markCodeStepClosed(
  db: DbExecutor,
  account: CodeStepAccount,
  now: Date,
): Promise<Date | undefined> {
  const start = windowStart(now);
  if (account.type === 'staff') {
    const [row] = await db
      .update(staffUsers)
      .set({ totpLockedAt: now, updatedAt: sql`${staffUsers.updatedAt}` })
      .where(
        and(
          eq(staffUsers.id, account.id),
          isNull(staffUsers.totpLockedAt),
          gte(staffUsers.totpFailures, MAX_FAILED_CODES),
          gt(staffUsers.totpFailuresSince, start),
        ),
      )
      .returning({ since: staffUsers.totpFailuresSince });
    return row?.since ?? undefined;
  }
  const [row] = await db
    .update(clients)
    .set({ totpLockedAt: now, updatedAt: sql`${clients.updatedAt}` })
    .where(
      and(
        eq(clients.id, account.id),
        isNull(clients.totpLockedAt),
        gte(clients.totpFailures, MAX_FAILED_CODES),
        gt(clients.totpFailuresSince, start),
      ),
    )
    .returning({ since: clients.totpFailuresSince });
  return row?.since ?? undefined;
}

/**
 * Forgets the wrong codes of an account and its recorded closing, which opens a closed code step.
 *
 * Why: a new password from an emailed link (it proves the mailbox) or one staff set ends the story of the old one, the same events that
 * end the failed-sign-in lock of the email (decision 052); a reset of two-factor sign-in by staff replaces the authenticator the codes
 * were guessed for. Called in the transaction that stores the password or the reset.
 *
 * @param db the transaction that stores the new password or the reset
 * @param account the staff member or account
 */
export async function clearCodeFailures(db: DbExecutor, account: CodeStepAccount): Promise<void> {
  const cleared = { totpFailures: 0, totpFailuresSince: null, totpLockedAt: null };
  if (account.type === 'staff') {
    await db.update(staffUsers).set(cleared).where(eq(staffUsers.id, account.id));
    return;
  }
  await db.update(clients).set(cleared).where(eq(clients.id, account.id));
}
