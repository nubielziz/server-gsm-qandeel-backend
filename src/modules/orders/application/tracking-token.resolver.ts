// The resolver of the tracking capability token (decision 010, 018): turns the token of a tracking link into the order it opens.
// It registers with the identity module's guard when this module starts (feature 14a).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { CapabilityTokenVault, TokenService } from '../../../infra/crypto';
import { CapabilityTokenResolvers, type CapabilityGrant, type CapabilityTokenResolver } from '../../identity';
import { findOrderByTrackingToken } from '../infra/tracking.repository';
import { TrackingCustomerPorts } from './tracking-customer-port';

/**
 * Opens an order with its tracking token.
 *
 * Why: `GET /store/v1/orders/:token` has no account behind it: the token in the path (128 random bits, unique, decision 010) is the
 * whole credential. The identity guard checks the token's shape and rate limits lookups per address (30 a minute); this resolver finds
 * the row by its keyed hash (decision 054; an order placed before is found by its plain token until the seal pass ran) and compares
 * the stored form with the presented one in constant time. A merchant order has no token, so it can never be opened this way. The order
 * of an anonymized customer opens nothing (the customers module answers through `TrackingCustomerPorts`): after the erasure its link is
 * an unknown link, for the status, the result and the receipt alike.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class TrackingTokenResolver implements CapabilityTokenResolver, OnModuleInit {
  readonly kind = 'tracking-token' as const;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly vault: CapabilityTokenVault,
    private readonly resolvers: CapabilityTokenResolvers,
    private readonly customers: TrackingCustomerPorts,
  ) {}

  /** Registers the resolver with the guard of the `tracking-token` access kind. */
  onModuleInit(): void {
    this.resolvers.register(this);
  }

  /**
   * Looks the token up.
   *
   * @param token a token of the right shape
   * @returns the order it opens, or `null` for a token that names none or an order whose customer was anonymized
   */
  async resolve(token: string): Promise<CapabilityGrant | null> {
    const hash = this.vault.hashOf('tracking', token);
    const row = await findOrderByTrackingToken(this.db.db, { hash, token });
    if (row === undefined) return null;
    const granted =
      row.tokenHash !== null
        ? this.tokens.equals(row.tokenHash, hash)
        : row.token !== null && this.tokens.equals(row.token, token);
    if (!granted) return null;
    if (row.customerId !== null && (await this.customers.get().isErased(this.db.db, row.customerId))) return null;
    return { id: row.id };
  }
}
