// Drizzle queries on `account_signups` (decision 079): the details of a shop sign-up that wait beside their one-time link. Only identity
// writes this table and `auth_tokens`, so the joins below stay inside the module. No query returns a password hash to anything but the
// exchange that applies it.
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AccountSignup, accountSignups, authTokens } from '../db/schema';

/** What waits beside one sign-up link: the hash of the chosen password and the details of the form. */
export interface WaitingSignUp {
  /** argon2id of the password the form carried (decision 007). */
  readonly passwordHash: string;
  /** Trimmed, 1 to 60 characters. */
  readonly firstName: string;
  /** Trimmed, 1 to 60 characters. */
  readonly lastName: string;
  /** ISO 3166 alpha-2, upper case. */
  readonly country: string;
  /** The cleaned form: an optional leading `+` and 7 to 15 digits. */
  readonly phone: string;
}

/** The ids of the links of an account (the links its waiting details can belong to), as a subquery. */
function linksOf(db: DbExecutor, accountId: number) {
  return db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(and(eq(authTokens.subjectType, 'account'), eq(authTokens.subjectId, accountId)));
}

/**
 * Deletes the waiting details of every link of an account (or guest row).
 *
 * Why: decision 079 and its review (B2, S5): every link keeps its own form, and the exchange of any link of the address ends them all, in
 * its own transaction: the forms of the links it voids and of every other link of the row. Nothing with a password hash outlives the
 * exchange.
 *
 * @param db the caller's transaction
 * @param accountId the account (or guest row) the links name
 * @returns how many rows were deleted
 */
export async function discardWaitingSignUps(db: DbExecutor, accountId: number): Promise<number> {
  const rows = await db
    .delete(accountSignups)
    .where(inArray(accountSignups.authTokenId, linksOf(db, accountId)))
    .returning({ id: accountSignups.id });
  return rows.length;
}

/**
 * Stores the details of a sign-up beside its link.
 *
 * @param db the caller's transaction (the one that issued the link)
 * @param authTokenId the `auth_tokens` row of the link
 * @param details the password hash and the details of the form
 * @param now the time from the injected clock
 */
export async function insertWaitingSignUp(
  db: DbExecutor,
  authTokenId: number,
  details: WaitingSignUp,
  now: Date,
): Promise<void> {
  await db.insert(accountSignups).values({ authTokenId, ...details, createdAt: now });
}

/**
 * Takes the waiting details of a link: reads and deletes them in one statement.
 *
 * Why: decision 079: the exchange of the link deletes its details in its own transaction, whatever it then applies, so nothing with a
 * password hash outlives the exchange; a parallel exchange of the same link finds nothing (and its link was used first anyway).
 *
 * @param db the exchange's transaction
 * @param authTokenId the `auth_tokens` row of the link being exchanged
 * @returns the details, or `undefined` for a link that carries none (a plain sign-in link, or one whose form was already deleted)
 */
export async function takeWaitingSignUp(db: DbExecutor, authTokenId: number): Promise<AccountSignup | undefined> {
  const [row] = await db.delete(accountSignups).where(eq(accountSignups.authTokenId, authTokenId)).returning();
  return row;
}

/**
 * Deletes, in one batch, the waiting details whose link can no longer be exchanged: expired, or used (or voided, which marks it used).
 *
 * Why: decision 079: nothing with a password hash outlives its link. The exchange deletes every form of its address; this removes the rest,
 * from the purge every 15 minutes (`sign_up_purge`) and the daily one (`session_purge`). Safe to repeat and to run in parallel.
 *
 * @param db the database
 * @param now the time from the injected clock
 * @param limit the most rows one statement deletes
 * @returns how many rows were deleted
 */
export async function deleteLapsedSignUps(db: DbExecutor, now: Date, limit: number): Promise<number> {
  const lapsed = db
    .select({ id: accountSignups.id })
    .from(accountSignups)
    .innerJoin(authTokens, eq(authTokens.id, accountSignups.authTokenId))
    .where(or(lte(authTokens.expiresAt, now), isNotNull(authTokens.usedAt)))
    .orderBy(accountSignups.id)
    .limit(limit);
  const rows = await db
    .delete(accountSignups)
    .where(inArray(accountSignups.id, lapsed))
    .returning({ id: accountSignups.id });
  return rows.length;
}
