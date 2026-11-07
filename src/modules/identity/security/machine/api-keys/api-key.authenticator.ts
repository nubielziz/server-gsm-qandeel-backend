// ApiKeyAuthenticator: turns a presented merchant API key into a principal (decision 018). REST v1 and the Dhru surface share
// it; they differ only in where the credentials are read and which scope the key needs.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../../../common/clock';
import { constantTimeEqual } from '../../../../../infra/crypto';
import { type IpAddress, formatIpAddress, ipRateLimitKey, parseIpAddress } from '../../../../../common/ip-address';
import type { Surface } from '../../../../../common/surface';
import { type RateLimitResult, RateLimitService, rateLimitedError } from '../../../../../infra/rate-limit';
import type { ApiKeyPrincipal } from '../../principal';
import { ApiKeyDirectory } from './api-key.directory';
import { type ApiKeyRefusalReason, type ApiKeyView, checkApiKey, refusalFor } from './api-key.rules';

/** What a route presents and needs. */
export interface ApiKeyCredentials {
  /** The key as the caller sent it; `undefined` when the request carries none. */
  readonly key: string | undefined;
  /** The Dhru username the key must belong to; `undefined` for REST v1, which names no username. */
  readonly username?: string | undefined;
  /** The scope the key must list. */
  readonly scope: string;
  /** The surface, which words the refusals (problem+json, or the Dhru envelope). */
  readonly surface: Surface;
  /**
   * Called with the key's own limit after the call was counted, whether it was allowed or not (REST v1 turns it into the
   * `RateLimit-*` headers). Not called for a refusal before the count (unknown key, wrong scope, address not allowed).
   */
  readonly onRateLimit?: ((result: RateLimitResult) => void) | undefined;
}

/**
 * Authenticates merchant API keys.
 *
 * Why: decision 018: `Authorization: Bearer <key>` (REST v1) and `username` + `apiaccesskey` (Dhru) both resolve an `api_keys` row
 * by keyed hash, then check revoked/expired, the merchant's status, `allowed_ips` (CIDR, IPv4 and IPv6), the scope and the
 * key's per-minute limit (decision 021; the limit is counted only after every other check passed, so a refused call costs the
 * merchant nothing). Unknown keys are counted per client address (the `ip` limiter, 300 a minute, under their own key) because
 * REST v1 and Dhru have no per-IP stage in the pipeline and an unknown key has no per-key limit to hit.
 *
 * Side effects: reads the key cache and, on a miss, `api_keys` and `clients`; counts points in the cache Redis; writes
 * `api_keys.last_used_at` at most once a minute; tells the caller the key's limit figures through `onRateLimit` (REST v1 sends
 * them as `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`).
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
   * @param credentials the key, the Dhru username if any, the scope the route needs and the surface
   * @returns the principal: merchant id, key id and scopes
   * @throws {AppError} `UNAUTHORIZED` (401: no, unknown, revoked or expired key, or a username that is not the key's),
   *   `ACCOUNT_SUSPENDED` (403), `ACCOUNT_PENDING_APPROVAL` (403: merchant not approved, B153), `FORBIDDEN` (403: the scope is missing),
   *   `IP_NOT_ALLOWED` (403),
   *   `RATE_LIMITED` (429 with `Retry-After`: the key's limit, or too many unknown keys from one address)
   */
  async authenticate(request: FastifyRequest, credentials: ApiKeyCredentials): Promise<ApiKeyPrincipal> {
    const { key, username, scope, surface, onRateLimit } = credentials;
    const address = parseIpAddress(request.ip);
    const refuse = (reason: ApiKeyRefusalReason) => refusalFor(reason, surface, address, scope);

    // Nothing was sent: refuse without a lookup and without counting (it costs us nothing).
    if (key === undefined) throw refuse('unauthenticated');
    const view = await this.directory.findByKey(key);
    if (!view || (username !== undefined && !sameUsername(view.client.username, username))) {
      await this.chargeFailure(address);
      throw refuse('unauthenticated');
    }

    const nowMs = this.clock.nowMs();
    const reason = checkApiKey(view, { nowMs, address, scope });
    if (reason) throw refuse(reason);

    // A stored limit below 1 is a data error (the limiter would throw): the limiter's default applies instead.
    const options =
      Number.isInteger(view.rateLimitPerMin) && view.rateLimitPerMin >= 1 ? { limit: view.rateLimitPerMin } : {};
    const limit = await this.limits.consume('api-key', String(view.id), 1, options);
    onRateLimit?.(limit);
    if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

    await this.touchQuietly(view, address ? formatIpAddress(address) : request.ip, nowMs);
    return {
      kind: 'api-key',
      clientId: view.clientId,
      clientName: view.client.name,
      keyId: view.id,
      scopes: view.scopes,
      ip: request.ip,
    };
  }

  /** Counts one point against the address that presented an unknown key; the budget used up is a `429`. */
  private async chargeFailure(address: IpAddress | undefined): Promise<void> {
    const result = await this.limits.consume('ip', `api-key-failures:${ipRateLimitKey(address)}`);
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

/** Dhru usernames are unique case-insensitively (`clients.username`). */
function sameUsername(stored: string, presented: string): boolean {
  return constantTimeEqual(stored.toLowerCase(), presented.trim().toLowerCase());
}
