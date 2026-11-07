// MerchantAuthTokens: issues the one-time links of merchants (email verification, password reset, invitation; decision 019,
// resolution identity-platform-2). Feature 2a calls it for the invite link of POST /admin/clients.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import type { TransactionContext } from '../../../infra/db';
import { insertAuthToken } from '../infra/auth-token.repository';
import {
  type ClientTokenPurpose,
  PASSWORD_LINK_PURPOSES,
  voidOpenClientTokens,
} from '../infra/merchant-token.repository';

/** A merchant link is valid for one hour (decision 019, the map's "valid for one hour and one use"). */
export const MERCHANT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** What `issue` takes. */
export interface IssueMerchantTokenInput {
  /** The merchant the link is for. */
  readonly clientId: number;
  /** `verify_email` after registration, `reset` for a forgotten password, `invite` when staff created the merchant. */
  readonly purpose: ClientTokenPurpose;
  /** The staff member who created the invitation; null for a link nobody sent (registration, forgot password). */
  readonly createdBy?: number | null;
  /** The IP of the request that created the link, for the record. */
  readonly ip?: string | null;
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
 * Creates verification, reset and invite tokens for merchants.
 *
 * Why: one place owns the token rules for the merchant portal: 256 random bits, only the keyed hash stored, one hour, one use,
 * and only the newest link of a kind works (a reset or invite replaces an older reset or invite; a verification replaces an
 * older verification).
 *
 * Side effects: inserts an `auth_tokens` row and marks the merchant's older unused tokens of the same family used.
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
    const now = this.clock.now();
    const token = this.tokens.random(32);
    // Void first: the unique hash index cannot clash, and "newest wins" holds even if two links are issued at once.
    const family: readonly ClientTokenPurpose[] =
      input.purpose === 'verify_email' ? ['verify_email'] : PASSWORD_LINK_PURPOSES;
    await voidOpenClientTokens(work.tx, input.clientId, family, now);
    const row = await insertAuthToken(work.tx, {
      purpose: input.purpose,
      subjectType: 'client',
      subjectId: input.clientId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + MERCHANT_TOKEN_TTL_MS),
      ip: input.ip ?? null,
      createdBy: input.createdBy ?? null,
    });
    return { token, id: row.id, expiresAt: row.expiresAt };
  }
}
