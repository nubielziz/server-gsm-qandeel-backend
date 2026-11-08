// ConsentService: records the consents of a checkout session as proof (feature 14a, RESOLUTIONS b2c-12 and b2c-14): the purpose,
// the version of the legal text, the time and the buyer's IP. Records are append only.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { BodyOf, ResultOf } from '../../../common/contract';
import { type FieldError, AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { CurrentLegalDocuments, FALLBACK_LOCALE, StorefrontPolicies, type LegalDocumentRef } from '../../storefront';
import type { recordCheckoutConsents } from '../contracts/checkout.contracts';
import type { ConsentPurpose, ConsentRecord, Customer, NewConsentRecord } from '../db/schema';
import {
  LEGAL_TYPE_OF_PURPOSE,
  MAX_USER_AGENT_LENGTH,
  consentOf,
  consentState,
  effectiveStatus,
  requiredConsents,
} from '../domain/checkout';
import {
  insertGuestCustomer,
  lockCheckoutSession,
  setGuestMarketingOptIn,
  setSessionCustomer,
} from '../infra/checkout.repository';
import { insertConsents, listSessionConsents } from '../infra/consent.repository';
import { findCustomerByEmail, findCustomerById, setMarketingOptIn } from '../infra/customer.repository';

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
 * is a new row with `granted = false`, and the latest row of a purpose decides. A guest checkout proves the purchase only: when its
 * email belongs to an account, `marketing` is not recorded (anyone can type someone else's email; the account page owns that
 * choice) and is left out of the answer. The exception is the account holder themself: a request with the signed-in session of
 * the session's own customer (cookie and CSRF token checked by the caller) may record `marketing` too, and then the account's
 * `marketing_opt_in` follows the answer, as it does on the account page.
 *
 * Side effects: inserts `consent_records` rows (one per changed purpose) in one transaction, with the session row locked; the
 * customer's `marketing_opt_in` follows its recorded marketing answer (a guest's, or the signed-in owner's).
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: DbService,
    private readonly legal: CurrentLegalDocuments,
    private readonly policies: StorefrontPolicies,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Records the consents of a session.
   *
   * @param sessionId the session the token resolved to
   * @param body the purposes with their answers and the language of the texts
   * @param origin the visitor's address and user agent
   * @param signedInCustomerId the customer the request is signed in as, when it carries a usable customer session
   * @returns the record of each purpose sent and where the session's consent now stands
   * @throws {AppError} `NOT_FOUND` when the session no longer exists; `INVALID_TRANSITION` when it is paid or expired;
   *   `VALIDATION_FAILED` for a purpose listed twice or one whose document is not published
   */
  async record(
    sessionId: number,
    body: Body,
    origin: ConsentOrigin,
    signedInCustomerId?: number,
  ): Promise<RecordedConsents> {
    const purposes = body.consents.map((item) => item.purpose);
    const duplicate = purposes.findIndex((purpose, index) => purposes.indexOf(purpose) !== index);
    if (duplicate >= 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: `consents.${duplicate}.purpose`, code: 'duplicate', message: 'List each purpose once.' }],
      });
    }
    const locale = body.locale ?? FALLBACK_LOCALE;

    return this.db.runInTransaction(async ({ tx }) => {
      const session = await lockCheckoutSession(tx, sessionId);
      if (!session) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
      const now = this.clock.now();
      if (effectiveStatus(session.status, session.expiresAt, now) !== 'open') {
        throw new AppError('INVALID_TRANSITION', { detail: 'This checkout is no longer open.' });
      }
      const customer = await this.customerOf(tx, session.id, session.customerId, session.email, now);
      // An account holder's marketing choice is changed only by the holder (the signed-in session of this very customer), never
      // by a request that merely typed the account's email.
      const isOwner = signedInCustomerId === customer.id;
      const consents = body.consents.filter((item) => item.purpose !== 'marketing' || !customer.hasAccount || isOwner);

      const documents = new Map<ConsentPurpose, LegalDocumentRef | null>();
      const problems: FieldError[] = [];
      for (const [index, item] of body.consents.entries()) {
        if (!consents.includes(item)) continue;
        const type = LEGAL_TYPE_OF_PURPOSE[item.purpose];
        if (type === null) {
          documents.set(item.purpose, null);
          continue;
        }
        const document = await this.legal.current(tx, type, locale);
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
          subjectType: 'customer',
          subjectId: customer.id,
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
        if (isOwner) await setMarketingOptIn(tx, customer.id, marketing.granted, now);
        else await setGuestMarketingOptIn(tx, customer.id, marketing.granted, now);
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
                  document:
                    document === null
                      ? null
                      : { type: document.type, version: document.version, locale: document.locale },
                  recordedAt: record.createdAt.toISOString(),
                },
              ];
        }),
        consent: consentOf(consentState(all, requiredConsents(switches.withdrawalWaiver))),
      };
    });
  }

  /**
   * The customer the consents belong to: the session's own, or, for a session made without one, the customer of its email
   * (created as a guest when new) linked to the session, so every consent has a subject.
   */
  private async customerOf(
    tx: DbExecutor,
    sessionId: number,
    customerId: number | null,
    email: string,
    now: Date,
  ): Promise<Customer> {
    if (customerId !== null) {
      const linked = await findCustomerById(tx, customerId);
      if (!linked) throw new Error('The customer of a checkout session is missing.');
      return linked;
    }
    const found: Customer | undefined =
      (await findCustomerByEmail(tx, email)) ??
      (await insertGuestCustomer(tx, { email, hasAccount: false, status: 'active', createdAt: now, updatedAt: now })) ??
      (await findCustomerByEmail(tx, email));
    if (!found) throw new Error('A guest customer was neither created nor found.');
    await setSessionCustomer(tx, sessionId, found.id, now);
    return found;
  }
}
