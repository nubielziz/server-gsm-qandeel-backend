// The resolver of the ticket capability token (decision 010, 018): turns the token of a ticket page link into the ticket it opens. It
// registers with the identity module's guard when the support store module starts (feature 17).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { CapabilityTokenResolvers, type CapabilityGrant, type CapabilityTokenResolver } from '../../identity';
import { findTicketByToken } from '../infra/ticket.repository';

/**
 * Opens a ticket with its token.
 *
 * Why: `GET /store/v1/tickets/:token` and its two writes have no account behind them: the token in the path is the whole credential
 * (decision 010: 128 random bits, unique, stored as issued so the link in an email keeps working). The identity guard checks the token's
 * shape and rate limits lookups per address; this resolver finds the row by the unique index and then compares the stored token with the
 * presented one in constant time, so the answer for a wrong token does not depend on how much of it matched. It does not judge the
 * ticket's state: a resolved ticket can still be read, answered (it reopens) and rated.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class TicketTokenResolver implements CapabilityTokenResolver, OnModuleInit {
  readonly kind = 'ticket-token' as const;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly resolvers: CapabilityTokenResolvers,
  ) {}

  /** Registers the resolver with the guard of the `ticket-token` access kind. */
  onModuleInit(): void {
    this.resolvers.register(this);
  }

  /**
   * Looks the token up.
   *
   * @param token a token of the right shape
   * @returns the ticket it opens, or `null` for a token that names none
   */
  async resolve(token: string): Promise<CapabilityGrant | null> {
    const row = await findTicketByToken(this.db.db, token);
    return row !== undefined && this.tokens.equals(row.token, token) ? { id: row.id } : null;
  }
}
