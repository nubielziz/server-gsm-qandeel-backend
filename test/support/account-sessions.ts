// Sessions of accounts for tests: one session cookie for every rank, and the readable CSRF cookie named by the rank kind (decision 064).
// `openSession` (auth.ts) makes the session the way sign-in does; this file adds what a test of the two URL families needs on top: the
// rank kind of the account, the CSRF cookie name that goes with it, and the cookie header a browser holds after sign-in.
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type RankKind, rankKindOf } from '@src/modules/identity';
import type { SessionStage } from '@src/modules/identity/db/schema';
import type { TestApp } from './app';
import { openSession, type TestSession } from './auth';
import { testDb } from './db';

/** The one session cookie (not secure in tests): the merchant URL family and the storefront URL family both read it. */
export const ACCOUNT_SESSION_COOKIE = 'gsm_client_session';

/** The session cookie the storefront used before accounts became one; it is never read, only cleared (a test sends it to prove that). */
export const LEGACY_STORE_SESSION_COOKIE = 'gsm_store_session';

/** The readable CSRF cookie of each rank kind: the shop picks its API family from the name that is set. */
export const CSRF_COOKIE_BY_KIND: Readonly<Record<RankKind, string>> = {
  merchant: 'csrf_token_client',
  retail: 'csrf_token_store',
};

/**
 * The name of the readable CSRF cookie of a rank kind.
 *
 * @param kind the rank kind of the account
 * @returns `csrf_token_client` for a merchant, `csrf_token_store` for a retail account
 */
export function csrfCookieNameOf(kind: RankKind): string {
  return CSRF_COOKIE_BY_KIND[kind];
}

/** A session of an account, with what its rank adds. */
export interface AccountTestSession extends TestSession {
  readonly accountId: number;
  readonly rankKind: RankKind;
  /** The readable CSRF cookie the sign-in sets for this rank kind. */
  readonly csrfCookieName: string;
  /** The `cookie` header of a browser after sign-in: the session cookie and the readable CSRF cookie. */
  readonly browserCookie: string;
}

/**
 * Reads the rank kind of an account from its rank row.
 *
 * @param accountId the account
 * @returns `merchant` for a merchant rank, `retail` for any other (an unknown kind has retail rights)
 * @throws {Error} when the account does not exist
 */
export async function rankKindOfAccount(accountId: number): Promise<RankKind> {
  const { db } = await testDb();
  const [row] = await db
    .select({ kind: s.clientGroups.kind })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, accountId));
  if (!row) throw new Error(`Account ${accountId} does not exist.`);
  return rankKindOf(row.kind);
}

/**
 * Opens a session for an account (any rank) the way sign-in does, and adds the CSRF cookie of its rank kind.
 *
 * Side effects: inserts a `sessions` row of subject `account`.
 *
 * @param t the running test app
 * @param accountId the account
 * @param options the stage (default `active`) and an optional lifetime in seconds
 * @returns the session with its rank kind and the cookie names
 */
export async function openAccountSession(
  t: TestApp,
  accountId: number,
  options: { readonly stage?: SessionStage; readonly ttlSeconds?: number } = {},
): Promise<AccountTestSession> {
  const [session, rankKind] = await Promise.all([
    openSession(t, { type: 'account', id: accountId }, options),
    rankKindOfAccount(accountId),
  ]);
  const csrfCookieName = csrfCookieNameOf(rankKind);
  return {
    ...session,
    accountId,
    rankKind,
    csrfCookieName,
    browserCookie: `${session.cookie}; ${csrfCookieName}=${session.csrf}`,
  };
}
