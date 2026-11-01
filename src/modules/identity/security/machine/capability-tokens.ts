// Capability tokens (decision 010, 018): the checkout, tracking, ticket and sign-in link tokens of the storefront. The identity
// module extracts the token and asks the resolver the owning module registered; it knows no checkout, order or ticket table.
import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../common/contract';
import { AppError } from '../../../../common/errors';
import { LogThrottle } from '../../../../common/log-throttle';
import type { AccessHandler } from '../access-handlers';
import type { AccessState } from '../access-state';

/**
 * The access kinds whose credential is a capability token in the path or body.
 *
 * Why: the four storefront token kinds of the manifest. They share one guard; each kind has its own resolver because a
 * different module owns the record the token opens.
 */
export const CAPABILITY_ACCESS_KINDS = ['checkout-token', 'tracking-token', 'link-token', 'ticket-token'] as const;

/** One value of {@link CAPABILITY_ACCESS_KINDS}. */
export type CapabilityAccessKind = (typeof CAPABILITY_ACCESS_KINDS)[number];

/**
 * What a capability token opens.
 *
 * Why: the guard hands the handler the id the owning module found, so the handler does not look the token up again.
 */
export interface CapabilityGrant {
  /** The id of the record the token stands for (checkout session, order, support ticket, one-time sign-in token). */
  readonly id: number;
}

/**
 * Turns a token into the record it opens; the owning module registers one per access kind.
 *
 * Why: the checkout, tracking, ticket and link tokens live in tables of other modules (decision 016: a module never touches
 * another module's tables). The guard only extracts the token, checks its shape and asks.
 */
export interface CapabilityTokenResolver {
  /** The access kind this resolver serves. */
  readonly kind: CapabilityAccessKind;
  /**
   * Looks the token up. It must NOT consume it: a link token is single use, but the use case marks it used inside its own
   * transaction, together with the work it unlocks.
   *
   * @param token a token that has the right shape (22 to 128 characters of base64url)
   * @returns the grant, or `null` for a token that is unknown, expired, used or superseded
   */
  resolve(token: string): Promise<CapabilityGrant | null> | CapabilityGrant | null;
}

/** Tokens are random base64url strings (decisions 010, 019); anything else cannot be one and never reaches a resolver. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const WARN_INTERVAL_MS = 60_000;

/**
 * Reads the capability token of a request: the `token` path parameter, otherwise the `token` field of a JSON body.
 *
 * Why: tracking, checkout and ticket routes carry it in the path (`/store/v1/orders/:token`); the sign-in link routes
 * (`POST /store/v1/auth/verify`) carry it in the body. The guard runs before validation, so it reads the raw request.
 *
 * @param request the Fastify request
 * @returns the token when the request has one of the right shape, otherwise `undefined`
 */
export function capabilityTokenOf(request: Pick<FastifyRequest, 'params' | 'body'>): string | undefined {
  const fromPath = (request.params as Record<string, unknown> | null | undefined)?.token;
  const fromBody = (request.body as Record<string, unknown> | null | undefined)?.token;
  const token = typeof fromPath === 'string' ? fromPath : fromBody;
  return typeof token === 'string' && TOKEN_SHAPE.test(token) ? token : undefined;
}

/**
 * The refusal for a token that opens nothing.
 *
 * Why: one answer for malformed, unknown, expired and used tokens, so the response teaches an attacker nothing. It is not
 * `401`: a customer who holds a session and follows an old link must not be signed out (session-ending codes are about the
 * caller). A sign-in link says `410 TOKEN_INVALID`, the other tokens `404 NOT_FOUND`.
 *
 * @param kind the access kind of the route
 * @returns the error to throw
 */
export function capabilityRefusal(kind: CapabilityAccessKind): AppError {
  return kind === 'link-token'
    ? new AppError('TOKEN_INVALID')
    : new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
}

/**
 * The resolvers of the capability tokens.
 *
 * Why: P2.5c builds the guard, the owning modules fill the registry when their feature is built: orders (tracking), customers
 * (checkout, sign-in links) and support (tickets), each in `onModuleInit` with `register`. A kind without a resolver refuses
 * every request, which fails closed.
 */
@Injectable()
export class CapabilityTokenResolvers {
  private readonly logger = new Logger(CapabilityTokenResolvers.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);
  private readonly resolvers = new Map<CapabilityAccessKind, CapabilityTokenResolver>();

  /**
   * Adds the resolver of an access kind.
   *
   * @param resolver the resolver
   * @throws {Error} when the kind already has one (a boot-time programming error)
   */
  register(resolver: CapabilityTokenResolver): void {
    if (this.resolvers.has(resolver.kind)) {
      throw new Error(`A capability token resolver for "${resolver.kind}" is already registered`);
    }
    this.resolvers.set(resolver.kind, resolver);
  }

  /**
   * Tells whether a kind has a resolver.
   *
   * @param kind a capability access kind
   * @returns true once an owning module registered one
   */
  has(kind: CapabilityAccessKind): boolean {
    return this.resolvers.has(kind);
  }

  /**
   * Resolves a token.
   *
   * @param kind the access kind of the route
   * @param token a token of the right shape
   * @returns the grant, or `null` when the token opens nothing or no resolver is registered for the kind
   * @throws whatever the resolver throws (a database outage is a `5xx`, never a pass)
   */
  async resolve(kind: CapabilityAccessKind, token: string): Promise<CapabilityGrant | null> {
    const resolver = this.resolvers.get(kind);
    if (!resolver) {
      if (this.throttle.attempt(kind)) {
        this.logger.warn(`No capability token resolver is registered for "${kind}": every request on it is refused`);
      }
      return null;
    }
    return (await resolver.resolve(token)) ?? null;
  }
}

/**
 * Authenticates the routes of one capability access kind.
 *
 * Why: the token in the URL or body is the whole credential (decision 010); a valid one opens exactly the record it was
 * issued for, which the handler reads from the principal. Lookups are rate limited per client address before this runs (the
 * pipeline's `token` limiter).
 */
export class CapabilityAccessHandler implements AccessHandler {
  constructor(
    private readonly kind: CapabilityAccessKind,
    private readonly resolvers: CapabilityTokenResolvers,
  ) {}

  /**
   * Resolves the token of the request.
   *
   * @param request the Fastify request
   * @param _contract the route contract (unused: the kind decides)
   * @returns a capability principal carrying the id the resolver found
   * @throws {AppError} `TOKEN_INVALID` (410) for a sign-in link, `NOT_FOUND` (404) for the other tokens, when the token is
   *   missing, malformed, unknown, expired or used
   */
  async authenticate(request: FastifyRequest, _contract: AnyRouteContract): Promise<AccessState> {
    const token = capabilityTokenOf(request);
    const grant = token === undefined ? null : await this.resolvers.resolve(this.kind, token);
    if (!grant) throw capabilityRefusal(this.kind);
    return { principal: { kind: 'capability', access: this.kind, resourceId: grant.id, ip: request.ip } };
  }
}
