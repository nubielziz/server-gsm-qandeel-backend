// CustomerAuthTokens: issues, finds and spends the one-time links of storefront customers (sign-in links, invitations, password
// resets, email verification; decision 019). The customers module calls it: `auth_tokens` belongs to identity.
import { Inject, Injectable } from '@nestjs/common';
import type { AuthToken } from '../db/schema';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
import { MAX_LIVE_PUBLIC_LINKS } from '../domain/public-links';
import { insertAuthToken, voidUnusedTokensBeyondNewest } from '../infra/auth-token.repository';
import {
  CUSTOMER_PASSWORD_LINK_PURPOSES,
  type CustomerTokenPurpose,
  consumeCustomerToken,
  findCustomerTokenByHash,
  findCustomerTokenById,
  latestCustomerTokenAt,
  rotateCustomerToken,
  voidOpenCustomerTokens,
} from '../infra/customer-token.repository';

/** A customer link is valid for one hour (decision 019, the map's "valid for one hour and one use"). */
export const CUSTOMER_TOKEN_TTL_MS = 60 * 60 * 1000;

/** What `issue` takes. */
export interface IssueCustomerTokenInput {
  /** The customer the link is for. */
  readonly customerId: number;
  /** `magic_link` to sign in, `invite` or `reset` to choose a password, `verify_email` after an address change. */
  readonly purpose: CustomerTokenPurpose;
  /** The staff member who sent the link; null for a link the customer asked for. */
  readonly createdBy?: number | null;
  /** The IP of the request that created the link, for the record. */
  readonly ip?: string | null;
  /**
   * Keep the two newest unused links of the family instead of voiding every older one, so at most three work at once and the oldest
   * goes first (decision 052). Only for a link the visitor asked for (the sign-in link, forgot password): a stranger who asks again must
   * not void the link the owner was sent. Every other issue keeps "newest wins".
   */
  readonly keepEarlier?: boolean;
  /**
   * The value of the cookie that marks the browser which asked for a storefront sign-in link; only its keyed hash is stored, on the
   * link's row, so the exchange can tell that browser from another one. Omitted for every other link.
   */
  readonly browserKey?: string;
}

/** An issued link token. */
export interface IssuedCustomerToken {
  /** The token the request made. It exists in clear text only here, once, and nobody receives it: the mail job rotates it (see `rotate`). */
  readonly token: string;
  /** The `auth_tokens` row id (the only thing the outbox event and the mail job carry). */
  readonly id: number;
  readonly expiresAt: Date;
}

/** A stored customer link as the use cases judge it. */
export type CustomerTokenRecord = AuthToken;

/**
 * Tells whether a stored link can still be used.
 *
 * @param record the stored link
 * @param nowMs the clock's time in milliseconds
 * @returns true for a link that is unused and not expired
 */
export function isUsableLink(record: Pick<AuthToken, 'usedAt' | 'expiresAt'>, nowMs: number): boolean {
  return record.usedAt === null && record.expiresAt.getTime() > nowMs;
}

/**
 * The link families: a newer link of a family replaces an older one.
 *
 * Why: magic links replace magic links, verifications replace verifications, and invitations and resets are one family (the
 * newest way to choose a password wins).
 */
function familyOf(purpose: CustomerTokenPurpose): readonly CustomerTokenPurpose[] {
  return purpose === 'invite' || purpose === 'reset' ? CUSTOMER_PASSWORD_LINK_PURPOSES : [purpose];
}

/**
 * The one place that owns the token rules for storefront customers.
 *
 * Why: 256 random bits, only the keyed hash stored, one hour, one use, and only the newest link of a family works, except links a
 * visitor asked for: up to three of those work at once (decision 052). The customers module (store sign-in, the admin customer
 * routes, the mail job) needs these rules but not the `auth_tokens` table.
 *
 * Side effects: reads and writes `auth_tokens` (rows of subject type `customer` only).
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class CustomerAuthTokens {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issues a link and voids the customer's older unused ones of the same family (all of them, or all but the newest two with `keepEarlier`).
   *
   * @param work the caller's transaction, so the token and the change that needs it commit together
   * @param input the customer, the purpose and who sent it
   * @returns the token for the link, its row id and its expiry
   */
  async issue(work: Pick<TransactionContext, 'tx'>, input: IssueCustomerTokenInput): Promise<IssuedCustomerToken> {
    const now = this.clock.now();
    const token = this.tokens.random(32);
    // Void first: the unique hash index cannot clash, and "newest wins" holds even if two links are issued at once.
    if (input.keepEarlier) {
      await voidUnusedTokensBeyondNewest(work.tx, {
        subjectType: 'customer',
        subjectId: input.customerId,
        purposes: familyOf(input.purpose),
        now,
        keep: MAX_LIVE_PUBLIC_LINKS - 1,
      });
    } else {
      await voidOpenCustomerTokens(work.tx, input.customerId, familyOf(input.purpose), now);
    }
    const row = await insertAuthToken(work.tx, {
      purpose: input.purpose,
      subjectType: 'customer',
      subjectId: input.customerId,
      tokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + CUSTOMER_TOKEN_TTL_MS),
      ip: input.ip ?? null,
      createdBy: input.createdBy ?? null,
      browserHash: input.browserKey === undefined ? null : this.tokens.hash(input.browserKey),
      // The clock writes the time the staff list shows ("link sent at"), not the column default (decision 031).
      createdAt: now,
    });
    return { token, id: row.id, expiresAt: row.expiresAt };
  }

  /**
   * Tells whether a link was asked for by the browser that presents this cookie value.
   *
   * Why: a sign-in link opened in the browser that asked for it signs in at once; opened anywhere else it must not replace another
   * customer's session, and the shop says whose account it opened.
   *
   * @param record the stored link
   * @param browserKey the value of the asking-browser cookie the request carried, if any
   * @returns true only when the link stored a browser hash and the cookie's keyed hash equals it (compared in constant time)
   */
  askedFrom(record: Pick<AuthToken, 'browserHash'>, browserKey: string | undefined): boolean {
    if (record.browserHash === null || browserKey === undefined) return false;
    return this.tokens.equals(record.browserHash, this.tokens.hash(browserKey));
  }

  /**
   * Finds the stored link behind a token from an email.
   *
   * @param token the token as the customer sent it
   * @param db the database or a transaction (default: the pool)
   * @returns the row, used or not, or `undefined` for a token that is not a customer's
   */
  find(token: string, db: DbExecutor = this.db.db): Promise<CustomerTokenRecord | undefined> {
    return findCustomerTokenByHash(db, this.tokens.hash(token));
  }

  /**
   * Finds a stored link by its row id (the mail job's input).
   *
   * @param id the `auth_tokens` id
   * @param db the database or a transaction (default: the pool)
   * @returns the row, or `undefined`
   */
  findById(id: number, db: DbExecutor = this.db.db): Promise<CustomerTokenRecord | undefined> {
    return findCustomerTokenById(db, id);
  }

  /**
   * Gives a link that is still usable a new random token, and returns it in clear text.
   *
   * Why: the request's token is a placeholder that no one received (the clear value is never kept, decision 019), so the mail job makes
   * the value that goes into the mail here, inside the job, and stores only its hash on the same row (same id, same expiry). Only the
   * unused, unexpired row is rotated, so a link used, voided or expired since the job read it never gets a new secret.
   *
   * Side effects: updates `auth_tokens.token_hash` (and `updated_at`) of the row.
   *
   * @param id the link row id
   * @returns the new clear token, or `undefined` when the link was not usable any more
   */
  async rotate(id: number): Promise<string | undefined> {
    const token = this.tokens.random(32);
    const rotated = await rotateCustomerToken(this.db.db, id, this.tokens.hash(token), this.clock.now());
    return rotated ? token : undefined;
  }

  /**
   * Spends a link, once.
   *
   * @param work the caller's transaction
   * @param id the link row id
   * @returns true when this call used the link up, false when it was already used, expired or is gone
   */
  async consume(work: Pick<TransactionContext, 'tx'>, id: number): Promise<boolean> {
    return (await consumeCustomerToken(work.tx, id, this.clock.now())) !== undefined;
  }

  /**
   * Voids a customer's unused links of the given purposes, optionally keeping one.
   *
   * @param work the caller's transaction
   * @param customerId the customer id
   * @param purposes the kinds of link to void
   * @param exceptId a link row to keep
   * @returns how many links were voided
   */
  voidOpen(
    work: Pick<TransactionContext, 'tx'>,
    customerId: number,
    purposes: readonly CustomerTokenPurpose[],
    exceptId?: number,
  ): Promise<number> {
    return voidOpenCustomerTokens(work.tx, customerId, purposes, this.clock.now(), exceptId);
  }

  /**
   * Reads when a customer's newest invitation or reset link was created.
   *
   * @param customerId the customer id
   * @param db the database or a transaction (default: the pool)
   * @returns the time, or `null` when no such link was ever sent
   */
  passwordLinkSentAt(customerId: number, db: DbExecutor = this.db.db): Promise<Date | null> {
    return latestCustomerTokenAt(db, customerId, CUSTOMER_PASSWORD_LINK_PURPOSES);
  }
}
