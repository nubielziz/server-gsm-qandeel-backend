// The production verifier of decision 034: Cloudflare's siteverify endpoint, called through OutboundHttp (decision 023).
import { HttpRequestError, type HttpResult } from '../http';
import type { OutboundRequestOptions } from '../http';
import type { TurnstileResult, TurnstileVerifier } from './turnstile-verifier';

/** Cloudflare's token verification endpoint. */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The most time one verification may take: a storefront write waits for it (decision 034). */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

/** What the verifier needs from `OutboundHttp` (a test passes a stand-in). */
export interface SiteverifyHttp {
  request(options: OutboundRequestOptions): Promise<HttpResult>;
}

/** Settings of {@link SiteverifyTurnstileVerifier}. */
export interface SiteverifyOptions {
  readonly secret: string;
  /** Host names a token may be issued for; empty = any. */
  readonly hostnames: readonly string[];
  readonly http: SiteverifyHttp;
  /** The endpoint; tests point it at a local server (with `allowPrivateNetwork`). */
  readonly url?: string;
  readonly allowPrivateNetwork?: boolean;
}

/** The part of Cloudflare's answer the verifier reads. */
interface SiteverifyAnswer {
  readonly success?: unknown;
  readonly hostname?: unknown;
  readonly 'error-codes'?: unknown;
}

/**
 * Verifies tokens with Cloudflare.
 *
 * Why: decision 034: `POST` the secret, the token, the visitor's address and a fresh idempotency key as JSON; the token
 * passes only when Cloudflare says `success: true` and, when `TURNSTILE_HOSTNAMES` is set, the `hostname` it was issued for
 * is in the list. A timeout (5 s), a network failure, a non-2xx status or an unreadable answer fails closed. There is no
 * automatic retry: a token is single use, so a second call with it would be refused anyway.
 *
 * Side effects: one outbound HTTPS call per check (target `turnstile` in `outbound_http_request_duration_seconds`). The
 * secret and the token are never logged.
 */
export class SiteverifyTurnstileVerifier implements TurnstileVerifier {
  constructor(private readonly options: SiteverifyOptions) {}

  /**
   * Asks Cloudflare whether the token is good.
   *
   * @param token the widget's token
   * @param clientIp the visitor's address
   * @returns ok, or the refusal with Cloudflare's error codes when it gave some
   */
  async verify(token: string, clientIp: string): Promise<TurnstileResult> {
    let response: HttpResult;
    try {
      response = await this.options.http.request({
        url: this.options.url ?? SITEVERIFY_URL,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret: this.options.secret,
          response: token,
          remoteip: clientIp,
          idempotency_key: crypto.randomUUID(),
        }),
        timeoutMs: SITEVERIFY_TIMEOUT_MS,
        maxResponseBytes: 16 * 1024,
        ...(this.options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
        target: 'turnstile',
        operation: 'turnstile.siteverify',
      });
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof HttpRequestError && error.kind === 'timeout' ? 'timeout' : 'network',
      };
    }

    let answer: SiteverifyAnswer;
    try {
      const parsed: unknown = response.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return { ok: false, reason: 'bad_response' };
      answer = parsed;
    } catch {
      return { ok: false, reason: 'bad_response' };
    }
    // Cloudflare answers 200 with success:false for a bad token; any other status is an outage on their side.
    if (!response.ok) return { ok: false, reason: 'bad_response' };
    if (answer.success !== true) {
      const codes = Array.isArray(answer['error-codes'])
        ? answer['error-codes'].filter((code): code is string => typeof code === 'string').slice(0, 10)
        : [];
      return { ok: false, reason: 'rejected', errorCodes: codes };
    }
    if (this.options.hostnames.length > 0) {
      const hostname = typeof answer.hostname === 'string' ? answer.hostname.toLowerCase() : '';
      if (!this.options.hostnames.includes(hostname)) return { ok: false, reason: 'hostname' };
    }
    return { ok: true };
  }
}
