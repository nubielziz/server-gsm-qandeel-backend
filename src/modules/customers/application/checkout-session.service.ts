// CheckoutSessionService: opens a storefront checkout (price, tax and exchange rate locked, a guest customer by email) and reads it
// back (feature 14a, scenario b2c-paid steps 2 and 3). Paying the session and creating the order are feature 16.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ResultOf } from '../../../common/contract';
import { type FieldError, AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { StorefrontServices, type SellableField } from '../../catalog';
import { StorefrontMoney } from '../../money';
import { inputProblems, isValidImei, normalizeImei, quantityProblem } from '../../orders';
import { StorefrontPolicies, StorefrontQuotes, inCurrency } from '../../storefront';
import type { openCheckoutSession } from '../contracts/checkout.contracts';
import type { CheckoutSession, Customer } from '../db/schema';
import {
  CHECKOUT_IMEI_AAD,
  CHECKOUT_SESSION_TTL_MINUTES,
  MAX_USER_AGENT_LENGTH,
  consentOf,
  consentState,
  effectiveStatus,
  maskEmail,
  maskImei,
  requiredConsents,
} from '../domain/checkout';
import {
  findCheckoutSession,
  findCustomerByEmail,
  insertCheckoutSession,
  insertGuestCustomer,
} from '../infra/checkout.repository';
import { listSessionConsents } from '../infra/consent.repository';

/** The session as the route answers. */
export type CheckoutSessionView = ResultOf<typeof openCheckoutSession>;

/** What the route hands in to open a checkout. */
export interface OpenCheckoutRequest {
  readonly serviceId: number;
  /** Already trimmed, valid and lower case. */
  readonly email: string;
  readonly country: string;
  readonly region?: string | undefined;
  readonly currency?: string | undefined;
  readonly quantity?: number | undefined;
  readonly imei?: string | undefined;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  readonly utm?: Readonly<Record<string, string | undefined>> | undefined;
  /** The visitor's address (decision 018's trusted proxy address). */
  readonly ip: string;
  readonly userAgent: string;
}

const MINUTE_MS = 60_000;

const notAvailable = () =>
  new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'serviceId', code: 'not_available', message: 'This service is not available.' }],
  });

/**
 * Opens and reads storefront checkout sessions.
 *
 * Why: scenario b2c-paid steps 2 and 3 and the map's `POST /store/v1/checkout-sessions`: the session locks the price (the retail
 * price of the one resolver, never under the floor), the tax rate of the buyer's country and the exchange rate, so what is paid
 * is what was shown. A guest becomes a `customers` row by email; a suspended or blocked customer cannot open a session (scenario
 * b2c-account step 8). The IMEI is stored only as AES-GCM text (decision 019). Expiry is judged on the injected clock.
 *
 * Side effects: inserts a guest `customers` row when the email is new and one `checkout_sessions` row, in one transaction.
 */
@Injectable()
export class CheckoutSessionService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: StorefrontQuotes,
    private readonly services: StorefrontServices,
    private readonly money: StorefrontMoney,
    private readonly policies: StorefrontPolicies,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens a checkout.
   *
   * @param request the service, the buyer's email and country, and the visitor's address
   * @returns the new session as the buyer reads it
   * @throws {AppError} `UNAUTHORIZED` when the shop requires an account; `VALIDATION_FAILED` for a service that cannot be sold or
   *   ordered online, a quantity or order field that does not fit, or a currency that is not offered; `INVALID_IMEI` for a bad
   *   IMEI; `ACCOUNT_SUSPENDED` for a suspended or blocked customer
   */
  async open(request: OpenCheckoutRequest): Promise<CheckoutSessionView> {
    const row = await this.db.runInTransaction(async ({ tx }) => {
      const switches = await this.policies.switches(tx);
      // A signed-in customer is not read on this public route yet (store sign-in is feature 14b), so an account-only shop refuses.
      if (!switches.guestCheckout) {
        throw new AppError('UNAUTHORIZED', { detail: 'Sign in to check out.' });
      }
      const retailGroupId = await this.quotes.retailGroupId(tx);
      if (retailGroupId === undefined) throw notAvailable();
      const context = await this.quotes.context(tx, retailGroupId, {
        country: request.country,
        region: request.region,
        currency: request.currency,
      });
      const priced = await this.quotes.price(tx, context, request.serviceId);
      if (!priced) throw notAvailable();
      const { service } = priced;
      if (service.type === 'file') {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            { field: 'serviceId', code: 'not_orderable', message: 'This service cannot be ordered online yet.' },
          ],
        });
      }

      const quantity = request.quantity ?? service.minQty;
      const fields = await this.services.fields(tx, service.id);
      const imei = service.type === 'imei' ? this.readImei(request.imei) : undefined;
      const problems: FieldError[] = [];
      const quantityIssue = quantityProblem(quantity, service);
      if (quantityIssue !== undefined)
        problems.push({ field: 'quantity', code: 'invalid_quantity', message: quantityIssue });
      problems.push(...inputProblems(fields.map(placementField), request.inputs ?? {}));
      if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { errors: problems });

      const customer = await this.guestFor(tx, request.email, request.country);
      if (customer.status !== 'active') {
        // The same words for suspended and blocked: the buyer is told to write to support, never which of the two it is.
        throw new AppError('ACCOUNT_SUSPENDED', {
          detail: 'This account cannot start a new order. Contact support.',
        });
      }

      const amounts = this.quotes.amounts(context, priced.unitNet, quantity);
      const now = this.clock.now();
      return insertCheckoutSession(tx, {
        token: this.tokens.random(16),
        customerId: customer.id,
        email: request.email,
        serviceId: service.id,
        imeiEnc: imei === undefined ? null : this.encryption.encrypt(imei, CHECKOUT_IMEI_AAD),
        inputs: { ...(request.inputs ?? {}) },
        quantity,
        currency: context.currency.code,
        fxRate: context.fxRate,
        netAmount: amounts.usd.net.toWire(),
        taxRate: context.taxRatePercent,
        taxAmount: amounts.usd.tax.toWire(),
        grossAmount: amounts.usd.gross.toWire(),
        taxCountry: context.taxCountry,
        utm: cleanUtm(request.utm),
        ip: request.ip,
        userAgent: request.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
        status: 'open',
        // Business times come from the injected clock, not the column default (decision 031).
        expiresAt: new Date(now.getTime() + CHECKOUT_SESSION_TTL_MINUTES * MINUTE_MS),
        createdAt: now,
        updatedAt: now,
      });
    });
    return this.view(this.db.db, row);
  }

  /**
   * Reads a session.
   *
   * @param id the session id the token resolved to
   * @returns the session as the buyer reads it
   * @throws {AppError} `NOT_FOUND` when the session no longer exists
   */
  async show(id: number): Promise<CheckoutSessionView> {
    const row = await findCheckoutSession(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    return this.view(this.db.db, row);
  }

  /**
   * Builds the buyer's view of a session.
   *
   * @param db the database or a transaction
   * @param row the stored session
   * @returns the view, amounts in USD and in the locked currency, masked email and IMEI, consent state, payment methods
   */
  async view(db: DbExecutor, row: CheckoutSession): Promise<CheckoutSessionView> {
    const now = this.clock.now();
    const [names, currency, consents, switches, methods] = await Promise.all([
      this.services.names(db, [row.serviceId]),
      this.money.byCode(db, row.currency),
      listSessionConsents(db, row.id),
      this.policies.switches(db),
      this.money.paymentMethods(db),
    ]);
    const service = names.get(row.serviceId);
    const usd = { net: row.netAmount, tax: row.taxAmount, gross: row.grossAmount };
    const display = inCurrency(
      { net: money(usd.net), tax: money(usd.tax), gross: money(usd.gross) },
      row.fxRate,
      currency?.decimals ?? 2,
    );
    return {
      token: row.token,
      status: effectiveStatus(row.status, row.expiresAt, now),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      service: {
        id: row.serviceId,
        name: service?.name ?? '',
        type: service?.type ?? 'imei',
        deliveryTime: service?.deliveryTime ?? '',
      },
      quantity: row.quantity,
      imei: row.imeiEnc === null ? null : maskImei(this.encryption.decrypt(row.imeiEnc, CHECKOUT_IMEI_AAD)),
      email: maskEmail(row.email),
      country: row.taxCountry,
      currency: row.currency,
      fxRate: row.fxRate,
      taxRate: row.taxRate,
      amounts: {
        usd,
        display: { net: display.net.toWire(), tax: display.tax.toWire(), gross: display.gross.toWire() },
      },
      consent: consentOf(consentState(consents, requiredConsents(switches.withdrawalWaiver))),
      paymentMethods: methods,
    };
  }

  /** The IMEI the buyer typed, digits only, or the `INVALID_IMEI` refusal. */
  private readImei(typed: string | undefined): string {
    const imei = normalizeImei(typed ?? '');
    if (!isValidImei(imei)) {
      throw new AppError('INVALID_IMEI', {
        detail: 'This is not a valid IMEI. Check the 15 digits (dial *#06# on the phone).',
        errors: [{ field: 'imei', code: 'invalid_imei', message: 'Enter a valid 15-digit IMEI.' }],
      });
    }
    return imei;
  }

  /** The customer of an email: the existing one, or a new guest (one winner when two checkouts race). */
  private async guestFor(tx: DbExecutor, email: string, country: string): Promise<Customer> {
    const existing = await findCustomerByEmail(tx, email);
    if (existing) return existing;
    const now = this.clock.now();
    const created = await insertGuestCustomer(tx, {
      email,
      country,
      hasAccount: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    if (created) return created;
    const raced = await findCustomerByEmail(tx, email);
    if (!raced) throw new Error('A guest customer was neither created nor found.');
    return raced;
  }
}

/** A service field as the shared placement rules read it. */
function placementField(field: SellableField) {
  return {
    id: field.id,
    sort: field.sort,
    key: field.key,
    label: field.label,
    fieldType: field.fieldType,
    options: field.options,
    required: field.required,
    regex: field.regex,
  };
}

const money = (wire: string) => Money.of(wire);

/** Keeps the UTM tags the buyer sent that have a value. */
function cleanUtm(utm: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(utm ?? {})) if (value !== undefined && value !== '') out[key] = value;
  return out;
}
