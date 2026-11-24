// The seam to the session core (decision 064): the sign-in use cases start and end account sessions through this class and never touch the
// cookies or the session store themselves. Declared here; the session service of the identity module implements it.
import type { FastifyReply } from 'fastify';
import type { Transaction, TransactionContext } from '../../../infra/db';
import type { RankKind } from './rank-kind';
import type { SessionStage } from '../db/schema';

/** What `AccountSessions.start` needs to open a session. */
export interface AccountSessionStart {
  /** The account the session is for. */
  readonly accountId: number;
  /** The step the sign-in has reached: a pending step when a new password or a code is still needed, `active` otherwise. */
  readonly stage: SessionStage;
  /** The rank kind read under the account's lock: it names the readable CSRF cookie (`csrf_token_client` or `csrf_token_store`). */
  readonly rankKind: RankKind;
}

/**
 * Starts and ends the sessions of accounts.
 *
 * Why: one session cookie serves every account (decision 064), and the rank kind picks the readable CSRF cookie that goes with it. The
 * sign-in, link, password and rank-change use cases need exactly three things from the session core, so they depend on this class
 * and the session core stays free to change.
 *
 * Side effects (of the implementation): `start` inserts a `sessions` row and sets the session cookie and the CSRF cookie of the rank
 * kind on the reply (and clears the other CSRF name and the old shop cookie); `revokeAll` updates `sessions`; `invalidate` deletes cache keys.
 */
export abstract class AccountSessions {
  /**
   * Opens a session for an account and sets its cookies.
   *
   * @param work the caller's transaction: the session row commits or rolls back with the sign-in that needs it
   * @param reply the reply the cookies go on
   * @param input the account, the stage reached and the rank kind
   * @returns when the session ends (the cookie's expiry)
   * @throws {RangeError} when the account id is not valid
   */
  abstract start(
    work: Pick<TransactionContext, 'tx' | 'afterCommit'>,
    reply: FastifyReply,
    input: AccountSessionStart,
  ): Promise<{ readonly expiresAt: Date }>;

  /**
   * Ends every live session of an account (a suspension, a rank change that crosses kinds, a password reset, an erasure).
   *
   * @param tx the caller's transaction
   * @param accountId the account
   * @returns how many sessions ended
   */
  abstract revokeAll(tx: Transaction, accountId: number): Promise<number>;

  /**
   * Drops the cached views of an account's sessions so the next request reads the stored state.
   *
   * Why: a session view is cached for a minute; after a change of status, rank or password the caller invalidates it after the commit.
   *
   * @param accountId the account
   */
  abstract invalidate(accountId: number): Promise<void>;
}
