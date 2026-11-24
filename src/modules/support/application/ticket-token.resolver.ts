// The resolver of the ticket capability token (decision 010, 018): turns the token of a ticket page link into the ticket it opens. It
// registers with the identity module's guard when the support store module starts (feature 17).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { CapabilityTokenVault, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { CapabilityTokenResolvers, type CapabilityGrant, type CapabilityTokenResolver } from '../../identity';
import { ticketLinkOpen } from '../domain/ticket-link';
import { findTicketByToken } from '../infra/ticket.repository';

/**
 * Opens a ticket with its token.
 *
 * Why: `GET /store/v1/tickets/:token` and its two writes have no account behind them: the token in the path is the whole credential
 * (decision 010: 128 random bits, unique). The identity guard checks the token's shape and rate limits lookups per address; this resolver
 * finds the row by its keyed hash (decision 054; a ticket opened before is found by its plain token until the seal pass ran) and then
 * compares the stored form with the presented one in constant time, so the answer for a wrong token does not depend on how much of it
 * matched. A ticket's link stops working 180 days after the ticket was resolved (decision 054, `TICKET_LINK_DAYS_AFTER_RESOLUTION`): the
 * guard then answers the same `404` as for an unknown token; reopening the ticket opens it again. Within that time a resolved ticket can
 * still be read, but takes no message or upload from its holder (B220: `409 TICKET_RESOLVED`, decided by the services).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class TicketTokenResolver implements CapabilityTokenResolver, OnModuleInit {
  readonly kind = 'ticket-token' as const;

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly vault: CapabilityTokenVault,
    private readonly resolvers: CapabilityTokenResolvers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the resolver with the guard of the `ticket-token` access kind. */
  onModuleInit(): void {
    this.resolvers.register(this);
  }

  /**
   * Looks the token up.
   *
   * @param token a token of the right shape
   * @returns the ticket it opens, or `null` for a token that names none or a link that has ended
   */
  async resolve(token: string): Promise<CapabilityGrant | null> {
    const hash = this.vault.hashOf('ticket', token);
    const row = await findTicketByToken(this.db.db, { hash, token });
    if (row === undefined) return null;
    const granted =
      row.tokenHash !== null
        ? this.tokens.equals(row.tokenHash, hash)
        : row.token !== null && this.tokens.equals(row.token, token);
    // Decision 054: a resolved ticket's link ends 180 days after the resolution; the refusal is the same as for an unknown token.
    return granted && ticketLinkOpen(row.resolvedAt, this.clock.nowMs()) ? { id: row.id } : null;
  }
}
