// CustomerAccountService: the use cases of GET and PATCH /store/v1/me and GET /store/v1/me/orders (map domain I, stage 14): the
// signed-in customer's own account and orders.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { CustomerPrincipal, RequestMeta } from '../../identity';
import type { CustomerLocale } from '../domain/customer-input';
import { findCredentials } from '../infra/customer-credentials.repository';
import { findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import { currencyByCode, listCustomerOrders } from '../infra/foreign-reads.repository';
import { insertConsentRecord } from '../infra/consent.repository';
import { type WireStoreMe, type WireStoreOrder, toStoreMe, toStoreOrder } from './customer-views';

/** What `PATCH /store/v1/me` may change. */
export interface UpdateMeInput {
  readonly locale?: CustomerLocale | undefined;
  readonly currency?: string | undefined;
  readonly marketingOptIn?: boolean | undefined;
}

/**
 * Serves the signed-in customer's account.
 *
 * Why: the storefront account page shows the details and lets the customer choose language, currency and marketing consent
 * (map: "Change language, currency and marketing consent"). A consent is proof: a change writes a `consent_records` row with the
 * request address and time, and a withdrawn consent is a new row with `granted = false` (RESOLUTIONS b2c-12, b2c-14). The
 * customer reads only their own orders: the id comes from the session.
 *
 * Side effects: `updateMe` writes `customers` and, when the marketing choice changed, `consent_records`.
 */
@Injectable()
export class CustomerAccountService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Describes the signed-in customer.
   *
   * @param principal the signed-in customer
   * @returns the account
   * @throws {AppError} `UNAUTHORIZED` (401) when the customer no longer exists
   */
  async me(principal: CustomerPrincipal): Promise<WireStoreMe> {
    const customer = await findCustomerById(this.db.db, principal.customerId);
    if (!customer) throw new AppError('UNAUTHORIZED');
    const credentials = await findCredentials(this.db.db, customer.id);
    return toStoreMe(customer, Boolean(credentials?.passwordHash));
  }

  /**
   * Changes the language, the currency and the marketing consent.
   *
   * @param principal the signed-in customer
   * @param input the fields to change
   * @param meta the caller's address and user agent (the consent record keeps them)
   * @returns the account after the change
   * @throws {AppError} `VALIDATION_FAILED` (422 on `currency`: not a currency the store shows), `UNAUTHORIZED` (401)
   */
  async updateMe(principal: CustomerPrincipal, input: UpdateMeInput, meta: RequestMeta): Promise<WireStoreMe> {
    if (input.currency !== undefined) {
      const currency = await currencyByCode(this.db.db, input.currency);
      if (!currency?.isStorefront || !currency.isActive) {
        const message = 'Choose one of the currencies the store shows.';
        throw new AppError('VALIDATION_FAILED', {
          detail: message,
          errors: [{ field: 'currency', code: 'unavailable', message }],
        });
      }
    }
    const now = this.clock.now();
    const updated = await this.db.runInTransaction(async (work) => {
      const customer = await findCustomerById(work.tx, principal.customerId, true);
      if (!customer) throw new AppError('UNAUTHORIZED');
      const changes = {
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.marketingOptIn !== undefined ? { marketingOptIn: input.marketingOptIn } : {}),
      };
      if (Object.keys(changes).length === 0) return customer;
      if (input.marketingOptIn !== undefined && input.marketingOptIn !== customer.marketingOptIn) {
        // Proof of consent, immutable: the change is a new record, never an edit of an old one.
        await insertConsentRecord(work.tx, {
          subjectType: 'customer',
          subjectId: customer.id,
          purpose: 'marketing',
          granted: input.marketingOptIn,
          ip: meta.ip,
          userAgent: meta.userAgent.slice(0, 512),
          createdAt: now,
        });
      }
      return updateCustomerRow(work.tx, customer.id, { ...changes, updatedAt: now });
    });
    const credentials = await findCredentials(this.db.db, updated.id);
    return toStoreMe(updated, Boolean(credentials?.passwordHash));
  }

  /**
   * Lists the customer's own orders.
   *
   * @param principal the signed-in customer
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async orders(
    principal: CustomerPrincipal,
    query: ParsedListQuery<'createdAt' | 'totalPrice'>,
  ): Promise<{ rows: WireStoreOrder[]; total: number }> {
    const { rows, total } = await listCustomerOrders(this.db.db, principal.customerId, query);
    return { rows: rows.map(toStoreOrder), total };
  }
}
