// The `manual` exchange-rate driver (decision 029): it fetches nothing. It also stands in for `openexchangerates` when no API key is
// set, so the refresh answers 502 FX_PROVIDER_DOWN instead of the process refusing to boot.
import {
  type FxProvider,
  type FxProviderName,
  FxProviderUnavailableError,
  type FxQuote,
  NOT_CONFIGURED_MESSAGE,
} from '../domain/fx-provider';

/**
 * A driver with nothing to ask.
 *
 * Why: decision 029: `manual` is the development default and makes a refresh answer `502 FX_PROVIDER_DOWN` with the detail
 * "No exchange-rate provider is configured."; rates are then edited by hand (`PATCH /admin/currencies/:id`).
 */
export class ManualFxProvider implements FxProvider {
  readonly configured = false;

  /**
   * @param name the driver name to report: `manual`, or `openexchangerates` when its key is missing
   */
  constructor(readonly name: FxProviderName = 'manual') {}

  /**
   * Always refuses.
   *
   * @returns never
   * @throws {FxProviderUnavailableError} always, with the not-configured message
   */
  fetchRates(): Promise<FxQuote> {
    return Promise.reject(new FxProviderUnavailableError(NOT_CONFIGURED_MESSAGE));
  }
}
