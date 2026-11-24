// CustomerAccountService: the use cases of GET and PATCH /store/v1/me and GET /store/v1/me/orders (map domain I, stage 14; decision 064): the
// signed-in retail account's own account (`AccountMe`) and shop orders. The account row belongs to the identity module and the shop orders to
// the orders module: this service judges the shop's rules and goes through their ports.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CapabilityTokenVault } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { AccountOwnProfile, type AccountPrincipal, type RequestMeta } from '../../identity';
import { ShopOrders, type ShopOrderRow } from '../../orders';
import type { StoreMeSchema, StoreOrderSchema } from '../contracts/store-account.contracts';
import { profileChanges } from '../domain/profile-edit';
import { insertConsentRecord } from '../infra/consent.repository';
import { currencyByCode } from '../infra/foreign-reads.repository';
import { CustomerProfileRules } from './customer-profile-rules';

/** The account on the wire (`AccountMe`). */
export type WireStoreMe = z.output<typeof StoreMeSchema>;
/** One of the account's shop orders on the wire. */
export type WireStoreOrder = z.output<typeof StoreOrderSchema>;

/** What `PATCH /store/v1/me` may change. */
export interface UpdateMeInput {
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly country?: string | undefined;
  readonly currency?: string | undefined;
  readonly marketingOptIn?: boolean | undefined;
}

/**
 * Builds one of the account's shop orders for the wire.
 *
 * @param row the order as the orders module lists it
 * @param trackingToken the order's tracking token, revealed from its stored form (decision 054), or `null`
 * @returns the wire order (an erased IMEI is sent as an empty string)
 */
export function toShopOrder(row: ShopOrderRow, trackingToken: string | null): WireStoreOrder {
  return {
    id: row.id,
    status: row.status,
    service: { id: row.serviceId, name: row.serviceName },
    imei: row.imei ?? '',
    quantity: row.quantity,
    totalPrice: row.totalPrice,
    taxAmount: row.taxAmount,
    currency: row.currency,
    trackingToken,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}

/**
 * Serves the signed-in retail account's own account.
 *
 * Why: the shop account page shows the details and lets the account choose currency and marketing consent (the map also names a language:
 * it is gone, decision 039). A consent is proof: a change writes a `consent_records` row with the request address and time, and a withdrawn
 * consent is a new row with `granted = false` (RESOLUTIONS b2c-12, b2c-14). The account reads only its own orders: the id comes from the
 * session. Both `me` routes answer `AccountMe`, built once by the identity module (`AccountOwnProfile`).
 *
 * Side effects: `updateMe` writes the profile columns of `clients` (through `AccountOwnProfile`) and, when the marketing choice changed,
 * `consent_records`. No audit row: an account's own edit writes none.
 */
@Injectable()
export class CustomerAccountService {
  constructor(
    private readonly db: DbService,
    private readonly rules: CustomerProfileRules,
    private readonly profile: AccountOwnProfile,
    private readonly shopOrders: ShopOrders,
    private readonly vault: CapabilityTokenVault,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Describes the signed-in account.
   *
   * @param principal the signed-in retail account
   * @returns the account as `AccountMe` shows it
   * @throws {AppError} `UNAUTHORIZED` (401) when the account no longer exists, `ACCOUNT_SUSPENDED` (403) when it is suspended
   */
  me(principal: AccountPrincipal): Promise<WireStoreMe> {
    return this.profile.meOf(principal.accountId);
  }

  /**
   * Describes an account by its id (the account a sign-in link opened).
   *
   * @param accountId the account
   * @returns the account as `AccountMe` shows it
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  meOf(accountId: number): Promise<WireStoreMe> {
    return this.profile.meOf(accountId);
  }

  /**
   * Changes the name, phone, country, currency and marketing consent.
   *
   * Why: feature 24B: the account page edits the account's own details with the staff edit's rules (`profileChanges`,
   * `CustomerProfileRules`): "changed" is judged against the locked row, a changed country must have a current tax rate and re-derives
   * the currency unless the same request sends one, and a country equal to the stored one is never checked.
   *
   * @param principal the signed-in retail account
   * @param input the fields to change
   * @param meta the caller's address and user agent (the consent record keeps them)
   * @returns the account after the change
   * @throws {AppError} `VALIDATION_FAILED` (422 on `currency`: not a currency the store shows; on `country`: a new country the
   *   storefront does not sell to), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async updateMe(principal: AccountPrincipal, input: UpdateMeInput, meta: RequestMeta): Promise<WireStoreMe> {
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
    return this.db.runInTransaction(async (work) => {
      const account = await this.profile.lockMeOf(work.tx, principal.accountId);
      // Only a country change is checked (a form that sends the stored country again must not fail when its tax rate has ended).
      const countryChanged = input.country !== undefined && input.country !== account.country;
      if (countryChanged) await this.rules.assertCountryAccepted(work.tx, input.country, now);
      // An explicit currency in the same request wins over the one derived from a changed country.
      const derived =
        countryChanged && input.currency === undefined
          ? await this.rules.currencyFor(work.tx, input.country)
          : undefined;
      const profile = profileChanges(account, input, derived);
      const changes = {
        ...profile.columns,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.marketingOptIn !== undefined ? { marketingOptIn: input.marketingOptIn } : {}),
      };
      if (Object.keys(changes).length === 0) return account;
      if (input.marketingOptIn !== undefined && input.marketingOptIn !== account.marketingOptIn) {
        // Proof of consent, immutable: the change is a new record, never an edit of an old one.
        await insertConsentRecord(work.tx, {
          subjectType: 'account',
          subjectId: account.id,
          purpose: 'marketing',
          granted: input.marketingOptIn,
          ip: meta.ip,
          userAgent: meta.userAgent.slice(0, 512),
          createdAt: now,
        });
      }
      return this.profile.saveRetailProfile(work.tx, account.id, changes, now);
    });
  }

  /**
   * Lists the account's own shop orders.
   *
   * @param principal the signed-in retail account
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async orders(
    principal: AccountPrincipal,
    query: ParsedListQuery<'createdAt' | 'totalPrice'>,
  ): Promise<{ rows: WireStoreOrder[]; total: number }> {
    const { rows, total } = await this.shopOrders.listShopOrders(this.db.db, principal.accountId, query);
    // Decision 054: the tracking token is revealed from its encrypted copy (or the plain column of an order placed before).
    return {
      rows: rows.map((row) =>
        toShopOrder(row, this.vault.reveal('tracking', { enc: row.publicTokenEnc, plain: row.publicToken })),
      ),
      total,
    };
  }
}
