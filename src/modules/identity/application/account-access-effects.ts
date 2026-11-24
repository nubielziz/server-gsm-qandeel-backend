// AccountAccessEffectsService: what a status or a rank change must end or revoke: sessions, links, API keys, and the invitation of an account
// raised to a merchant rank (decision 064). The one implementation of the `AccountAccessEffects` port.
import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../infra/db';
import { AccountDirectory } from '../accounts/account-directory';
import type { RankKind } from '../ports/rank-kind';
import type { ClientStatus } from '../db/schema';
import {
  AccountAccessEffects,
  type RankChangeEffects,
  type StatusChangeEffects,
} from '../ports/account-access-effects';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { AccountSessions } from '../ports/account-sessions';
import { ApiKeyRevocation } from '../ports/api-key-revocation';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';

/** What the effects take of the caller's transaction. */
type Work = Pick<TransactionContext, 'tx' | 'afterCommit'>;

/**
 * Applies the access effects of a status or rank change of an account.
 *
 * Why: decision 064. Every write that changes who may sign in or call the API goes through this one class, so no
 * path forgets a side:
 * - a status that may not act (`suspended`, `blocked`, `anonymized`) ends every session and voids every open link; an erasure also revokes
 *   every live API key; a suspended or blocked account keeps its keys (they answer `ACCOUNT_SUSPENDED`) and works again when the status is
 *   lifted;
 * - a rank change across kinds ends every session (the readable CSRF cookie is named by the kind, so a session cannot outlive the change);
 *   leaving the merchant kind revokes every live API key; an account without a password raised to a merchant rank gets an invitation link and
 *   its mail (a link-only retail account could not sign in to the portal otherwise); inside one kind the cached views are only invalidated.
 * The effects write no audit row: the caller's audit row carries the counts this class returns.
 *
 * Side effects: updates `sessions`, `auth_tokens` and `api_keys`, writes an `outbox_events` row (the invitation), and registers the
 * invalidation of the cached session and API key views to run after the commit.
 *
 * Lock order: the caller already holds the account row (`FOR UPDATE`); the key revocation never takes `api-keys:<accountId>` (the one named
 * exception to the order).
 *
 * @see docs/decisions/064-one-account-type.md
 */
@Injectable()
export class AccountAccessEffectsService extends AccountAccessEffects {
  constructor(
    private readonly sessions: AccountSessions,
    private readonly keys: ApiKeyRevocation,
    private readonly keyViews: ApiKeyDirectory,
    private readonly tokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly directory: AccountDirectory,
  ) {
    super();
  }

  /**
   * Applies a rank change.
   *
   * @param work the caller's transaction (it holds the account row)
   * @param change the account and the kinds it moved between
   * @returns the sessions ended, the keys revoked and whether an invitation was queued
   */
  async rankChanged(
    work: Work,
    change: { readonly accountId: number; readonly fromKind: RankKind; readonly toKind: RankKind },
  ): Promise<RankChangeEffects> {
    const { accountId, fromKind, toKind } = change;
    // The cached views carry the rank kind, so they are dropped after the commit whatever the kinds are.
    this.dropViews(work, accountId);
    if (fromKind === toKind) return { sessionsEnded: 0, keysRevoked: 0, invited: false };
    const sessionsEnded = await this.sessions.revokeAll(work.tx, accountId);
    let keysRevoked = 0;
    if (fromKind === 'merchant') {
      // The cached key views are found by the live keys of the account: read them before the keys are revoked.
      await this.keyViews.invalidateClient(accountId, work);
      keysRevoked = await this.keys.revokeLiveKeysOf(work.tx, accountId);
    }
    const invited = toKind === 'merchant' && (await this.invite(work, accountId));
    return { sessionsEnded, keysRevoked, invited };
  }

  /**
   * Applies a status change.
   *
   * @param work the caller's transaction (it holds the account row)
   * @param change the account and the status it now has
   * @returns the sessions ended and the keys revoked
   */
  async statusChanged(
    work: Work,
    change: { readonly accountId: number; readonly to: ClientStatus },
  ): Promise<StatusChangeEffects> {
    const { accountId, to } = change;
    this.dropViews(work, accountId);
    // A lifted suspension (`active`) only drops the cached views: nothing is restored and nothing is revoked.
    if (to === 'active') return { sessionsEnded: 0, keysRevoked: 0 };
    const sessionsEnded = await this.sessions.revokeAll(work.tx, accountId);
    // A link sent before the change must not work after a reactivation.
    await this.tokens.voidOpenOf(work.tx, accountId);
    let keysRevoked = 0;
    if (to === 'anonymized') {
      await this.keyViews.invalidateClient(accountId, work);
      keysRevoked = await this.keys.revokeLiveKeysOf(work.tx, accountId);
    }
    return { sessionsEnded, keysRevoked };
  }

  /** Drops the cached session views and the cached API key views of the account after the commit. */
  private dropViews(work: Work, accountId: number): void {
    work.afterCommit(() => this.sessions.invalidate(accountId));
    work.afterCommit(async () => {
      await this.keyViews.invalidateClient(accountId);
    });
  }

  /** Queues an invitation for an account that has no password yet; true when one was queued. */
  private async invite(work: Work, accountId: number): Promise<boolean> {
    const account = await this.directory.findById(work.tx, accountId);
    if (!account || !account.hasAccount || account.hasPassword) return false;
    const issued = await this.tokens.issue(work, { accountId, purpose: 'invite' });
    await this.mail.enqueue(work, { kind: 'invited', accountId, tokenId: issued.tokenId });
    return true;
  }
}
