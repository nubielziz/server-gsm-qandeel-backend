// The seam from an account's details to the shop's currencies and tax windows (decision 064): which countries the shop sells to and which
// currency a retail account pays in. Declared here; the money module's `StorefrontMoney` implements it.
import type { DbExecutor } from '../../../infra/db';

/** A currency the shop knows: the callers of this seam only need its code. */
export interface ShopCurrencyFact {
  /** The ISO code, upper case. */
  readonly code: string;
}

/** A tax window in force: the callers of this seam only need the country it covers. */
export interface TaxWindowFact {
  /** The ISO 3166 alpha-2 country, upper case. */
  readonly country: string;
}

/**
 * Reads the shop's currencies and tax windows for the account writes of the identity module.
 *
 * Why: a retail account may only be given a country the shop sells to (one with a tax rate in force), and its currency follows from that
 * country (decision 064). The tables are money's, so identity asks this seam. It is a leaf (no barrel, no module): identity's files import it
 * without loading the money module, whose providers lead back into identity's barrel.
 *
 * Side effects (of the implementation): none; reads `currencies` and `tax_rates`.
 *
 * @see PATCH /admin/clients/:id, POST /admin/clients
 */
export abstract class ShopCurrencyReads {
  /**
   * Lists every tax window in force at a moment.
   *
   * @param db the database or a transaction
   * @param at the moment (the injected clock's time)
   * @returns the windows (a country without one has no tax and is not sold to)
   */
  abstract taxRatesInForce(db: DbExecutor, at: Date): Promise<readonly TaxWindowFact[]>;

  /**
   * Finds one currency the shop offers now.
   *
   * @param db the database or a transaction
   * @param code the ISO code (any case)
   * @returns the currency, or `undefined` when it is unknown, not offered, or its rate is held or too old (decision 049)
   */
  abstract offered(db: DbExecutor, code: string): Promise<ShopCurrencyFact | undefined>;

  /**
   * Finds a currency by code whether or not the shop offers it today.
   *
   * @param db the database or a transaction
   * @param code the ISO code
   * @returns the currency, or `undefined` when no such row exists
   */
  abstract byCode(db: DbExecutor, code: string): Promise<ShopCurrencyFact | undefined>;
}
