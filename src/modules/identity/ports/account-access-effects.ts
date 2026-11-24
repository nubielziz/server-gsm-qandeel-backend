// The seam from the status and rank changes to what they must end or revoke (decision 064): sessions, API keys and invitations.
import type { TransactionContext } from '../../../infra/db';
import type { RankKind } from './rank-kind';
import type { ClientStatus } from '../db/schema';

/** What a rank change did to the access of the account. */
export interface RankChangeEffects {
  /** How many sessions ended. */
  readonly sessionsEnded: number;
  /** How many live API keys were revoked. */
  readonly keysRevoked: number;
  /** Whether an invitation link was queued (an account without a password raised to a merchant rank). */
  readonly invited: boolean;
}

/** What a status change did to the access of the account. */
export interface StatusChangeEffects {
  readonly sessionsEnded: number;
  readonly keysRevoked: number;
}

/**
 * Applies the access effects of a rank or status change.
 *
 * Why: every write that changes who may sign in or call the API goes through one class, so no path forgets a side (sessions, keys, links).
 * A change across rank kinds ends every session (the readable CSRF cookie is named by the kind, so a session cannot outlive it), a drop
 * from the merchant kind revokes every live key, and a raise queues an invitation for an account that has no password yet.
 *
 * Side effects (of the implementation): updates `sessions` and `api_keys`, writes `auth_tokens` and `outbox_events`; registers the cache
 * invalidations to run after the commit.
 */
export abstract class AccountAccessEffects {
  /**
   * Applies a rank change.
   *
   * @param work the caller's transaction (it holds the account row)
   * @param change the account and the kinds it moved between (equal kinds: the session views are only invalidated)
   * @returns the counts, for the audit row and the answer
   */
  abstract rankChanged(
    work: Pick<TransactionContext, 'tx' | 'afterCommit'>,
    change: { readonly accountId: number; readonly fromKind: RankKind; readonly toKind: RankKind },
  ): Promise<RankChangeEffects>;

  /**
   * Applies a status change (suspend, reactivate, block, anonymize).
   *
   * @param work the caller's transaction (it holds the account row)
   * @param change the account and the status it now has
   * @returns the counts, for the audit row and the answer
   */
  abstract statusChanged(
    work: Pick<TransactionContext, 'tx' | 'afterCommit'>,
    change: { readonly accountId: number; readonly to: ClientStatus },
  ): Promise<StatusChangeEffects>;
}
