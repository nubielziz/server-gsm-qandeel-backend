// The resolver of the checkout capability token (decision 010, 018): turns the token of a checkout link into the session it opens.
// It registers with the identity module's guard when this module starts (feature 14a).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { CapabilityTokenVault, TokenService } from '../../../infra/crypto';
import { CapabilityTokenResolvers, type CapabilityGrant, type CapabilityTokenResolver } from '../../identity';
import { findSessionByToken } from '../infra/checkout.repository';

/**
 * Opens a checkout session with its token.
 *
 * Why: `GET /store/v1/checkout-sessions/:token` and `.../consents` have no account behind them: the token in the path is the whole
 * credential (decision 010: 128 random bits, unique). The identity guard checks the token's shape and rate limits lookups per address;
 * this resolver finds the row by its keyed hash (decision 054; a row written before is found by its plain token until the seal pass
 * ran) and then compares the stored form with the presented one in constant time, so the answer for a wrong token does not depend on
 * how much of it matched.
 * It does not judge expiry or payment: an expired or paid session can still be read; the use cases decide what may still change.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class CheckoutTokenResolver implements CapabilityTokenResolver, OnModuleInit {
  readonly kind = 'checkout-token' as const;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly vault: CapabilityTokenVault,
    private readonly resolvers: CapabilityTokenResolvers,
  ) {}

  /** Registers the resolver with the guard of the `checkout-token` access kind. */
  onModuleInit(): void {
    this.resolvers.register(this);
  }

  /**
   * Looks the token up.
   *
   * @param token a token of the right shape
   * @returns the session it opens, or `null` for a token that names none
   */
  async resolve(token: string): Promise<CapabilityGrant | null> {
    const hash = this.vault.hashOf('checkout', token);
    const row = await findSessionByToken(this.db.db, { hash, token });
    if (row === undefined) return null;
    const granted =
      row.tokenHash !== null
        ? this.tokens.equals(row.tokenHash, hash)
        : row.token !== null && this.tokens.equals(row.token, token);
    return granted ? { id: row.id } : null;
  }
}
