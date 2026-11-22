// Drizzle queries on `auth_tokens` for the staff invite and reset links (identity module). Only keyed hashes are stored.
import { and, desc, eq, gt, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AuthToken, type AuthTokenPurpose, type NewAuthToken, type SubjectType, authTokens } from '../db/schema';

/** The purposes a staff member's one-time token can have: the staff subset of {@link AuthTokenPurpose}. */
export const STAFF_TOKEN_PURPOSES = ['invite', 'reset'] as const satisfies readonly AuthTokenPurpose[];

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
 * Voids an account's unused links of a family except its newest few, so at most `keep` stay usable.
 *
 * Why: decision 052. A link a visitor asked for (the sign-in link, forgot password) must not void the one sent before, or a stranger
 * who asks again and again would keep the owner's mailed link from working. Up to three work at once; the oldest goes first. The
 * table has no "revoked" column, so a voided token is marked used.
 *
 * Side effects: updates `auth_tokens.used_at` of the older unused links (one statement).
 *
 * @param db the database or a transaction
 * @param input the account, the purposes of the family, the time to write, and how many of the newest unused, unexpired links stay
 * @returns how many links were voided
 */
export async function voidUnusedTokensBeyondNewest(
  db: DbExecutor,
  input: {
    readonly subjectType: SubjectType;
    readonly subjectId: number;
    readonly purposes: readonly AuthTokenPurpose[];
    readonly now: Date;
    readonly keep: number;
  },
): Promise<number> {
  const purposes = [...input.purposes];
  const newest = db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.subjectType, input.subjectType),
        eq(authTokens.subjectId, input.subjectId),
        inArray(authTokens.purpose, purposes),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, input.now),
      ),
    )
    .orderBy(desc(authTokens.createdAt), desc(authTokens.id))
    .limit(input.keep);
  const rows = await db
    .update(authTokens)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(authTokens.subjectType, input.subjectType),
        eq(authTokens.subjectId, input.subjectId),
        inArray(authTokens.purpose, purposes),
        isNull(authTokens.usedAt),
        notInArray(authTokens.id, newest),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
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

/**
 * Finds a staff token by its id.
 *
 * Why: the staff mail job gets the token id from the outbox row and checks that the link is still worth sending.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @returns the row, or `undefined`
 */
export async function findStaffTokenById(db: DbExecutor, id: number): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.id, id), eq(authTokens.subjectType, 'staff')))
    .limit(1);
  return row;
}

/**
 * Replaces the secret of a staff link that is still usable, keeping the row.
 *
 * Why: the request makes a placeholder token nobody receives; the mail job rotates it to the token that goes into the mail (feature 12a
 * design). The guard is the usability rule itself (unused, not expired), so a link used or expired since the job read it never gets a new
 * secret. The row id and expiry stay, so the outbox event still names it.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @param tokenHash the keyed hash of the new token
 * @param now the time from the injected clock
 * @returns true when the row was usable and now has the new hash
 */
export async function rotateStaffToken(db: DbExecutor, id: number, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(authTokens)
    .set({ tokenHash, updatedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, 'staff'),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length > 0;
}
