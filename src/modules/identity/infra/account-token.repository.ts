// Drizzle queries on `auth_tokens` for the one-time links of accounts: invitations, password resets, email verification and the sign-in
// link (decision 064). One repository for every rank: a row's subject type is `account` and nothing else is read or written here.
// Only keyed hashes are stored; inserting a row reuses the generic function of auth-token.repository.ts.
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { DbExecutor, Transaction } from '../../../infra/db';
import { type AuthToken, authTokens } from '../db/schema';
import type { AccountTokenPurpose } from '../ports/account-auth-tokens';

/**
 * The purposes whose links end in choosing a password.
 *
 * Why: a newer reset or invite replaces an older one (newest wins), and choosing a password uses up every one of them.
 */
export const PASSWORD_LINK_PURPOSES = ['invite', 'reset'] as const satisfies readonly AccountTokenPurpose[];

/** The subject type every link of an account is stored with: the one word of decision 064. */
const ACCOUNT = 'account' as const;

/**
 * Finds the link of a token and locks its row, only when the link can still be used.
 *
 * Why: a flow that spends a link locks it first, so two requests with the same link cannot both pass the checks that follow (decision
 * 019). A link of another subject type, of another purpose, used or expired is not found, so the caller answers one `TOKEN_INVALID`.
 *
 * Side effects: takes a row lock that lasts until the caller's transaction ends.
 *
 * @param tx the caller's transaction
 * @param input the keyed hash of the token, the purposes the flow accepts and the time from the injected clock
 * @returns the row, or `undefined`
 */
export async function lockUsableAccountToken(
  tx: Transaction,
  input: { readonly tokenHash: string; readonly purposes: readonly AccountTokenPurpose[]; readonly now: Date },
): Promise<AuthToken | undefined> {
  const [row] = await tx
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, input.tokenHash),
        eq(authTokens.subjectType, ACCOUNT),
        inArray(authTokens.purpose, [...input.purposes]),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, input.now),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds an account's token by its hash.
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token from the link
 * @returns the row (used or not), or `undefined`
 */
export async function findAccountTokenByHash(db: DbExecutor, tokenHash: string): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.subjectType, ACCOUNT)))
    .limit(1);
  return row;
}

/**
 * Finds an account's token by its id.
 *
 * Why: the mail job gets the token id from the outbox row and checks that the link is still worth sending. A row of another subject type
 * is not an account's link, whatever its `subject_id` is.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @returns the row, or `undefined`
 */
export async function findAccountTokenById(db: DbExecutor, id: number): Promise<AuthToken | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.id, id), eq(authTokens.subjectType, ACCOUNT)))
    .limit(1);
  return row;
}

/**
 * Marks an account's token used, but only if it is still unused and not expired.
 *
 * Why: the guarded `UPDATE` makes the link single-use across API instances: of two simultaneous requests with the same link only one
 * gets the row back (decision 019).
 *
 * @param db the database or a transaction
 * @param id the token id
 * @param now the time of use
 * @returns the consumed row, or `undefined` when it was used, expired, gone or is not an account's
 */
export async function consumeAccountToken(db: DbExecutor, id: number, now: Date): Promise<AuthToken | undefined> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, ACCOUNT),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/**
 * Replaces the secret of a link that is still usable, keeping the row.
 *
 * Why: the request makes a placeholder token that nobody receives (the clear value is not kept, decision 019), and the mail job rotates
 * it to the token that goes into the mail. The guard is the usability rule itself (unused, not expired), so a link used, voided or expired
 * since the job read it never gets a new secret; the row id and expiry stay, so the outbox event still names it.
 *
 * Side effects: updates `auth_tokens.token_hash` and `updated_at` of the row.
 *
 * @param db the database or a transaction
 * @param id the `auth_tokens` id
 * @param tokenHash the keyed hash of the new token
 * @param now the time from the injected clock
 * @returns true when the row was usable and now has the new hash
 */
export async function rotateAccountToken(db: DbExecutor, id: number, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(authTokens)
    .set({ tokenHash, updatedAt: now })
    .where(
      and(
        eq(authTokens.id, id),
        eq(authTokens.subjectType, ACCOUNT),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length > 0;
}

/**
 * Voids every unused link of an account with one of the given purposes, optionally keeping one.
 *
 * Why: only the newest link of a family works, and a used link voids the others. The table has no "revoked" column, so a voided token is
 * marked used.
 *
 * Side effects: updates `auth_tokens.used_at` of the open links (one statement).
 *
 * @param db the database or a transaction
 * @param accountId the account (or guest row) id
 * @param purposes the kinds of link to void
 * @param now the time to write
 * @param exceptId a token to keep
 * @returns how many links were voided
 */
export async function voidOpenAccountTokens(
  db: DbExecutor,
  accountId: number,
  purposes: readonly AccountTokenPurpose[],
  now: Date,
  exceptId?: number,
): Promise<number> {
  const rows = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.subjectType, ACCOUNT),
        eq(authTokens.subjectId, accountId),
        inArray(authTokens.purpose, [...purposes]),
        isNull(authTokens.usedAt),
        exceptId === undefined ? undefined : ne(authTokens.id, exceptId),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}

/**
 * Reads when the newest link of the given purposes was created for an account.
 *
 * Why: the admin detail's "link sent at" is when the latest invitation or reset link went out.
 *
 * @param db the database or a transaction
 * @param accountId the account id
 * @param purposes the kinds of link to look at
 * @returns the creation time of the newest one, or `null` when there is none
 */
export async function latestAccountTokenAt(
  db: DbExecutor,
  accountId: number,
  purposes: readonly AccountTokenPurpose[],
): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: authTokens.createdAt })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.subjectType, ACCOUNT),
        eq(authTokens.subjectId, accountId),
        inArray(authTokens.purpose, [...purposes]),
      ),
    )
    .orderBy(desc(authTokens.createdAt), desc(authTokens.id))
    .limit(1);
  return row?.createdAt ?? null;
}
