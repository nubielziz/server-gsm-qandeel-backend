// AccountMailOutboxService: writes the outbox events of the account link mails (ids only) and registers their queue routes (decision 064).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TransactionContext } from '../../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../../platform';
import { RankGroupReads } from '../../../catalog/ports/rank-group-reads';
import { AccountDirectory } from '../../accounts/account-directory';
import { ACCOUNT_MAIL_EVENT_TYPES, accountMailEventOf } from '../../domain/account-mail';
import { NO_ACCOUNT_ID } from '../../domain/public-links';
import { AccountMailOutbox, type AccountMailKind } from '../../ports/account-mail-outbox';

/** A rank id no rank has: the run of an email that gets no mail reads it where a found account reads its own rank. */
const NO_RANK_ID = 0;

/**
 * Writes the outbox row of an account's link mail.
 *
 * Why: decision 020: an email is async work, so the use case writes `outbox_events` in its own transaction and the worker's relay turns it
 * into a `notifications` job. The row carries the account id and the `auth_tokens` id, never the token: the job that sends the mail makes
 * the clear token itself (`AccountMailJobs`), so no clear token is ever stored or logged.
 *
 * Side effects: registers the nine event types with the `notifications` queue at boot (the API and the worker both load this class);
 * `enqueue` takes a `FOR KEY SHARE` lock on the account row (so a rank change cannot slip between the choice of the family and the commit),
 * reads the rank kind (of the account, or of no rank for the id of a run that is rolled back) and inserts one `outbox_events` row.
 */
@Injectable()
export class AccountMailOutboxService extends AccountMailOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
    private readonly accounts: AccountDirectory,
    private readonly ranks: RankGroupReads,
  ) {
    super();
  }

  /** Registers the nine event types with their queue. */
  onModuleInit(): void {
    for (const type of ACCOUNT_MAIL_EVENT_TYPES) this.routes.register({ type, queue: 'notifications' });
  }

  /**
   * Writes the event of one mail in the caller's transaction.
   *
   * @param work the caller's transaction
   * @param mail the kind, the account and the `auth_tokens` row of the link (the placeholder the mail job rotates)
   * @returns once the event is written
   * @throws {Error} when the account is gone (other than the id of a run that is rolled back on purpose) or the kind is a sign-in link for a
   *   merchant rank
   */
  async enqueue(
    work: Pick<TransactionContext, 'tx'>,
    mail: { readonly kind: AccountMailKind; readonly accountId: number; readonly tokenId?: number },
  ): Promise<void> {
    const account = await this.accounts.lockForKeyShare(work.tx, mail.accountId);
    if (account === undefined) {
      if (mail.accountId !== NO_ACCOUNT_ID) {
        throw new Error(`Account ${mail.accountId} does not exist: no ${mail.kind} mail can be queued.`);
      }
      // A request for an email that gets no mail runs the same statements on an id no account has, then rolls back (decision 052, rule
      // seven): the directory read the rank of a row it found, so this run reads the rank table once too, and the retail family exists
      // for every kind.
      await this.ranks.kindOf(work.tx, NO_RANK_ID);
    }
    await this.outbox.add(work.tx, {
      type: accountMailEventOf(account?.rankKind ?? 'retail', mail.kind),
      aggregateType: 'clients',
      aggregateId: mail.accountId,
      payload: { accountId: mail.accountId, ...(mail.tokenId === undefined ? {} : { tokenId: mail.tokenId }) },
    });
  }
}
