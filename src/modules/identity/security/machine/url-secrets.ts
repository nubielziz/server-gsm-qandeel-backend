// URL secrets (decision 018, 019): a webhook whose only credential is a secret in its URL path, such as the Telegram bot
// webhook `POST /webhooks/telegram/:secret`. The secret is stored hashed or encrypted and compared in constant time.
import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import { LogThrottle } from '../../../../common/log-throttle';
import { TokenService, constantTimeEqual } from '../../../../infra/crypto';
import type { AccessHandler } from '../access-handlers';
import type { AccessState } from '../access-state';

/**
 * The stored form of a URL secret.
 *
 * Why: decision 019 keeps credentials as keyed hashes, and secrets the system must send back out (supplier and gateway
 * credentials) encrypted. A URL secret that the system also registers with the provider (Telegram `setWebhook`) is stored
 * encrypted and handed over decrypted for the comparison; one it only checks can be stored as a hash.
 */
export type StoredUrlSecret =
  /** `TokenService.hash(secret)`, as 64 hex characters. */
  | { readonly form: 'hash'; readonly value: string }
  /** The secret itself, decrypted by the owning module for this comparison only. Never cache or log it. */
  | { readonly form: 'secret'; readonly value: string };

/**
 * Where the expected secret of one webhook route comes from.
 *
 * Why: the secret belongs to the module that owns the integration (notifications for Telegram); the identity module only
 * compares.
 */
export interface UrlSecretSource {
  /** The manifest key of the route, for example `POST /webhooks/telegram/:secret`. */
  readonly routeKey: string;
  /** The path parameter that holds the secret (default `secret`). */
  readonly param?: string;
  /**
   * Reads the stored secret.
   *
   * @returns the stored form, or `null`/`undefined` when none is configured (every request is then refused)
   */
  load(): Promise<StoredUrlSecret | null | undefined> | StoredUrlSecret | null | undefined;
}

const DEFAULT_PARAM = 'secret';
const MAX_SECRET_LENGTH = 256;
const WARN_INTERVAL_MS = 60_000;
/** Compared against when nothing is stored, so a missing configuration takes as long to refuse as a wrong secret. */
const NOTHING_STORED = 'no-secret-is-configured-for-this-route';

/**
 * The sources of the URL secrets, by route.
 *
 * Why: a registry like the capability tokens: P2.5c builds the guard, the module that owns the integration registers its
 * source in `onModuleInit`. A route without a source refuses every request.
 */
@Injectable()
export class UrlSecretVerifiers {
  private readonly sources = new Map<string, UrlSecretSource>();

  /**
   * Adds the source of a route's secret.
   *
   * @param source the route key and the loader of the stored secret
   * @throws {Error} when the route already has a source (a boot-time programming error)
   */
  register(source: UrlSecretSource): void {
    if (this.sources.has(source.routeKey)) {
      throw new Error(`A URL secret source for "${source.routeKey}" is already registered`);
    }
    this.sources.set(source.routeKey, source);
  }

  /**
   * Finds the source of a route.
   *
   * @param routeKey the manifest key of the route
   * @returns the source, or `undefined` when none is registered
   */
  get(routeKey: string): UrlSecretSource | undefined {
    return this.sources.get(routeKey);
  }
}

/**
 * Authenticates the routes whose credential is a secret in the URL.
 *
 * Why: a Telegram-style webhook cannot sign its requests; the long random path segment is the credential. The comparison is
 * constant time, a missing configuration is indistinguishable from a wrong secret, and the answer is the same `401` for both.
 */
export class UrlSecretAccessHandler implements AccessHandler {
  private readonly logger = new Logger(UrlSecretAccessHandler.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);

  constructor(
    private readonly sources: UrlSecretVerifiers,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Compares the secret of the URL with the stored one.
   *
   * @param request the Fastify request
   * @param contract the route contract (its key picks the source)
   * @returns an empty state: the webhook is not an account
   * @throws {AppError} `UNAUTHORIZED` (401) for a missing, wrong or unconfigured secret
   */
  async authenticate(request: FastifyRequest, contract: AnyRouteContract): Promise<AccessState> {
    const source = this.sources.get(contract.key);
    if (!source) {
      if (this.throttle.attempt(contract.key)) {
        this.logger.warn(`No URL secret source is registered for "${contract.key}": every request on it is refused`);
      }
      throw new AppError('UNAUTHORIZED');
    }
    const presented = (request.params as Record<string, unknown> | null | undefined)?.[source.param ?? DEFAULT_PARAM];
    const stored = await source.load();
    const usable = typeof presented === 'string' && presented.length > 0 && presented.length <= MAX_SECRET_LENGTH;
    const candidate = usable ? (stored?.form === 'hash' ? this.tokens.hash(presented) : presented) : '';
    // Always compare, whatever is missing, so the time does not tell a configured route from an unconfigured one.
    const equal = constantTimeEqual(candidate, stored?.value ?? NOTHING_STORED);
    if (!usable || !stored || !equal) throw new AppError('UNAUTHORIZED');
    return {};
  }
}
