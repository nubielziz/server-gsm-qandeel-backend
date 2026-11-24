// MerchantAuthTokens: the old entry of the merchant links (email verification, password reset, invitation; decision 019, resolution
// identity-platform-2), kept until the contract release (decision 064). A merchant is an account: the rules live in `issueAccountToken`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import type { TransactionContext } from '../../../infra/db';
import type { ClientTokenPurpose } from '../infra/merchant-token.repository';
import { ACCOUNT_TOKEN_TTL_MS, issueAccountToken } from './account-auth-tokens';

/** A merchant link is valid for one hour (decision 019, the map's "valid for one hour and one use"): the account link's lifetime. */
export const MERCHANT_TOKEN_TTL_MS = ACCOUNT_TOKEN_TTL_MS;

/** What `issue` takes. */
export interface IssueMerchantTokenInput {
  /** The merchant the link is for (an account id). */
  readonly clientId: number;
  /** `verify_email` when the merchant asks for a new link or staff change its address, `reset` for a forgotten password, `invite` when staff created the merchant. */
  readonly purpose: ClientTokenPurpose;
  /** The staff member who created the invitation; null for a link nobody sent (forgot password, verification). */
  readonly createdBy?: number | null;
  /** The IP of the request that created the link, for the record. */
  readonly ip?: string | null;
  /**
   * Keep the two newest unused links of the family instead of voiding every older one, so at most three work at once and the oldest
   * goes first (decision 052). Only for a link the visitor asked for (forgot password). Every other issue keeps "newest wins".
   */
  readonly keepEarlier?: boolean;
}

/** An issued link token. */
export interface IssuedMerchantToken {
  /** The token for the link. It exists in clear text only here, once. */
  readonly token: string;
  /** The `auth_tokens` row id (the only thing the outbox event and the mail job carry). */
  readonly id: number;
  readonly expiresAt: Date;
}

/**
 * Creates verification, reset and invite tokens for merchants, for the callers that have not moved to `AccountAuthTokens` yet.
 *
 * Why: the same rules and the same rows as the seam (`issueAccountToken`), under the old input and answer shapes, so the admin-area
 * files that call it compile unchanged until the contract release.
 *
 * Side effects: inserts an `auth_tokens` row and marks the account's older unused links of the same family used.
 *
 * Kept until the contract release; new code uses `AccountAuthTokens`.
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class MerchantAuthTokens {
  constructor(
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issues a token and voids the merchant's older unused ones of the same family.
   *
   * @param work the caller's transaction (`runInTransaction`), so the token and the change that needs it commit together
   * @param input the merchant, the purpose and who sent it
   * @returns the token for the link, its row id and its expiry
   */
  async issue(work: Pick<TransactionContext, 'tx'>, input: IssueMerchantTokenInput): Promise<IssuedMerchantToken> {
    const issued = await issueAccountToken(this.tokens, this.clock.now(), work, {
      accountId: input.clientId,
      purpose: input.purpose,
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.keepEarlier ? { keepEarlier: true } : {}),
    });
    return { token: issued.token, id: issued.tokenId, expiresAt: issued.expiresAt };
  }
}
