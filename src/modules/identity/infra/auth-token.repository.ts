// Drizzle queries on `auth_tokens` for the staff invite and reset links (identity module). Only keyed hashes are stored.
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AuthToken, type NewAuthToken, authTokens } from '../db/schema';

/** The purposes a staff member's one-time token can have. */
export const STAFF_TOKEN_PURPOSES = ['invite', 'reset'] as const;

/** One value of {@link STAFF_TOKEN_PURPOSES}. */
export type StaffTokenPurpose = (typeof STAFF_TOKEN_PURPOSES)[number];

/**
 * Inserts a token row.
 *
 * @param db the database or a transaction
 * @param row the new token (already hashed)
 * @returns the stored row
 */
export async function insertAuthToken(db: DbExecutor, row: NewAuthToken): Promise<AuthToken> {
  const [created] = await db.insert(authTokens).values(row).returning();
  return created!;
}

/**
 * Finds a staff token by its hash.
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token from the link
 * @returns the row (used or not), or `undefined`
 */
export async function findStaffTokenByHash(db: DbExecutor, tokenHash: string): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.subjectType, 'staff')))
    .limit(1);
  return row;
}

/**
 * Marks a token used, but only if it is still unused and not expired.
 *
 * Why: the guarded `UPDATE` makes the token single-use across API instances: of two simultaneous requests with the same link
 * only one gets the row back (decision 019).
 *
 * @param db the database or a transaction
 * @param id the token id
 * @param now the time of use
 * @returns the row that was consumed, or `undefined` when it was used, expired or gone
 */
export async function consumeAuthToken(db: DbExecutor, id: number, now: Date): Promise<AuthToken | undefined> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.id, id), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning();
  return row;
}

/**
 * Voids every unused invite and reset token of a staff member, optionally keeping one.
 *
 * Why: only the newest link works (a new invite or reset replaces the old one), and a used link voids the rest. The table has
 * no "revoked" column, so a voided token is marked used.
 *
 * @param db the database or a transaction
 * @param staffId the staff id
 * @param now the time to write
 * @param exceptId a token to keep
 * @returns how many tokens were voided
 */
export async function voidOpenStaffTokens(
  db: DbExecutor,
  staffId: number,
  now: Date,
  exceptId?: number,
): Promise<number> {
  const rows = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.subjectType, 'staff'),
        eq(authTokens.subjectId, staffId),
        isNull(authTokens.usedAt),
        exceptId === undefined ? undefined : ne(authTokens.id, exceptId),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}
