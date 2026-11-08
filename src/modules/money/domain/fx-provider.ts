// The exchange-rate provider seam (decision 029, RESOLUTIONS money-9): what a driver answers and how a refusal looks. Pure types
// and helpers; the drivers (openexchangerates, manual) are in infra/.
import type { AppConfig } from '../../../config';

/** The names an exchange-rate driver can have (`FX_PROVIDER`). */
export type FxProviderName = AppConfig['fx']['provider'];

/**
 * The latest rates a provider returned.
 *
 * Why: decision 029: a driver answers units of each requested currency per 1 USD, the ledger's base currency (decision 011).
 */
export interface FxQuote {
  /** Currency code to units per 1 USD, written as a decimal string with at most 8 fraction digits. */
  readonly rates: ReadonlyMap<string, string>;
}

/**
 * One exchange-rate driver.
 *
 * Why: decision 029: "One driver interface `FxProvider` in the money module returns the latest rates for a list of currency
 * codes against the base currency (USD)." The refresh route and the hourly job call the configured driver and own their retry
 * policy; a driver never retries by itself (decision 023).
 */
export interface FxProvider {
  /** The driver's name, sent as `source` in the answer of the refresh route. */
  readonly name: FxProviderName;
  /** False for a driver that fetches nothing (`manual`, or `openexchangerates` without a key). */
  readonly configured: boolean;
  /**
   * Fetches the latest rates.
   *
   * @param codes the ISO codes of the currencies to refresh (never the base currency)
   * @returns the rates the provider offers; a currency it does not offer is simply absent
   * @throws {FxProviderUnavailableError} when nothing could be fetched: not configured, a timeout, a refusal, an unreadable answer
   */
  fetchRates(codes: readonly string[]): Promise<FxQuote>;
}

/** The Nest token of the configured {@link FxProvider}. */
export const FX_PROVIDER = Symbol('FX_PROVIDER');

/**
 * A provider that could not give any rate.
 *
 * Why: the route turns it into `502 FX_PROVIDER_DOWN` with this message as the detail; the message never holds the API key.
 */
export class FxProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxProviderUnavailableError';
  }
}

/** The detail of `FX_PROVIDER_DOWN` when no driver is configured (decision 029). */
export const NOT_CONFIGURED_MESSAGE = 'No exchange-rate provider is configured.';

/**
 * Writes a rate a provider sent as a number in the form the `currencies` column keeps: 8 fraction digits at most.
 *
 * Why: JSON rates are numbers (`0.79`, `150.123456`); the column is `numeric(18,8)` and a float must never reach the ledger's
 * arithmetic, so the number is turned into text once, here, with no exponent.
 *
 * @param value a rate from a provider's JSON
 * @returns the decimal text, or `undefined` when the value is not a positive finite number below 10^10
 */
export function rateText(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1e10) return undefined;
  const text = value.toFixed(8);
  // A positive number that rounds to zero at 8 places is not a usable rate.
  return Number(text) > 0 ? text : undefined;
}
