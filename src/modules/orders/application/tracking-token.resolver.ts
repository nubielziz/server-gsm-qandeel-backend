// The resolver of the tracking capability token (decision 010, 018): turns the token of a tracking link into the order it opens.
// It registers with the identity module's guard when this module starts (feature 14a).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { TokenService } from '../../../infra/crypto';
import { CapabilityTokenResolvers, type CapabilityGrant, type CapabilityTokenResolver } from '../../identity';
import { findOrderByTrackingToken } from '../infra/tracking.repository';

/**
 * Opens an order with its tracking token.
 *
 * Why: `GET /store/v1/orders/:token` has no account behind it: the token in the path (`orders.public_token`, 128 random bits, unique,
 * stored as is so the link can be sent again, decision 010) is the whole credential. The identity guard checks the token's shape
 * and rate limits lookups per address (30 a minute); this resolver finds the row by the unique index and compares the stored token
 * with the presented one in constant time. A merchant order has no token, so it can never be opened this way.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class TrackingTokenResolver implements CapabilityTokenResolver, OnModuleInit {
  readonly kind = 'tracking-token' as const;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly resolvers: CapabilityTokenResolvers,
  ) {}

  /** Registers the resolver with the guard of the `tracking-token` access kind. */
  onModuleInit(): void {
    this.resolvers.register(this);
  }

  /**
   * Looks the token up.
   *
   * @param token a token of the right shape
   * @returns the order it opens, or `null` for a token that names none
   */
  async resolve(token: string): Promise<CapabilityGrant | null> {
    const row = await findOrderByTrackingToken(this.db.db, token);
    return row !== undefined && this.tokens.equals(row.token, token) ? { id: row.id } : null;
  }
}
