// MerchantInvites: issues the one-hour invite link token of a new merchant (route POST /admin/clients, RESOLUTIONS
// identity-platform-2). The merchant consumes it with POST /client/auth/password/reset (feature 2b).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import type { TransactionContext } from '../../../infra/db';
import { insertAuthToken } from '../infra/auth-token.repository';

/** An invite link is valid for one hour and one use (decisions 010 and 019). */
export const MERCHANT_INVITE_TTL_MS = 60 * 60 * 1000;

/** An issued invite. */
export interface IssuedMerchantInvite {
  /** The token for the link `<PORTAL_BASE_URL>/set-password?token=...`. It exists in clear text only here, once. */
  readonly token: string;
  /** The `auth_tokens` row id (the only thing the outbox event carries). */
  readonly id: number;
  readonly expiresAt: Date;
}

/**
 * Creates invite tokens for merchants.
 *
 * Why: RESOLUTIONS identity-platform-2: the invite is an `auth_tokens` row (purpose `invite`, subject type `client`, keyed hash
 * only, one hour). A merchant who misses the hour uses "forgot password", which also works for a pending merchant with no
 * password yet.
 *
 * Side effects: inserts an `auth_tokens` row.
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class MerchantInvites {
  constructor(
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issues an invite token.
   *
   * @param work the caller's transaction, so the token and the merchant commit together
   * @param input the merchant, the staff member who invites and the request address
   * @returns the token (for the link) and the row id
   */
  async issue(
    work: Pick<TransactionContext, 'tx'>,
    input: { readonly clientId: number; readonly createdBy: number; readonly ip: string },
  ): Promise<IssuedMerchantInvite> {
    const token = this.tokens.random(32);
    const now = this.clock.now();
    const row = await insertAuthToken(work.tx, {
      purpose: 'invite',
      subjectType: 'client',
      subjectId: input.clientId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + MERCHANT_INVITE_TTL_MS),
      // From the clock, like the expiry measured from it (decision 031).
      createdAt: now,
      ip: input.ip,
      createdBy: input.createdBy,
    });
    return { token, id: row.id, expiresAt: row.expiresAt };
  }
}
