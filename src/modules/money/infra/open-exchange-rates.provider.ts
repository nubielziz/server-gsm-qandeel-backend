// The `openexchangerates` driver (decision 029): `latest.json` against the USD base, called through OutboundHttp (decision 023).
import { HttpRequestError, type OutboundHttp } from '../../../infra/http';
import { type FxProvider, FxProviderUnavailableError, type FxQuote, rateText } from '../domain/fx-provider';

/** The public API base of Open Exchange Rates. */
export const OPEN_EXCHANGE_RATES_BASE_URL = 'https://openexchangerates.org/api';

/** What the driver needs. */
export interface OpenExchangeRatesOptions {
  /** The account's app id; sent in the `Authorization` header, never in the URL or a log line. */
  readonly apiKey: string;
  /** The explicit timeout of the call in milliseconds (`FX_TIMEOUT_MS`). */
  readonly timeoutMs: number;
  /** The API base; tests point it at a local server. */
  readonly baseUrl?: string;
  /** Allows a private-network base URL (tests against a local server only). */
  readonly allowPrivateNetwork?: boolean;
}

/** The parts of the provider's JSON the driver reads. */
interface LatestAnswer {
  readonly base?: unknown;
  readonly rates?: unknown;
}

/**
 * Fetches rates from Open Exchange Rates.
 *
 * Why: decision 029: the default driver, USD base, a wide currency list including JOD, SAR and AED. The `symbols` parameter
 * keeps the answer to the currencies we ask about. One call, one timeout, no retry: the refresh route and the hourly job own
 * the retry policy.
 *
 * Side effects: one outbound HTTPS call per `fetchRates` (target `fx_provider`).
 */
export class OpenExchangeRatesProvider implements FxProvider {
  readonly name = 'openexchangerates';
  readonly configured = true;

  constructor(
    private readonly http: OutboundHttp,
    private readonly options: OpenExchangeRatesOptions,
  ) {}

  /**
   * Asks for the latest rates of the given currencies.
   *
   * @param codes the ISO codes to refresh
   * @returns the rates the provider offered (a code it left out is absent)
   * @throws {FxProviderUnavailableError} on a timeout, a network failure, a non-2xx answer or an answer that is not the expected JSON
   */
  async fetchRates(codes: readonly string[]): Promise<FxQuote> {
    const base = this.options.baseUrl ?? OPEN_EXCHANGE_RATES_BASE_URL;
    const url = `${base}/latest.json?symbols=${encodeURIComponent(codes.join(','))}`;
    let status: number;
    let json: unknown;
    try {
      const result = await this.http.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Token ${this.options.apiKey}` },
        timeoutMs: this.options.timeoutMs,
        target: 'fx_provider',
        operation: 'openexchangerates.latest',
        ...(this.options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      });
      status = result.status;
      json = result.ok ? result.json() : undefined;
    } catch (error) {
      if (error instanceof HttpRequestError) {
        throw new FxProviderUnavailableError(
          error.kind === 'timeout'
            ? 'The exchange-rate provider did not answer in time.'
            : 'The exchange-rate provider could not be reached.',
        );
      }
      // `result.json()` on a body that is not JSON.
      throw new FxProviderUnavailableError('The exchange-rate provider sent an answer that could not be read.');
    }
    if (status < 200 || status >= 300) {
      throw new FxProviderUnavailableError(`The exchange-rate provider refused the request (HTTP ${status}).`);
    }
    return parseLatest(json);
  }
}

/**
 * Reads the provider's `latest.json`.
 *
 * @param json the parsed answer
 * @returns the usable rates; a missing or unusable rate is left out
 * @throws {FxProviderUnavailableError} when the answer is not a USD-base rates object
 */
export function parseLatest(json: unknown): FxQuote {
  const answer = json as LatestAnswer | null;
  if (typeof answer !== 'object' || answer === null || typeof answer.rates !== 'object' || answer.rates === null) {
    throw new FxProviderUnavailableError('The exchange-rate provider sent an answer that could not be read.');
  }
  if (answer.base !== undefined && answer.base !== 'USD') {
    throw new FxProviderUnavailableError('The exchange-rate provider sent rates against another base currency.');
  }
  const rates = new Map<string, string>();
  for (const [code, value] of Object.entries(answer.rates as Record<string, unknown>)) {
    const text = rateText(value);
    if (text !== undefined) rates.set(code.toUpperCase(), text);
  }
  return { rates };
}
