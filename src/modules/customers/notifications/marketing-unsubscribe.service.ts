// MarketingUnsubscribe: the use case behind the unsubscribe link of a marketing email (customers module, feature 23, plan section 9.6).
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { parseMarketingUnsubscribeToken } from '../../platform';
import { consentRecords } from '../db/schema';
import { insertConsentRecord } from '../infra/consent.repository';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';

/**
 * Switches a customer's marketing consent off from an emailed link.
 *
 * Why: O3: every marketing email carries a way out, and the one-click header (`List-Unsubscribe-Post`) makes mailbox providers call the
 * route themselves. The write is the one `CustomerAccountService.updateMe` makes (`marketing_opt_in` false and an immutable consent
 * record), so the fan-out's and the send-time consent check (`consentSql`) drop the customer at once. Idempotent: a customer who already
 * withdrew gets no second record.
 *
 * Side effects: updates `customers.marketing_opt_in` and inserts a `consent_records` row, in one transaction under the customer's row lock.
 *
 * @see POST /store/v1/marketing/unsubscribe/:token
 */
@Injectable()
export class MarketingUnsubscribe {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Withdraws marketing consent for the customer a token names.
   *
   * @param token the text of the link
   * @param meta the caller's address and user agent (they go into the consent record)
   * @throws {AppError} `TOKEN_INVALID` (410) when the token does not verify
   */
  async unsubscribe(token: string, meta: { ip: string; userAgent: string }): Promise<void> {
    const customerId = parseMarketingUnsubscribeToken(this.tokens, token);
    if (customerId === undefined) throw new AppError('TOKEN_INVALID');
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const customer = await findCustomerById(tx, customerId, true);
      // An unknown or erased customer: nothing to change and nothing to tell (the answer is the same 204).
      if (!customer || customer.status === 'anonymized') return;
      const [latest] = await tx
        .select({ granted: consentRecords.granted })
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.subjectType, 'customer'),
            eq(consentRecords.subjectId, customerId),
            eq(consentRecords.purpose, 'marketing'),
          ),
        )
        .orderBy(desc(consentRecords.createdAt), desc(consentRecords.id))
        .limit(1);
      if (!customer.marketingOptIn && latest?.granted !== true) return;
      await insertConsentRecord(tx, {
        subjectType: 'customer',
        subjectId: customerId,
        purpose: 'marketing',
        granted: false,
        ip: meta.ip,
        userAgent: meta.userAgent.slice(0, 512),
        createdAt: now,
      });
      await updateCustomerRow(tx, customerId, { marketingOptIn: false, updatedAt: now });
    });
  }
}
