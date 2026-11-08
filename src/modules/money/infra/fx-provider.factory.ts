// The Nest provider of the configured exchange-rate driver (decision 029), shared by the API's money routes and the worker's hourly job.
import type { FactoryProvider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { OutboundHttp } from '../../../infra/http';
import { FX_PROVIDER, type FxProvider } from '../domain/fx-provider';
import { ManualFxProvider } from './manual-fx.provider';
import { OpenExchangeRatesProvider } from './open-exchange-rates.provider';

/**
 * Provides {@link FX_PROVIDER}: the driver `FX_PROVIDER` names.
 *
 * Why: decision 029. `openexchangerates` without a key behaves like `manual` (the refresh answers `502 FX_PROVIDER_DOWN`, the hourly
 * job does nothing), so a missing key never stops a process from booting. The API (`POST /admin/currencies/refresh-fx`) and the
 * worker (`fx_refresh`) both need the same choice, so it is written once here.
 */
export const FX_PROVIDER_FACTORY: FactoryProvider<FxProvider> = {
  provide: FX_PROVIDER,
  inject: [APP_CONFIG, OutboundHttp],
  useFactory: (config: AppConfig, http: OutboundHttp) =>
    config.fx.provider === 'openexchangerates' && config.fx.apiKey !== undefined
      ? new OpenExchangeRatesProvider(http, { apiKey: config.fx.apiKey, timeoutMs: config.fx.timeoutMs })
      : new ManualFxProvider(config.fx.provider),
};
