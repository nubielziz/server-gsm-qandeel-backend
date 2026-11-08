// Drizzle queries on `auth_tokens` for the one-time links of storefront customers: sign-in links, invitations, password reset
// links and email verification. Only keyed hashes are stored; inserting a row reuses the generic function of auth-token.repository.ts.
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AuthToken, authTokens } from '../db/schema';

/**
 * The purposes a customer's one-time token can have: all four of the closed `auth_tokens.purpose` list.
 *
 * Why: feature 14b: `magic_link` (sign in by email), `invite` (staff created the account), `reset` (forgot password or staff
 * sent a link) and `verify_email` (the address changed on an account).
 */
export const CUSTOMER_TOKEN_PURPOSES = ['magic_link', 'invite', 'reset', 'verify_email'] as const;

/** One value of {@link CUSTOMER_TOKEN_PURPOSES}. */
export type CustomerTokenPurpose = (typeof CUSTOMER_TOKEN_PURPOSES)[number];

/**
 * The purposes whose links end in choosing a password.
 *
 * Why: a newer reset or invite replaces an older one (newest wins), and choosing a password uses up every one of them.
 */
export const CUSTOMER_PASSWORD_LINK_PURPOSES = ['invite', 'reset'] as const satisfies readonly CustomerTokenPurpose[];

/**
 * Finds a customer token by its hash.
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token from the link
 * @returns the row (used or not), or `undefined`
 */
export async function findCustomerTokenByHash(db: DbExecutor, tokenHash: string): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.subjectType, 'customer')))
    .limit(1);
  return row;
}

/**
 * Finds a customer token by its id.
 *
 * Why: the mail job gets the token id and checks that the link is still worth sending.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @returns the row, or `undefined`
 */
export async function findCustomerTokenById(db: DbExecutor, id: number): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.id, id), eq(authTokens.subjectType, 'customer')))
    .limit(1);
  return row;
}

/**
 * Marks a customer token used, but only if it is still unused and not expired.
 *
 * Why: the guarded `UPDATE` makes the link single-use across API instances: of two simultaneous requests with the same link
 * only one gets the row back (decision 019).
 *
 * @param db the database or a transaction
 * @param id the token id
 * @param now the time of use
 * @returns the consumed row, or `undefined` when it was used, expired or is not a customer's
 */
export async function consumeCustomerToken(db: DbExecutor, id: number, now: Date): Promise<AuthToken | undefined> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, 'customer'),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/**
 * Replaces the secret of a customer link that is still usable, keeping the row.
 *
 * Why: feature 14b, as feature 12a did for merchants: the request makes a placeholder token that nobody receives (the clear value is
 * not kept), and the mail job rotates it to the token that goes into the mail. The guard is the usability rule itself (unused, not
 * expired), so a link that was used, voided or has expired since the job read it is never given a new secret; the row id and expiry
 * stay, so the outbox event still names it.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @param tokenHash the keyed hash of the new token
 * @param now the time from the injected clock
 * @returns true when the row was usable and now has the new hash
 */
export async function rotateCustomerToken(db: DbExecutor, id: number, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(authTokens)
    .set({ tokenHash, updatedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, 'customer'),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length > 0;
}

/**
 * Voids every unused token of a customer with one of the given purposes, optionally keeping one.
 *
 * Why: only the newest link of a kind works, and a used link voids the others. The table has no "revoked" column, so a voided
 * token is marked used.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @param purposes the kinds of link to void
 * @param now the time to write
 * @param exceptId a token to keep
 * @returns how many tokens were voided
 */
export async function voidOpenCustomerTokens(
  db: DbExecutor,
  customerId: number,
  purposes: readonly CustomerTokenPurpose[],
  now: Date,
  exceptId?: number,
): Promise<number> {
  const rows = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.subjectType, 'customer'),
        eq(authTokens.subjectId, customerId),
        inArray(authTokens.purpose, [...purposes]),
        isNull(authTokens.usedAt),
        exceptId === undefined ? undefined : ne(authTokens.id, exceptId),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}

/**
 * Reads when the newest token of the given purposes was created.
 *
 * Why: the customer detail's `resetSentAt` is "when the latest invitation or reset link went out" (customers.md).
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @param purposes the kinds of link to look at
 * @returns the creation time of the newest one, or `null` when there is none
 */
export async function latestCustomerTokenAt(
  db: DbExecutor,
  customerId: number,
  purposes: readonly CustomerTokenPurpose[],
): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: authTokens.createdAt })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.subjectType, 'customer'),
        eq(authTokens.subjectId, customerId),
        inArray(authTokens.purpose, [...purposes]),
      ),
    )
    .orderBy(desc(authTokens.createdAt), desc(authTokens.id))
    .limit(1);
  return row?.createdAt ?? null;
}
