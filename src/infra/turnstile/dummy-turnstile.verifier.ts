// The development and test verifier of decision 034: no network, accepts only Cloudflare's dummy token.
import { Injectable } from '@nestjs/common';
import { TURNSTILE_DUMMY_TOKEN, type TurnstileResult, type TurnstileVerifier } from './turnstile-verifier';

/**
 * Accepts exactly `XXXX.DUMMY.TOKEN.XXXX` and refuses everything else.
 *
 * Why: decision 034: without `TURNSTILE_SECRET_KEY` (never in production, the config refuses to start) a local storefront
 * uses Cloudflare's test sitekey, whose widget produces the dummy token, and the tests send it. Refusing every other
 * value keeps the guard's refusal path honest in development.
 *
 * Side effects: none.
 */
@Injectable()
export class DummyTurnstileVerifier implements TurnstileVerifier {
  /**
   * Checks a token against the dummy token.
   *
   * @param token the header value
   * @param _clientIp unused: nothing is sent anywhere
   * @returns ok for the dummy token, otherwise a `rejected` refusal
   */
  verify(token: string, _clientIp: string): Promise<TurnstileResult> {
    return Promise.resolve(token === TURNSTILE_DUMMY_TOKEN ? { ok: true } : { ok: false, reason: 'rejected' });
  }
}
