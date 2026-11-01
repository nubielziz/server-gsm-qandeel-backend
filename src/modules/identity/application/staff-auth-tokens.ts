// StaffAuthTokens: issues the one-time invite and reset links of staff members (route group staff sign-in, decision 019).
// Feature 2a (staff management) calls `issue` when it adds a member by invitation or sends a reset; the tests use it too.
import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infra/crypto';
import type { TransactionContext } from '../../../infra/db';
import { insertAuthToken, voidOpenStaffTokens, type StaffTokenPurpose } from '../infra/auth-token.repository';

/** A staff link is valid for one hour (decision 019, the map's "valid for one hour and one use"). */
export const STAFF_TOKEN_TTL_MS = 60 * 60 * 1000;

/** What `issue` takes. */
export interface IssueStaffTokenInput {
  /** The staff member the link is for. */
  readonly staffId: number;
  /** `invite` for a new member, `reset` for a forgotten password. */
  readonly purpose: StaffTokenPurpose;
  /** The staff member who sends the link; null for a link nobody sent (the setup tools). */
  readonly createdBy?: number | null;
  /** The IP of the request that created the link, for the record. */
  readonly ip?: string | null;
}

/** An issued link token. */
export interface IssuedStaffToken {
  /** The token for the link `<console>/set-password?token=...`. It exists in clear text only here, once. */
  readonly token: string;
  /** The `auth_tokens` row id. */
  readonly id: number;
  readonly expiresAt: Date;
}

/**
 * Creates invite and reset tokens for staff members.
 *
 * Why: `POST /admin/auth/password/set` accepts a token from an emailed link (B3). Staff management (feature 2a) creates the
 * link; this service owns the token rules in one place: 256 random bits, only the keyed hash stored, one hour, one use, and
 * only the newest link of an account works.
 *
 * Side effects: inserts an `auth_tokens` row and marks the account's older unused tokens used.
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class StaffAuthTokens {
  constructor(private readonly tokens: TokenService) {}

  /**
   * Issues a token and voids the account's older unused ones.
   *
   * Why: a new invitation or reset replaces the old link (the console shows "link sent / expired" from the newest token).
   *
   * @param work the caller's transaction (`runInTransaction`), so the token and the staff change commit together
   * @param input the account, the purpose and who sent it
   * @returns the token for the link and its expiry
   */
  async issue(work: Pick<TransactionContext, 'tx'>, input: IssueStaffTokenInput): Promise<IssuedStaffToken> {
    const now = new Date();
    const token = this.tokens.random(32);
    // Void first: the unique hash index cannot clash, and "newest wins" holds even if two links are issued at once.
    await voidOpenStaffTokens(work.tx, input.staffId, now);
    const row = await insertAuthToken(work.tx, {
      purpose: input.purpose,
      subjectType: 'staff',
      subjectId: input.staffId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + STAFF_TOKEN_TTL_MS),
      ip: input.ip ?? null,
      createdBy: input.createdBy ?? null,
    });
    return { token, id: row.id, expiresAt: row.expiresAt };
  }
}
