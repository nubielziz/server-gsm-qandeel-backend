// Drizzle queries of the account directory on `clients` (identity module). This file holds every comparison of an email with
// `clients.email`: no other file under src may compare it (a tooling test checks), so a login row and a guest row that share one email are
// never mixed up. Every function takes a DbExecutor so a use case can run several in one transaction; times come from the caller.
import { and, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { lower } from '../../../infra/db/columns';
import { type ClientStatus, clients } from '../db/schema';

/** An account as the `clients` table holds it, without anything secret: the columns the account directory hands out. */
export interface AccountRow {
  readonly id: number;
  readonly email: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly groupId: number;
  readonly hasAccount: boolean;
  readonly hasPassword: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly country: string;
  readonly currency: string | null;
}

/** What a read of an account selects: the public facts, and whether a password exists (never the hash). */
const ACCOUNT_COLUMNS = {
  id: clients.id,
  email: clients.email,
  name: clients.name,
  status: clients.status,
  groupId: clients.groupId,
  hasAccount: clients.hasAccount,
  hasPassword: sql<boolean>`${clients.passwordHash} is not null`,
  emailVerifiedAt: clients.emailVerifiedAt,
  country: clients.country,
  currency: clients.currency,
} as const;

/**
 * Puts an email in the form the unique indexes compare: trimmed, lower case.
 *
 * Why: both partial unique indexes on `clients` are on `lower(email)`, so every lookup and every insert goes through the same form.
 *
 * @param email the email as typed
 * @returns the trimmed, lower-case email
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** How firmly {@link lockAccountRow} holds the row: `key share` keeps the account from being deleted or re-keyed, `update` keeps everyone out. */
export type AccountRowLock = 'key share' | 'update';

/**
 * Finds an account of any kind by id.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @returns the account, or `undefined`
 */
export async function findAccountRowById(db: DbExecutor, id: number): Promise<AccountRow | undefined> {
  const [row] = await db.select(ACCOUNT_COLUMNS).from(clients).where(eq(clients.id, id)).limit(1);
  return row;
}

/**
 * Finds the row with a login that holds an email.
 *
 * Why: this is the only lookup of a login row by email. The `has_account` condition is spelled out so the query is served by
 * `clients_login_email_uq`, and so a guest row with the same email is never what a sign-in finds, whatever the physical order of the rows.
 *
 * @param db the database or a transaction
 * @param email the email as typed
 * @returns the login row, or `undefined`
 */
export async function findLoginRowByEmail(db: DbExecutor, email: string): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(clients)
    .where(and(eq(clients.hasAccount, true), eq(lower(clients.email), normalizeEmail(email))))
    .limit(1);
  return row;
}

/**
 * Finds the guest row that holds an email.
 *
 * Why: the guest partition of `clients_guest_email_uq` has at most one row per email.
 *
 * @param db the database or a transaction
 * @param email the email as typed
 * @returns the guest row, or `undefined`
 */
export async function findGuestRowByEmail(db: DbExecutor, email: string): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(clients)
    .where(and(eq(clients.hasAccount, false), eq(lower(clients.email), normalizeEmail(email))))
    .limit(1);
  return row;
}

/**
 * Reads an account and locks its row until the transaction ends.
 *
 * Why: `key share` is what a writer that only needs the account to stay as it is takes (it does not block other `key share` holders);
 * `update` is what a change of the account itself takes (a rank change, a status change). Call it first in a transaction, before the
 * write that depends on what it read.
 *
 * Side effects: a row lock held until the transaction ends.
 *
 * @param db the transaction
 * @param id the account id
 * @param mode how firmly to hold the row
 * @returns the account as it is now, or `undefined` when it does not exist
 */
export async function lockAccountRow(
  db: DbExecutor,
  id: number,
  mode: AccountRowLock,
): Promise<AccountRow | undefined> {
  const [row] = await db.select(ACCOUNT_COLUMNS).from(clients).where(eq(clients.id, id)).limit(1).for(mode);
  return row;
}

/**
 * Locks the guest row of an email without waiting for it.
 *
 * Why: the claim of guest orders must never queue behind a payment, a dispute or a refund that holds the guest's rows; it skips
 * instead. `FOR UPDATE NOWAIT` raises SQLSTATE 55P03 at once when another transaction holds the row.
 *
 * Side effects: a row lock held until the transaction ends.
 *
 * @param db the transaction (or a savepoint of it: the error then rolls back to the savepoint alone)
 * @param email the email as typed
 * @returns the guest row, or `undefined` when no guest row holds the email
 * @throws {Error} the database's `lock_not_available` error (55P03) when another transaction holds the row
 */
export async function lockGuestRowNoWait(db: DbExecutor, email: string): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(clients)
    .where(and(eq(clients.hasAccount, false), eq(lower(clients.email), normalizeEmail(email))))
    .limit(1)
    .for('update', { noWait: true });
  return row;
}

/** The values of a new guest row. */
export interface NewGuestRow {
  /** The normalized email ({@link normalizeEmail}). */
  readonly email: string;
  readonly name: string;
  readonly country: string;
  readonly currency: string | null;
  /** The retail rank. */
  readonly groupId: number;
  /** The injected clock's time for `created_at` and `updated_at`. */
  readonly now: Date;
}

/**
 * Inserts a guest row unless another guest row already holds the email.
 *
 * Why: two checkouts with the same new email at once must end with one guest row. The conflict target names the guest partition
 * (`lower(email) WHERE NOT has_account`), so only a guest row with the same email makes the insert do nothing: a login row with the
 * same email lives in the other partition and never blocks it, and any other unique violation still raises.
 *
 * Side effects: inserts a `clients` row with no username, no password and no second factor (the guest check of the table).
 *
 * @param db the caller's transaction
 * @param values the guest row
 * @returns the new row's id, or `undefined` when a guest row already held the email
 */
export async function insertGuestRow(db: DbExecutor, values: NewGuestRow): Promise<number | undefined> {
  const at = values.now.toISOString();
  const result = await db.execute(sql`
    insert into clients (email, name, country, currency, group_id, status, has_account, created_at, updated_at)
    values (${values.email}, ${values.name}, ${values.country}, ${values.currency}, ${values.groupId}, 'active', false,
      ${at}::timestamptz, ${at}::timestamptz)
    on conflict (lower(email)) where not has_account do nothing
    returning id`);
  const id: unknown = result.rows[0]?.id;
  return id === undefined || id === null ? undefined : Number(id);
}
