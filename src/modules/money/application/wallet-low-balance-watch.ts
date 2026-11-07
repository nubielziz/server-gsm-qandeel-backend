// WalletLowBalanceWatch: after a posting, writes the outbox event `wallet.low_balance` for each merchant wallet the posting took
// under the merchant's alert threshold (feature 7b).
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { OutboxService, WALLET_LOW_BALANCE_EVENT } from '../../platform';
import { availableOf, crossedBelow, thresholdFrom } from '../domain/low-balance';
import { notificationPrefsOf } from '../infra/foreign-directory.repository';
import type { PostedTransaction } from './post-transaction';

/**
 * Raises the low-balance alert of a merchant's wallet.
 *
 * Why: the map's event `wallet.low_balance`: "the available balance fell below the alert threshold". The ledger writer calls it
 * with what a posting changed; for every `client_wallet` whose available balance (balance plus credit limit) went from at-or-above
 * the merchant's threshold to below it, one `outbox_events` row is written in the posting's own transaction, so the alert exists if
 * and only if the posting committed, and it is sent once per crossing: a wallet that stays under the threshold alerts nothing
 * more until it has been back above it. The row carries the merchant, the currency and the two figures (public to the merchant),
 * and `merchant-webhooks` turns it into deliveries (platform, `WebhookFanOut`).
 *
 * Side effects: reads `clients.notification_prefs` for each wallet a debit touched; inserts `outbox_events` rows.
 *
 * @see docs/queues.md (merchant-webhooks)
 */
@Injectable()
export class WalletLowBalanceWatch {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Checks the wallets a posting changed.
   *
   * @param tx the transaction of the posting
   * @param currency the currency of the posting
   * @param posted what the posting did to each account
   * @returns how many alerts were written
   */
  async afterPosting(tx: DbExecutor, currency: string, posted: PostedTransaction): Promise<number> {
    let written = 0;
    for (const account of posted.touched) {
      if (account.kind !== 'client_wallet' || account.ownerType !== 'client' || account.ownerId === null) continue;
      const before = Money.of(account.before);
      const after = Money.of(account.after);
      // Only a debit can take a wallet under a threshold: credits and unchanged wallets skip the preferences read.
      if (after.cmp(before) >= 0) continue;
      const threshold = thresholdFrom(await notificationPrefsOf(tx, account.ownerId));
      if (!threshold) continue;
      const limit = Money.of(account.overdraftLimit);
      if (!crossedBelow(availableOf(before, limit), availableOf(after, limit), threshold)) continue;
      await this.outbox.add(tx, {
        type: WALLET_LOW_BALANCE_EVENT,
        aggregateType: 'ledger_accounts',
        aggregateId: account.accountId,
        payload: {
          clientId: account.ownerId,
          currency,
          available: availableOf(after, limit).toWire(),
          threshold: threshold.toWire(),
        },
      });
      written += 1;
    }
    return written;
  }
}
