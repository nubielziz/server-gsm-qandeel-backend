// CheckoutSessionService: opens a storefront checkout (price, tax and exchange rate locked; the retail account itself, or the guest row of
// the typed email) and reads it back (feature 14a, scenario b2c-paid steps 2 and 3; decision 064). Paying the session and creating the order are feature 16 (`CheckoutPayService`,
// `CheckoutCaptureService`); a paid session shows the tracking token of its order.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ResultOf } from '../../../common/contract';
import { type FieldError, AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { CapabilityTokenVault, EncryptionService } from '../../../infra/crypto';
import { StorefrontServices, type SellableField } from '../../catalog';
import { AccountDirectory, type AccountRecord, canAct } from '../../identity';
import { CustomerWallets, StorefrontMoney } from '../../money';
import {
  OrderReadService,
  inputProblems,
  isValidImei,
  normalizeImei,
  quantityProblem,
  typedImeiOf,
} from '../../orders';
import { Blocklist } from '../../risk';
import { StorefrontPolicies, StorefrontQuotes, inCurrency } from '../../storefront';
import type { openCheckoutSession } from '../contracts/checkout.contracts';
import type { CheckoutSession } from '../db/schema';
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
import { findCheckoutSession, insertCheckoutSession } from '../infra/checkout.repository';
import { listSessionConsents } from '../infra/consent.repository';
import { regionNotSupported } from './customer-errors';
import { CustomerProfileRules } from './customer-profile-rules';

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
  /** The retail account the request is signed in as (a full session whose CSRF token was checked), or nothing for a guest. */
  readonly accountId?: number | undefined;
  /** The visitor's address (decision 018's trusted proxy address). */
  readonly ip: string;
  /** The visitor's country the trusted proxy header reported (decision 050), or null. */
  readonly ipCountry?: string | null | undefined;
  readonly userAgent: string;
}

const MINUTE_MS = 60_000;

const notAvailable = () =>
  new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'serviceId', code: 'not_available', message: 'This service is not available.' }],
  });

/**
 * The one refusal of a buyer who may not order: an account or guest row that may not act (suspended, blocked, erased), or a blocklisted
 * email, domain or IMEI.
 *
 * Why: the buyer is told to write to support, never which of these it is (scenario b2c-account step 8, RULES risk 5: a visitor who
 * types the address of a suspended account learns nothing from the answer, and no guest row is made for it).
 */
function cannotOrder(): AppError {
  return new AppError('ACCOUNT_SUSPENDED', { detail: 'This account cannot start a new order. Contact support.' });
}

/**
 * The refusal of an account of a merchant rank at the shop's checkout.
 *
 * Why: decision 064: a merchant orders from its price list; the shop never opens a checkout for it, signed in or not (a merchant's email
 * typed signed out gets a guest row of its own, which attaches to nothing of the merchant).
 */
function merchantAtRetailDoor(): AppError {
  return new AppError('RANK_NOT_ALLOWED', { detail: 'Your account orders from its price list.' });
}

/**
 * Opens and reads storefront checkout sessions.
 *
 * Why: scenario b2c-paid steps 2 and 3 and the map's `POST /store/v1/checkout-sessions`: the session locks the price (the retail
 * price of the one resolver, never under the floor), the tax rate of the buyer's country and the exchange rate, so what is paid
 * is what was shown. Decision 064: a signed-in retail account opens the checkout as itself (its row is held `FOR KEY
 * SHARE`, so a rank change either waits for this open or is seen by it; the email must be the account's own, the shop's `guestCheckout`
 * switch does not apply); a signed-in merchant rank is refused (`RANK_NOT_ALLOWED`) and nothing is written. Signed out, the buyer is the
 * guest row of the typed email, never the login account of that email whatever its rank: a login row that may not act (suspended,
 * blocked, erased) is refused like a blocklist hit and no guest row is made; otherwise the guest row is made or reused
 * (`AccountDirectory.findOrCreateGuest`, one winner when two checkouts race). A guest row that may not act cannot open a session either
 * (scenario b2c-account step 8). The IMEI is stored only as AES-GCM text
 * (decision 019). The checkout token is stored as a keyed hash and an encrypted copy (decision 054). Expiry is judged on the injected
 * clock. Decision 050: while the shop has a tax window in force, a country without one is refused as the customer profile refuses it; a
 * signed-in buyer is not matched by a blocklist entry limited to guest checkouts; and the visitor's country the proxy header reported is
 * kept on the session. While a country has a regional tax window in force, the checkout must name a region that has one (any case); the
 * region is the buyer's own statement, like the country. The service's main-input field (the one flagged `isMainInput`, whatever its key, decision 065)
 * is judged (pattern and required) on the IMEI, and what is stored under that key is the IMEI, as on the other order surfaces. Decision 070: the
 * shop's form draws only the custom fields, so the IMEI is `imei` when the request sends it (older shop pages; its problems on `imei`, a value
 * under the field's key never stands in for it), else the value typed into the main-input field (every problem about it on `inputs.<key>`).
 *
 * Side effects: one transaction: may insert a guest row of `clients` (through `AccountDirectory`) when the email is new, holds the signed-in
 * account's row `FOR KEY SHARE`, and inserts one `checkout_sessions` row (with `account_id` and `ip_country`).
 */
@Injectable()
export class CheckoutSessionService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: StorefrontQuotes,
    private readonly services: StorefrontServices,
    private readonly money: StorefrontMoney,
    private readonly policies: StorefrontPolicies,
    private readonly orders: OrderReadService,
    private readonly blocklist: Blocklist,
    private readonly encryption: EncryptionService,
    private readonly vault: CapabilityTokenVault,
    private readonly wallets: CustomerWallets,
    private readonly accounts: AccountDirectory,
    private readonly countryRules: CustomerProfileRules,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens a checkout.
   *
   * @param request the service, the buyer's email and country, the signed-in retail account if any, and the visitor's address
   * @returns the new session as the buyer reads it
   * @throws {AppError} `UNAUTHORIZED` when the shop requires an account and nobody is signed in (or the signed-in account is
   *   gone); `RANK_NOT_ALLOWED` (403) when the signed-in account holds a merchant rank (nothing is written); `VALIDATION_FAILED`
   *   for a service that cannot be sold or ordered online, a quantity or order field that does not fit, a currency that is not offered,
   *   or (signed in) an email that is not the account's, or (on `inputs.<key>`, `required`) an IMEI missing from the main-input field;
   *   `INVALID_IMEI` for a bad IMEI (on `imei`, or on `inputs.<key>` when it was typed into the main-input field);
   *   `ACCOUNT_SUSPENDED` for an account or guest row that may not act, a suspended, blocked or erased login row of the typed
   *   address (signed out), or a blocklisted email, email domain or IMEI (one message for all);
   *   `VALIDATION_FAILED` on `country` (`unsupported`) for a country without a tax window while the shop has one; `VALIDATION_FAILED` on
   *   `region` (`unsupported`) for a missing region, or one without a window in force, while the country has a regional window in force
   */
  async open(request: OpenCheckoutRequest): Promise<CheckoutSessionView> {
    const row = await this.db.runInTransaction(async ({ tx }) => {
      const switches = await this.policies.switches(tx);
      const account =
        request.accountId === undefined ? undefined : await this.accountFor(tx, request.accountId, request.email);
      // The guest-checkout switch is about buyers without an account: a signed-in account is not a guest.
      if (account === undefined && !switches.guestCheckout) {
        throw new AppError('UNAUTHORIZED', { detail: 'Sign in to check out.' });
      }
      // Decision 050: no checkout for a country without a tax window while the shop has one (the profile's refusal).
      await this.countryRules.assertCheckoutCountry(tx, request.country, this.clock.now());
      // A country taxed by region has no one rate: the buyer names one of its regions with a window in force.
      if (!(await this.money.taxRegionAccepted(tx, request.country, request.region, this.clock.now()))) {
        throw regionNotSupported();
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
      // A service may define a main-input field (decision 065: flagged `isMainInput`, whatever its key; it carries the pattern the supplier
      // wants): on an IMEI service it is the IMEI itself. Decision 070: the shop draws only the custom fields, so the IMEI is `imei` when the
      // request sends it (older shop pages), else the value typed into that field; its problems are reported where it was typed.
      const typedInputs = request.inputs ?? {};
      const box = fields.find((field) => field.isMainInput);
      const typed =
        service.type === 'imei'
          ? typedImeiOf({ imei: request.imei, inputs: typedInputs, imeiPath: 'imei', fieldKey: box?.key })
          : undefined;
      // Nothing typed into the main-input field is a missing answer of the form; nothing at all without such a field is refused as a bad
      // IMEI on `imei`, as before.
      const missing = typed !== undefined && typed.text === '' && typed.fieldKey !== undefined;
      const imei = typed === undefined || missing ? undefined : this.readImei(typed.text, typed.path);
      const problems: FieldError[] = [];
      const quantityIssue = quantityProblem(quantity, service);
      if (quantityIssue !== undefined)
        problems.push({ field: 'quantity', code: 'invalid_quantity', message: quantityIssue });
      if (missing) problems.push({ field: typed.path, code: 'required', message: 'Enter the IMEI.' });
      // The IMEI is the value stored encrypted and sent to the supplier, so it is the one the pattern judges and the one that satisfies a
      // required field: when it came as `imei`, a value under that field's key never stands in for it. The field's problems are shown where
      // the IMEI's are.
      const fieldInputs = imei !== undefined && box ? { ...typedInputs, [box.key]: imei } : typedInputs;
      const onImei = typed !== undefined && box ? { [box.key]: typed.path } : {};
      const fieldProblems = inputProblems(fields.map(placementField), fieldInputs, onImei);
      problems.push(...(missing ? fieldProblems.filter((problem) => problem.field !== typed.path) : fieldProblems));
      if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { errors: problems });

      // RULES risk 5: a blocklisted email, email domain or IMEI cannot open a checkout. It gets the answer a blocked account gets, so the
      // buyer never learns which entry matched (and no guest row is made for it).
      // A signed-in buyer is not matched by an entry limited to guest checkouts (decision 050).
      const probe = { email: request.email, imei: imei ?? null, guest: account === undefined };
      if ((await this.blocklist.match(tx, probe)).length > 0) {
        throw cannotOrder();
      }
      const buyer = account ?? (await this.guestFor(tx, request.email, request.country));
      if (!canAct(buyer.status)) throw cannotOrder();

      const amounts = this.quotes.amounts(context, priced.unitNet, quantity);
      const now = this.clock.now();
      // Decision 054: the token is stored only as its keyed hash and an encrypted copy; the answer shows it once more.
      const issued = this.vault.issue('checkout');
      return insertCheckoutSession(tx, {
        token: null,
        tokenHash: issued.hash,
        tokenEnc: issued.enc,
        accountId: buyer.id,
        email: request.email,
        serviceId: service.id,
        imeiEnc: imei === undefined ? null : this.encryption.encrypt(imei, CHECKOUT_IMEI_AAD),
        // What is stored under that key is the typed IMEI too, so the order never shows two different IMEIs.
        inputs:
          imei !== undefined && box && Object.hasOwn(typedInputs, box.key)
            ? { ...typedInputs, [box.key]: imei }
            : { ...typedInputs },
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
        ipCountry: request.ipCountry ?? null,
        userAgent: request.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
        status: 'open',
        // Plan 21 P9: only a checkout the account itself opened may be paid from its store balance (a guest checkout typed with the
        // account's email, or a prepared link sent to the buyer, never can).
        openedSignedIn: account !== undefined,
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
   * @returns the view, amounts in USD and in the locked currency, masked email and IMEI, consent state, payment methods, and whether the
   *   store balance may pay it (the wallet is switched on and the checkout was opened signed in; never the balance itself: the token is not
   *   an identity)
   */
  async view(db: DbExecutor, row: CheckoutSession): Promise<CheckoutSessionView> {
    const now = this.clock.now();
    const [names, currency, consents, switches, methods, trackingToken, policy] = await Promise.all([
      this.services.names(db, [row.serviceId]),
      this.money.byCode(db, row.currency),
      listSessionConsents(db, row.id),
      this.policies.switches(db),
      this.money.paymentMethods(db),
      row.orderId === null ? Promise.resolve(null) : this.orders.trackingTokenOf(db, row.orderId),
      this.wallets.policy(),
    ]);
    const service = names.get(row.serviceId);
    const usd = { net: row.netAmount, tax: row.taxAmount, gross: row.grossAmount };
    const display = inCurrency(
      { net: money(usd.net), tax: money(usd.tax), gross: money(usd.gross) },
      row.fxRate,
      currency?.decimals ?? 2,
    );
    return {
      // The CHECK of the table guarantees one of the two forms.
      token: this.vault.reveal('checkout', { enc: row.tokenEnc, plain: row.token }) ?? '',
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
      balancePayable: policy.enabled && row.openedSignedIn,
      trackingToken,
    };
  }

  /** The IMEI the buyer typed, digits only, or the `INVALID_IMEI` refusal on `path` (`imei`, or the main-input field's `inputs.<key>`). */
  private readImei(typed: string, path: string): string {
    const imei = normalizeImei(typed);
    if (!isValidImei(imei)) {
      throw new AppError('INVALID_IMEI', {
        detail: 'This is not a valid IMEI. Check the 15 digits (dial *#06# on the phone).',
        errors: [{ field: path, code: 'invalid_imei', message: 'Enter a valid 15-digit IMEI.' }],
      });
    }
    return imei;
  }

  /**
   * The account the signed-in request opens the checkout for.
   *
   * Why: the receipt, the tracking link and the order belong to the account, so the typed email must be the account's own (any
   * case); a buyer who wants another address signs out and checks out as a guest. The row is held `FOR KEY SHARE` and its rank read after
   * the lock (decision 064): a rank change to the merchant kind takes the row `FOR UPDATE`, so it either waits for this open (and then
   * sees the session as the `open_checkout` blocker) or has already committed, and then this open refuses.
   */
  private async accountFor(tx: DbExecutor, accountId: number, email: string): Promise<AccountRecord> {
    const account = await this.accounts.lockForKeyShare(tx, accountId);
    // The session outlived the account (deleted meanwhile).
    if (!account) throw new AppError('UNAUTHORIZED');
    if (account.rankKind !== 'retail') throw merchantAtRetailDoor();
    if (account.email.toLowerCase() !== email.toLowerCase()) {
      const message = 'Use the email of your account, or sign out to check out as a guest.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        errors: [{ field: 'email', code: 'not_account_email', message }],
      });
    }
    return account;
  }

  /**
   * The guest row of an email: the existing one, or a new one (one winner when two checkouts race).
   *
   * Why: decision 064: a login row of the address that may not act is refused first, with the answer of a blocklist hit and
   * without a guest row; any other login row is left alone: the buyer is the guest row of the address, never the login account.
   */
  private async guestFor(tx: DbExecutor, email: string, country: string): Promise<AccountRecord> {
    const login = await this.accounts.findLoginByEmail(tx, email);
    if (login !== undefined && !canAct(login.status)) throw cannotOrder();
    const { account } = await this.accounts.findOrCreateGuest(tx, { email, country });
    return account;
  }
}

/**
 * A service field as the shared placement rules read it.
 *
 * The shop answers by key and never learns a field's Name (it is what a supplier receives), so the key stands in for it: the rules that
 * judge a checkout do not read the Name.
 */
function placementField(field: SellableField) {
  return {
    id: field.id,
    sort: field.sort,
    key: field.key,
    name: field.key,
    isMainInput: field.isMainInput,
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
