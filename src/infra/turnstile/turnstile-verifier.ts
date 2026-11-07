// The contract of the anti-bot check (decision 034): a verifier decides whether a Turnstile token is good. The guard asks it;
// the production verifier calls Cloudflare, the development one accepts only Cloudflare's published dummy token.

/**
 * Why a token was refused, as a metric label and a log field (never the token itself).
 *
 * Why: decision 034: `missing` and `too_long` are refused before any outbound call; `rejected` and `hostname` are
 * Cloudflare's answer; `timeout`, `network` and `bad_response` fail closed.
 */
export type TurnstileFailureReason =
  'missing' | 'too_long' | 'rejected' | 'hostname' | 'timeout' | 'network' | 'bad_response';

/** The verdict of one check. */
export type TurnstileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: TurnstileFailureReason;
      /** Cloudflare's `error-codes`, for the log (`timeout-or-duplicate`, `invalid-input-response`, ...). */
      readonly errorCodes?: readonly string[];
    };

/**
 * Decides whether a token from the Turnstile widget is valid.
 *
 * Why: decision 034 keeps the three storefront features (14a, 14b, 17) off the vendor: they set `turnstile: true` on a
 * route and a global guard asks this interface, so a test or a local storefront can run without Cloudflare.
 */
export interface TurnstileVerifier {
  /**
   * Checks one token.
   *
   * @param token the value of the `X-Turnstile-Token` header (already known to be non-empty and at most 2048 characters)
   * @param clientIp the visitor's address as the trusted proxy chain reports it (decision 018)
   * @returns the verdict; an outage is a refusal, never a pass
   */
  verify(token: string, clientIp: string): Promise<TurnstileResult>;
}

/** The injection token of the active {@link TurnstileVerifier}. */
export const TURNSTILE_VERIFIER = Symbol('TURNSTILE_VERIFIER');

/** The header that carries the widget's token (decision 034). */
export const TURNSTILE_HEADER = 'x-turnstile-token';

/** The longest token accepted; Cloudflare's own limit. */
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048;

/** Cloudflare's published dummy token: what the widget produces with a test sitekey (`1x00000000000000000000AA`). */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
