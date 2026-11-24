// ApiKeyAuthenticator: turns a presented API key into a principal (decision 018): the Dhru surface's `username` + `apiaccesskey`. A key
// works only for an active account of a merchant rank (decision 064).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../../../common/clock';
import { constantTimeEqual } from '../../../../../infra/crypto';
import { type IpAddress, formatIpAddress, ipRateLimitKey, parseIpAddress } from '../../../../../common/ip-address';
import { RATE_LIMITERS, RateLimitService, rateLimitedError } from '../../../../../infra/rate-limit';
import type { ApiKeyPrincipal } from '../../principal';
import { ApiKeyDirectory } from './api-key.directory';
import { type ApiKeyRefusalReason, type ApiKeyView, checkApiKey, refusalFor } from './api-key.rules';

/** What a request presents. */
export interface ApiKeyCredentials {
  /** The key as the caller sent it; `undefined` when the request carries none. */
  readonly key: string | undefined;
  /** The Dhru username the key must belong to; `undefined` when the request carries none. */
  readonly username?: string | undefined;
  /**
   * How many points of the key's per-minute limit the call costs, default 1: a bulk placement costs one per item, at most the key's
   * whole limit (decision 053).
   */
  readonly points?: number | undefined;
}

/**
 * Authenticates API keys.
 *
 * Why: decision 018: `username` + `apiaccesskey` (Dhru) resolve an `api_keys` row by keyed hash, then check revoked/expired, the
 * account's status and rank kind, `allowed_ips` (CIDR, IPv4 and IPv6) and the key's per-minute limit (decision 021; the limit is counted
 * only after every other check passed, so a refused call costs the merchant nothing). A key carries no scope: every live key of an active
 * account of a merchant rank is a Dhru credential; a key whose account is not a merchant any more is refused as unauthenticated (decision
 * 064, a second wall behind the revoke). Unknown keys are counted per client address (the `ip` limiter, 300 a minute, under their own key) because Dhru
 * has no per-IP stage in the pipeline and an unknown key has no per-key limit to hit. Decision 053: that budget is read before the key is
 * looked up, so an address that used it up costs no database lookup: its keys are answered from the key cache alone, so a key in use
 * there (its view is kept fresh by its calls) is still served, and a key the cache does not hold is refused `429`; a bulk placement
 * costs one point per item (`points`), at most the key's whole limit, in the one `consume`.
 *
 * Side effects: reads the key cache and, on a miss while the address has budget left, `api_keys` and `clients`; counts points in the
 * cache Redis; writes `api_keys.last_used_at` at most once a minute.
 *
 * @see docs/decisions/018-auth-sessions-csrf.md
 */
@Injectable()
export class ApiKeyAuthenticator {
  private readonly logger = new Logger(ApiKeyAuthenticator.name);

  constructor(
    private readonly directory: ApiKeyDirectory,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Authenticates a request or refuses it.
   *
   * @param request the Fastify request (its address is judged against the key's allowed IPs)
   * @param credentials the key, the Dhru username and the points the call costs
   * @returns the principal: merchant id and key id
   * @throws {AppError} `UNAUTHORIZED` (401: no, unknown, revoked or expired key, a username that is not the key's, or a key of an account
   *   that is not active or not of a merchant rank), `ACCOUNT_SUSPENDED` (403: suspended or blocked), `IP_NOT_ALLOWED` (403),
   *   `RATE_LIMITED` (429 with `Retry-After`: the key's limit, or too many unknown keys from one address and a key the cache does not
   *   hold, or a username that is not the key's)
   */
  async authenticate(request: FastifyRequest, credentials: ApiKeyCredentials): Promise<ApiKeyPrincipal> {
    const { key, username } = credentials;
    const address = parseIpAddress(request.ip);
    const refuse = (reason: ApiKeyRefusalReason) => refusalFor(reason, address);

    // Nothing was sent: refuse without a lookup and without counting (it costs us nothing).
    if (key === undefined) throw refuse('unauthenticated');
    // Decision 053: an address that used up its unknown-key budget costs no database lookup; a key whose view is cached is still served.
    const budget = await this.limits.peek('ip', failureKey(address));
    const view = budget.allowed ? await this.directory.findByKey(key) : await this.directory.findCached(key);
    if (!view && !budget.allowed) throw rateLimitedError(budget.retryAfterSeconds);
    // A username that is not the key's is charged like an unknown key, also while the budget is used up (the charge answers 429 then).
    if (!view || (username !== undefined && !sameUsername(view.client.username, username))) {
      await this.chargeFailure(address);
      throw refuse('unauthenticated');
    }

    const nowMs = this.clock.nowMs();
    const reason = checkApiKey(view, { nowMs, address });
    if (reason) throw refuse(reason);

    // A stored limit below 1 is a data error (the limiter would throw): the limiter's default applies instead.
    const options =
      Number.isInteger(view.rateLimitPerMin) && view.rateLimitPerMin >= 1 ? { limit: view.rateLimitPerMin } : {};
    const keyLimit = options.limit ?? RATE_LIMITERS['api-key'].points;
    // A bulk costs one point per item, but never more than the key's whole limit (or the documented 100-item bulk could never pass).
    const wanted = Number.isInteger(credentials.points) ? (credentials.points as number) : 1;
    const points = Math.max(1, Math.min(wanted, keyLimit));
    const limit = await this.limits.consume('api-key', String(view.id), points, options);
    if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

    await this.touchQuietly(view, address ? formatIpAddress(address) : request.ip, nowMs);
    return {
      kind: 'api-key',
      clientId: view.clientId,
      clientName: view.client.name,
      keyId: view.id,
      ip: request.ip,
    };
  }

  /** Counts one point against the address that presented an unknown key; the budget used up is a `429`. */
  private async chargeFailure(address: IpAddress | undefined): Promise<void> {
    const result = await this.limits.consume('ip', failureKey(address));
    if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
  }

  private async touchQuietly(view: ApiKeyView, ip: string, nowMs: number): Promise<void> {
    try {
      await this.directory.touch(view, ip, nowMs);
    } catch (error) {
      // "Last used" is best effort: a failed write must not fail the request.
      this.logger.warn(
        `Could not record the use of API key ${view.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The key of the unknown-key budget of a client address, on the `ip` limiter. */
function failureKey(address: IpAddress | undefined): string {
  return `api-key-failures:${ipRateLimitKey(address)}`;
}

/** Dhru usernames are unique case-insensitively (`clients.username`); an account without one (a retail account) matches no username. */
function sameUsername(stored: string | null, presented: string): boolean {
  return stored !== null && constantTimeEqual(stored.toLowerCase(), presented.trim().toLowerCase());
}
