// ConsentService: records the consents of a checkout session as proof (feature 14a, RESOLUTIONS b2c-12 and b2c-14): the purpose,
// the version of the legal text, the time and the buyer's IP. Records are append only.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { BodyOf, ResultOf } from '../../../common/contract';
import { type FieldError, AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AccountDirectory, type AccountRecord } from '../../identity';
import { CurrentLegalDocuments, StorefrontPolicies, type LegalDocumentRef } from '../../storefront';
import type { recordCheckoutConsents } from '../contracts/checkout.contracts';
import type { ConsentPurpose, ConsentRecord, NewConsentRecord } from '../db/schema';
import {
  LEGAL_TYPE_OF_PURPOSE,
  MAX_USER_AGENT_LENGTH,
  consentOf,
  consentState,
  effectiveStatus,
  requiredConsents,
} from '../domain/checkout';
import { lockCheckoutSession, setGuestMarketingOptIn } from '../infra/checkout.repository';
import { insertConsents, listSessionConsents } from '../infra/consent.repository';
import { setMarketingOptIn } from '../infra/customer.repository';

type Body = BodyOf<typeof recordCheckoutConsents>;

/** What the route answers. */
export type RecordedConsents = ResultOf<typeof recordCheckoutConsents>;

/** Who is consenting and from where. */
export interface ConsentOrigin {
  readonly ip: string;
  readonly userAgent: string;
}

/**
 * Records consents.
 *
 * Why: the map's `POST /store/v1/checkout-sessions/:token/consents` and scenario b2c-paid step 2: the buyer agrees to the terms, the
 * privacy policy and the waiver of the withdrawal right to have the service started at once, and the shop keeps proof (the version
 * of the text, the time, the IP) for a chargeback (scenario b2c-chargeback step 4). The proof is never overwritten: a withdrawal
 * is a new row with `granted = false`, and the latest row of a purpose decides. The subject of every record is the account of the session,
 * `('account', session.account_id)` (decision 064): the signed-in retail account that opened it, or the guest row of the
 * typed email, which never is the login account of that email, so no consent of a checkout typed with someone's email lands on
 * that someone. The row is never made here: the session always has its account since it was opened. A checkout of a row with a login
 * proves the purchase only: `marketing` is not recorded (the account page owns that choice) and is left out of the answer. The
 * exception is the account holder themself: a request with the signed-in session of the session's own account (cookie and CSRF token
 * checked by the caller) may record `marketing` too, and then the account's `marketing_opt_in` follows the answer, as it does on the
 * account page. Decision 053: a guest row's marketing answer is recorded as proof and sets the switch, but it counts only once the address
 * is proven (`consentSql`: a sign-in or verification link was used, an invitation was accepted, or a checkout of the row was paid), because
 * anyone can type an address at a checkout.
 *
 * Side effects: inserts `consent_records` rows (one per changed purpose) in one transaction, with the session row locked; the
 * account's `marketing_opt_in` follows its recorded marketing answer (a guest row's, or the signed-in owner's).
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: DbService,
    private readonly legal: CurrentLegalDocuments,
    private readonly policies: StorefrontPolicies,
    private readonly accounts: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Records the consents of a session.
   *
   * @param sessionId the session the token resolved to
   * @param body the purposes with their answers
   * @param origin the visitor's address and user agent
   * @param signedInAccountId the retail account the request is signed in as, when it carries a usable account session
   * @returns the record of each purpose sent and where the session's consent now stands
   * @throws {AppError} `NOT_FOUND` when the session no longer exists; `INVALID_TRANSITION` when it is paid or expired;
   *   `VALIDATION_FAILED` for a purpose listed twice or one whose document is not published
   */
  async record(
    sessionId: number,
    body: Body,
    origin: ConsentOrigin,
    signedInAccountId?: number,
  ): Promise<RecordedConsents> {
    const purposes = body.consents.map((item) => item.purpose);
    const duplicate = purposes.findIndex((purpose, index) => purposes.indexOf(purpose) !== index);
    if (duplicate >= 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: `consents.${duplicate}.purpose`, code: 'duplicate', message: 'List each purpose once.' }],
      });
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const session = await lockCheckoutSession(tx, sessionId);
      if (!session) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
      const now = this.clock.now();
      if (effectiveStatus(session.status, session.expiresAt, now) !== 'open') {
        throw new AppError('INVALID_TRANSITION', { detail: 'This checkout is no longer open.' });
      }
      const account = await this.accountOf(tx, session.accountId);
      // An account holder's marketing choice is changed only by the holder (the signed-in session of this very account), never
      // by a request that merely typed the account's email.
      const isOwner = signedInAccountId === account.id;
      const consents = body.consents.filter((item) => item.purpose !== 'marketing' || !account.hasAccount || isOwner);

      const documents = new Map<ConsentPurpose, LegalDocumentRef | null>();
      const problems: FieldError[] = [];
      for (const [index, item] of body.consents.entries()) {
        if (!consents.includes(item)) continue;
        const type = LEGAL_TYPE_OF_PURPOSE[item.purpose];
        if (type === null) {
          documents.set(item.purpose, null);
          continue;
        }
        // The version in force of the type: one per type, and English (decision 039).
        const document = await this.legal.current(tx, type);
        if (document === undefined) {
          problems.push({
            field: `consents.${index}.purpose`,
            code: 'no_document',
            message: 'There is no published text to agree to yet.',
          });
        } else {
          documents.set(item.purpose, document);
        }
      }
      if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { errors: problems });

      const existing = await listSessionConsents(tx, session.id);
      const latest = new Map<ConsentPurpose, ConsentRecord>();
      // `existing` is newest first, so the first record of a purpose is its latest.
      for (const record of existing) if (!latest.has(record.purpose)) latest.set(record.purpose, record);

      const toInsert: NewConsentRecord[] = [];
      const kept = new Map<ConsentPurpose, ConsentRecord>();
      for (const item of consents) {
        const document = documents.get(item.purpose) ?? null;
        const before = latest.get(item.purpose);
        // Sending the same answer for the same text again is a retry, not a new proof.
        if (before && before.granted === item.granted && before.legalDocumentId === (document?.id ?? null)) {
          kept.set(item.purpose, before);
          continue;
        }
        toInsert.push({
          subjectType: 'account',
          subjectId: account.id,
          legalDocumentId: document?.id ?? null,
          purpose: item.purpose,
          granted: item.granted,
          checkoutSessionId: session.id,
          ip: origin.ip,
          userAgent: origin.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
          createdAt: now,
        });
      }
      const inserted = await insertConsents(tx, toInsert);
      const marketing = inserted.find((row) => row.purpose === 'marketing');
      if (marketing) {
        if (isOwner) await setMarketingOptIn(tx, account.id, marketing.granted, now);
        else await setGuestMarketingOptIn(tx, account.id, marketing.granted, now);
      }
      const byPurpose = new Map<ConsentPurpose, ConsentRecord>([
        ...kept,
        ...inserted.map((row) => [row.purpose, row] as const),
      ]);

      const switches = await this.policies.switches(tx);
      const all = [...inserted, ...existing];
      return {
        records: consents.flatMap((item) => {
          const record = byPurpose.get(item.purpose);
          const document = documents.get(item.purpose) ?? null;
          return record === undefined
            ? []
            : [
                {
                  purpose: record.purpose,
                  granted: record.granted,
                  document: document === null ? null : { type: document.type, version: document.version },
                  recordedAt: record.createdAt.toISOString(),
                },
              ];
        }),
        consent: consentOf(consentState(all, requiredConsents(switches.withdrawalWaiver))),
      };
    });
  }

  /**
   * The account the consents belong to: the account of the session.
   *
   * Why: decision 064: the guest creation of the old code goes. Every session is opened with its account (the signed-in retail account or the
   * guest row of the typed email), so a session without one is a link that opens nothing.
   *
   * @throws {AppError} `NOT_FOUND` for a session without an account
   * @throws {Error} when the account row is missing (the foreign key makes it impossible)
   */
  private async accountOf(tx: DbExecutor, accountId: number | null): Promise<AccountRecord> {
    if (accountId === null) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    const account = await this.accounts.findById(tx, accountId);
    if (!account) throw new Error('The account of a checkout session is missing.');
    return account;
  }
}
