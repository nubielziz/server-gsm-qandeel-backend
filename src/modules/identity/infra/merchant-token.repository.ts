// Drizzle queries on `auth_tokens` for the one-time links of merchants: email verification, password reset and invitation.
// Only keyed hashes are stored; inserting and consuming a row reuse the generic functions of auth-token.repository.ts.
import { and, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type AuthToken, authTokens } from '../db/schema';

/**
 * The purposes a merchant's one-time token can have: the merchant subset of the closed `auth_tokens.purpose` list.
 *
 * Why: resolution identity-platform-2: `verify_email` (register), `reset` (forgot password) and `invite` (staff created the
 * merchant); `magic_link` belongs to storefront customers.
 */
export const CLIENT_TOKEN_PURPOSES = ['verify_email', 'reset', 'invite'] as const;

/** One value of {@link CLIENT_TOKEN_PURPOSES}. */
export type ClientTokenPurpose = (typeof CLIENT_TOKEN_PURPOSES)[number];

/**
 * The purposes whose links end in choosing a password.
 *
 * Why: a newer reset or invite replaces an older one (newest wins), and choosing a password uses up every one of them.
 */
export const PASSWORD_LINK_PURPOSES = ['reset', 'invite'] as const satisfies readonly ClientTokenPurpose[];

/**
 * Finds a merchant token by its hash.
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token from the link
 * @returns the row (used or not), or `undefined`
 */
export async function findClientTokenByHash(db: DbExecutor, tokenHash: string): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.subjectType, 'client')))
    .limit(1);
  return row;
}

/**
 * Finds a merchant token by its id.
 *
 * Why: the mail job gets the token id and checks that the link is still worth sending.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @returns the row, or `undefined`
 */
export async function findClientTokenById(db: DbExecutor, id: number): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.id, id), eq(authTokens.subjectType, 'client')))
    .limit(1);
  return row;
}

/**
 * Voids every unused token of a merchant with one of the given purposes, optionally keeping one.
 *
 * Why: only the newest link of a kind works, and a used link voids the others. The table has no "revoked" column, so a voided
 * token is marked used.
 *
 * @param db the database or a transaction
 * @param clientId the merchant id
 * @param purposes the kinds of link to void
 * @param now the time to write
 * @param exceptId a token to keep
 * @returns how many tokens were voided
 */
export async function voidOpenClientTokens(
  db: DbExecutor,
  clientId: number,
  purposes: readonly ClientTokenPurpose[],
  now: Date,
  exceptId?: number,
): Promise<number> {
  const rows = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.subjectType, 'client'),
        eq(authTokens.subjectId, clientId),
        inArray(authTokens.purpose, [...purposes]),
        isNull(authTokens.usedAt),
        exceptId === undefined ? undefined : ne(authTokens.id, exceptId),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}

/**
 * Replaces the secret of a link that is still usable, keeping the row.
 *
 * Why: feature 12a: the request makes a placeholder token that nobody receives (the clear value is not kept), and the mail job rotates it
 * to the token that goes into the mail. The guard is the usability rule itself (unused, not expired), so a link that was used or has
 * expired since the job read it is never given a new secret; the row id and expiry stay, so the outbox event still names it.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @param tokenHash the keyed hash of the new token
 * @param now the time from the injected clock
 * @returns true when the row was usable and now has the new hash
 */
export async function rotateClientToken(db: DbExecutor, id: number, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(authTokens)
    .set({ tokenHash, updatedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, 'client'),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length > 0;
}
