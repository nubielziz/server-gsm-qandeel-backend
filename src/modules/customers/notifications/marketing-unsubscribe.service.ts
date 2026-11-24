// MarketingUnsubscribe: the use case behind the unsubscribe link of a marketing email (customers module, feature 23, plan section 9.6).
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { LegacyAccounts, sessionStateOf } from '../../identity';
import { parseMarketingUnsubscribeToken } from '../../platform';
import { consentRecords } from '../db/schema';
import { insertConsentRecord } from '../infra/consent.repository';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';

/**
 * Switches an account's marketing consent off from an emailed link.
 *
 * Why: O3: every marketing email carries a way out, and the one-click header (`List-Unsubscribe-Post`) makes mailbox providers call the
 * route themselves. The write is the one `CustomerAccountService.updateMe` makes (`marketing_opt_in` false and an immutable consent
 * record of the subject `('account', id)`), so the fan-out's and the send-time consent check (`consentSql`) drop the account at once.
 * Idempotent: an account that already withdrew gets no second record.
 *
 * Old links (decision 064): a token sent before the accounts were merged names an old customer number. It is resolved only
 * through the legacy id map (`LegacyAccounts.resolve('customer', id)`): customer 7 is not account 7, and a number the map does not know
 * changes nothing and answers the same 204. The map class has no state and no arguments, so the service holds one itself.
 *
 * Side effects: updates `clients.marketing_opt_in` and inserts a `consent_records` row, in one transaction under the account's row lock.
 *
 * @see POST /store/v1/marketing/unsubscribe/:token
 */
@Injectable()
export class MarketingUnsubscribe {
  private readonly legacy = new LegacyAccounts();

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Withdraws marketing consent for the account a token names.
   *
   * @param token the text of the link
   * @param meta the caller's address and user agent (they go into the consent record)
   * @throws {AppError} `TOKEN_INVALID` (410) when the token does not verify
   */
  async unsubscribe(token: string, meta: { ip: string; userAgent: string }): Promise<void> {
    const subject = parseMarketingUnsubscribeToken(this.tokens, token);
    if (subject === undefined) throw new AppError('TOKEN_INVALID');
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      // An old customer number is looked up in the map; an account id is the id itself.
      const accountId = subject.kind === 'account' ? subject.id : await this.legacy.resolve(tx, 'customer', subject.id);
      if (accountId === undefined) return;
      const account = await findCustomerById(tx, accountId, true);
      // An unknown or erased account: nothing to change and nothing to tell (the answer is the same 204).
      if (!account || sessionStateOf(account.status) === 'gone') return;
      const [latest] = await tx
        .select({ granted: consentRecords.granted })
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.subjectType, 'account'),
            eq(consentRecords.subjectId, accountId),
            eq(consentRecords.purpose, 'marketing'),
          ),
        )
        .orderBy(desc(consentRecords.createdAt), desc(consentRecords.id))
        .limit(1);
      if (!account.marketingOptIn && latest?.granted !== true) return;
      await insertConsentRecord(tx, {
        subjectType: 'account',
        subjectId: accountId,
        purpose: 'marketing',
        granted: false,
        ip: meta.ip,
        userAgent: meta.userAgent.slice(0, 512),
        createdAt: now,
      });
      await updateCustomerRow(tx, accountId, { marketingOptIn: false, updatedAt: now });
    });
  }
}
