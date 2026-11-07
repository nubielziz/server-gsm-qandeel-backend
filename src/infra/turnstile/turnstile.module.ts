// Global Nest module of the anti-bot check (decision 034): the verifier chosen by the configuration and the guard that uses it.
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { OutboundHttp } from '../http';
import { DummyTurnstileVerifier } from './dummy-turnstile.verifier';
import { SiteverifyTurnstileVerifier } from './siteverify-turnstile.verifier';
import { TurnstileGuard } from './turnstile.guard';
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from './turnstile-verifier';

/**
 * Provides {@link TurnstileGuard} and the verifier behind it.
 *
 * Why: decision 034: with `TURNSTILE_SECRET_KEY` the siteverify verifier calls Cloudflare through `OutboundHttp`; without it
 * (development and tests; production refuses to start) the dummy verifier accepts only Cloudflare's dummy token. The module
 * is global because the identity module's `AccessGuard` calls the guard for every route; it needs only the config, the
 * outbound HTTP service and the metrics registry, so a test app built without a database still has it.
 */
@Global()
@Module({
  providers: [
    {
      provide: TURNSTILE_VERIFIER,
      inject: [APP_CONFIG, OutboundHttp],
      useFactory: (config: AppConfig, http: OutboundHttp): TurnstileVerifier =>
        config.turnstile.secretKey === undefined
          ? new DummyTurnstileVerifier()
          : new SiteverifyTurnstileVerifier({
              secret: config.turnstile.secretKey,
              hostnames: config.turnstile.hostnames,
              http,
            }),
    },
    TurnstileGuard,
  ],
  exports: [TurnstileGuard, TURNSTILE_VERIFIER],
})
export class TurnstileModule {}
