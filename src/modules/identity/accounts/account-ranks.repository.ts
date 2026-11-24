// Drizzle queries of the rank and the username of an account on `clients` (identity module). Every function takes a DbExecutor so a use
// case can run several in one transaction; times come from the caller.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { clients } from '../db/schema';

/** What a rank change reads of the account row. */
export interface RankRow {
  readonly id: number;
  readonly name: string;
  readonly groupId: number;
  readonly hasAccount: boolean;
  readonly username: string | null;
}

/**
 * Reads an account for a rank or username write and holds its row until the transaction ends.
 *
 * Why: the callers (the rank change, a merchant create) already hold the row lock; taking it again in the same transaction costs
 * nothing and makes these writes safe when a caller forgot.
 *
 * Side effects: a row lock held until the transaction ends.
 *
 * @param db the transaction
 * @param id the account id
 * @returns the row as it is now, or `undefined` when it does not exist
 */
export async function lockRankRow(db: DbExecutor, id: number): Promise<RankRow | undefined> {
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.name,
      groupId: clients.groupId,
      hasAccount: clients.hasAccount,
      username: clients.username,
    })
    .from(clients)
    .where(eq(clients.id, id))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Writes the rank of an account.
 *
 * Side effects: updates `clients.group_id` and `updated_at`.
 *
 * @param db the transaction
 * @param id the account id
 * @param groupId the new rank
 * @param now the injected clock's time for `updated_at`
 */
export async function writeGroupId(db: DbExecutor, id: number, groupId: number, now: Date): Promise<void> {
  await db.update(clients).set({ groupId, updatedAt: now }).where(eq(clients.id, id));
}

/**
 * Tells whether a Dhru username is taken, ignoring case.
 *
 * @param db the database or a transaction
 * @param username the candidate
 * @returns true when an account has it
 */
export async function isUsernameTaken(db: DbExecutor, username: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(sql`lower(${clients.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return row !== undefined;
}

/**
 * Gives an account a username when it has none.
 *
 * Side effects: updates `clients.username` and `updated_at`.
 *
 * @param db the transaction, or a savepoint of it (the unique index on the lower-case username may refuse the value)
 * @param id the account id
 * @param username the free username
 * @param now the injected clock's time for `updated_at`
 * @returns true when the username was written, false when the account already had one
 * @throws {Error} the database's unique violation (`clients_username_uq`) when another account took the username meanwhile
 */
export async function writeUsernameIfMissing(
  db: DbExecutor,
  id: number,
  username: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ username, updatedAt: now })
    .where(and(eq(clients.id, id), isNull(clients.username)))
    .returning({ id: clients.id });
  return rows.length > 0;
}
