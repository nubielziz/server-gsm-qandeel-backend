// AccountPrivacyReadsService: the implementation of the `AccountPrivacyReads` port (decision 064): the privacy facts of an account for
// `GET /admin/clients/:id/privacy`, read over the account row, its latest shop order's consents and its risk assessments.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { documentLabel } from '../domain/consent-documents';
import { AccountPrivacyReads, type AccountPrivacy } from '../ports/account-privacy-reads';
import { findCustomerById } from '../infra/customer.repository';
import { latestConsentEvidence, riskOf } from '../infra/foreign-reads.repository';
import { accountNotFound } from './customer-errors';

/**
 * Reads the privacy facts of an account for staff.
 *
 * Why: the staff detail shows consent evidence and risk signals next to the account (decision 064), but those rows belong to the
 * checkout and risk data of the customers module and identity cannot import it, so identity and the privacy route read them through the
 * `AccountPrivacyReads` port this class implements. For every rank and status: the marketing choice of the account, the consent records
 * written for its latest **shop** order (a merchant's portal and Dhru orders carry none), with the document each names and the address it
 * was given from, and the highest risk score and the signals of its orders (at most 20, newest first).
 *
 * Side effects: none; reads `clients`, `orders`, `consent_records`, `legal_documents` and `risk_assessments`.
 *
 * @see GET /admin/clients/:id/privacy
 */
@Injectable()
export class AccountPrivacyReadsService extends AccountPrivacyReads {
  /**
   * Reads the privacy facts of one account.
   *
   * @param db the database or a transaction
   * @param accountId the account (any rank, any status)
   * @returns the marketing choice, the latest consents and the risk summary
   * @throws {AppError} `NOT_FOUND` (404) when no such account exists
   */
  async privacyOf(db: DbExecutor, accountId: number): Promise<AccountPrivacy> {
    const account = await findCustomerById(db, accountId);
    if (!account) throw accountNotFound();
    // One after the other: `db` may be a transaction, whose single connection runs one query at a time.
    const consents = await latestConsentEvidence(db, accountId);
    const risk = await riskOf(db, accountId);
    return {
      marketingOptIn: account.marketingOptIn,
      latestConsents:
        consents === null
          ? null
          : {
              orderId: consents.orderId,
              records: consents.records.map((record) => ({
                purpose: record.purpose,
                // A consent without a legal document (the withdrawal waiver, marketing) has no label.
                document: documentLabel(record.documentType, record.documentVersion) ?? '',
                at: record.at.toISOString(),
                ip: record.ip,
              })),
            },
      risk: { highestScore: risk.highestScore, signals: risk.signals.map((signal) => ({ ...signal })) },
    };
  }
}
