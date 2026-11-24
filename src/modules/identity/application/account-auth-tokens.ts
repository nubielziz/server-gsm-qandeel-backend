// AccountAuthTokenService: issues, takes, rotates and voids the one-time links of accounts (decision 064). One service for every rank:
// invitations, password resets, email verification and the sign-in link share one subject type (`account`), one lifetime and one set of
// rules (decision 019). It implements the `AccountAuthTokens` seam the sign-in, link, verification and admin use cases inject.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import { type DbExecutor, DbService, type Transaction, type TransactionContext } from '../../../infra/db';
import type { AuthToken } from '../db/schema';
import { MAX_LIVE_PUBLIC_LINKS } from '../domain/public-links';
import { insertAuthToken, voidUnusedTokensBeyondNewest } from '../infra/auth-token.repository';
import {
  PASSWORD_LINK_PURPOSES,
  consumeAccountToken,
  findAccountTokenByHash,
  findAccountTokenById,
  latestAccountTokenAt,
  lockUsableAccountToken,
  rotateAccountToken,
  voidOpenAccountTokens,
} from '../infra/account-token.repository';
import {
  ACCOUNT_TOKEN_PURPOSES,
  type AccountTokenPurpose,
  AccountAuthTokens,
  type IssueAccountTokenInput,
  type TakenAccountToken,
} from '../ports/account-auth-tokens';

/** A link is valid for one hour (decision 019, the map's "valid for one hour and one use"). */
export const ACCOUNT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** What {@link AccountAuthTokenService.issue} takes: the seam's input and, for a sign-in link, the asking browser. */
export interface IssueAccountLinkInput extends IssueAccountTokenInput {
  /**
   * The value of the cookie that marks the browser which asked for a sign-in link; only its keyed hash is stored, on the link's row, so the
   * exchange can tell that browser from another one. Only for `magic_link`; omitted for every other link.
   */
  readonly browserKey?: string;
}

/** An issued link. */
export interface IssuedAccountToken {
  /** The `auth_tokens` row id (the only thing an outbox event and the mail job carry). */
  readonly tokenId: number;
  /** The token the request made. It exists in clear text only here, once, and nobody receives it: the mail job rotates it (see `rotate`). */
  readonly token: string;
  readonly expiresAt: Date;
}

/** A link a flow took and locked: the seam's answer plus what the sign-in link flow also needs. */
export interface LockedAccountToken extends TakenAccountToken {
  /** The keyed hash of the asking browser's cookie, or `null` (see {@link AccountAuthTokenService.askedFrom}). */
  readonly browserHash: string | null;
  readonly expiresAt: Date;
}

/**
 * The link families: a newer link of a family replaces an older one.
 *
 * Why: sign-in links replace sign-in links, verifications replace verifications, and invitations and resets are one family (the newest
 * way to choose a password wins).
 */
function familyOf(purpose: AccountTokenPurpose): readonly AccountTokenPurpose[] {
  return purpose === 'invite' || purpose === 'reset' ? PASSWORD_LINK_PURPOSES : [purpose];
}

/**
 * Issues a link and voids the account's older unused ones of the same family.
 *
 * Why: the one writer of `auth_tokens` rows of accounts: the seam's service and the merchant compatibility class both call it, so the
 * rules cannot differ (256 random bits, only the keyed hash stored, one hour, one use, newest wins; up to three links a visitor asked
 * for work at once, decision 052).
 *
 * Side effects: inserts an `auth_tokens` row and marks the account's older unused links of the family used (all of them, or all but the
 * newest two with `keepEarlier`).
 *
 * @param tokens the token service (random token, keyed hash)
 * @param now the time from the injected clock
 * @param work the caller's transaction, so the token and the change that needs it commit together
 * @param input the account, the purpose and who sent it
 * @returns the row id, the token for the link and its expiry
 */
export async function issueAccountToken(
  tokens: TokenService,
  now: Date,
  work: Pick<TransactionContext, 'tx'>,
  input: IssueAccountLinkInput,
): Promise<IssuedAccountToken> {
  const token = tokens.random(32);
  // Void first: the unique hash index cannot clash, and "newest wins" holds even if two links are issued at once.
  if (input.keepEarlier) {
    await voidUnusedTokensBeyondNewest(work.tx, {
      subjectType: 'account',
      subjectId: input.accountId,
      purposes: familyOf(input.purpose),
      now,
      keep: MAX_LIVE_PUBLIC_LINKS - 1,
    });
  } else {
    await voidOpenAccountTokens(work.tx, input.accountId, familyOf(input.purpose), now);
  }
  const row = await insertAuthToken(work.tx, {
    purpose: input.purpose,
    subjectType: 'account',
    subjectId: input.accountId,
    tokenHash: tokens.hash(token),
    expiresAt: new Date(now.getTime() + ACCOUNT_TOKEN_TTL_MS),
    ip: input.ip ?? null,
    createdBy: input.createdBy ?? null,
    // Only a sign-in link names the browser that asked for it.
    browserHash:
      input.purpose === 'magic_link' && input.browserKey !== undefined ? tokens.hash(input.browserKey) : null,
    // The clock writes the time the staff list shows ("link sent at"), not the column default (decision 031).
    createdAt: now,
  });
  return { tokenId: row.id, token, expiresAt: row.expiresAt };
}

/**
 * The one place that owns the token rules for accounts.
 *
 * Why: invitations, password resets, email verification and the sign-in link of a merchant and of a shopper are one kind of credential
 * (decision 064): 256 random bits, only the keyed hash stored, one hour, one use, and only the newest link of a family works, except links
 * a visitor asked for: up to three of those work at once (decision 052). Every flow of every rank calls this class, and no other code reads
 * `auth_tokens` for an account.
 *
 * Side effects: reads and writes `auth_tokens` (rows of subject type `account` only).
 *
 * @see docs/decisions/019-encryption-and-token-hashing.md
 */
@Injectable()
export class AccountAuthTokenService extends AccountAuthTokens {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /**
   * Issues a link and voids the account's older unused ones of the same family.
   *
   * @param work the caller's transaction (`runInTransaction`)
   * @param input the account, the purpose, who sent it and (for a sign-in link) the asking browser's cookie value
   * @returns the row id, the token (a placeholder nobody receives: the mail job rotates it) and the expiry
   */
  issue(work: Pick<TransactionContext, 'tx'>, input: IssueAccountLinkInput): Promise<IssuedAccountToken> {
    return issueAccountToken(this.tokens, this.clock.now(), work, input);
  }

  /**
   * Finds the link of a token and locks it.
   *
   * Why: a flow that spends a link locks it first, so two requests with the same link cannot both pass the checks that follow. The
   * caller marks the link used in the same transaction (`voidOpenOf` of its purposes, or {@link consume}), so a failure after the take
   * rolls the take back and the link stays usable.
   *
   * Side effects: takes a `FOR UPDATE` lock on the `auth_tokens` row until the transaction ends.
   *
   * @param tx the caller's transaction
   * @param token the token as the visitor typed or followed it
   * @param purposes the purposes this flow accepts
   * @returns the link when it is of an account, unused, unexpired and of an accepted purpose; `undefined` otherwise
   */
  async take(
    tx: Transaction,
    token: string,
    purposes: readonly AccountTokenPurpose[],
  ): Promise<LockedAccountToken | undefined> {
    const row = await lockUsableAccountToken(tx, {
      tokenHash: this.tokens.hash(token),
      purposes,
      now: this.clock.now(),
    });
    // The query only returns a purpose of the list; reading it back from the list keeps the type honest.
    const purpose = purposes.find((accepted) => accepted === row?.purpose);
    if (row === undefined || purpose === undefined) return undefined;
    return {
      tokenId: row.id,
      accountId: row.subjectId,
      purpose,
      browserHash: row.browserHash,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Voids the open links of an account.
   *
   * @param tx the caller's transaction
   * @param accountId the account (or the guest row)
   * @param purposes the purposes to void; every purpose when omitted
   * @returns how many links were voided
   */
  voidOpenOf(
    tx: Transaction,
    accountId: number,
    purposes: readonly AccountTokenPurpose[] = ACCOUNT_TOKEN_PURPOSES,
  ): Promise<number> {
    return voidOpenAccountTokens(tx, accountId, purposes, this.clock.now());
  }

  /**
   * Tells whether a link was asked for by the browser that presents this cookie value.
   *
   * Why: a sign-in link opened in the browser that asked for it signs in at once; opened anywhere else it must not replace another
   * account's session, and the shop says whose account it opened.
   *
   * @param record the stored or taken link
   * @param browserKey the value of the asking-browser cookie the request carried, if any
   * @returns true only when the link stored a browser hash and the cookie's keyed hash equals it (compared in constant time)
   */
  askedFrom(record: { readonly browserHash: string | null }, browserKey: string | undefined): boolean {
    if (record.browserHash === null || browserKey === undefined) return false;
    return this.tokens.equals(record.browserHash, this.tokens.hash(browserKey));
  }

  /**
   * Finds the stored link behind a token from an email.
   *
   * @param token the token as the visitor sent it
   * @param db the database or a transaction (default: the pool)
   * @returns the row, used or not, or `undefined` for a token that is not an account's
   */
  findByHash(token: string, db: DbExecutor = this.db.db): Promise<AuthToken | undefined> {
    return findAccountTokenByHash(db, this.tokens.hash(token));
  }

  /**
   * Finds a stored link by its row id (the mail job's input).
   *
   * @param id the `auth_tokens` id
   * @param db the database or a transaction (default: the pool)
   * @returns the row, or `undefined` (a row of another subject type is not found)
   */
  findById(id: number, db: DbExecutor = this.db.db): Promise<AuthToken | undefined> {
    return findAccountTokenById(db, id);
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
    const rotated = await rotateAccountToken(this.db.db, id, this.tokens.hash(token), this.clock.now());
    return rotated ? token : undefined;
  }

  /**
   * Spends a link, once.
   *
   * @param work the caller's transaction
   * @param id the link row id
   * @returns true when this call used the link up, false when it was already used, expired, gone or is not an account's
   */
  async consume(work: Pick<TransactionContext, 'tx'>, id: number): Promise<boolean> {
    return (await consumeAccountToken(work.tx, id, this.clock.now())) !== undefined;
  }

  /**
   * Voids an account's unused links of the given purposes, optionally keeping one.
   *
   * @param work the caller's transaction
   * @param accountId the account id
   * @param purposes the kinds of link to void
   * @param exceptId a link row to keep
   * @returns how many links were voided
   */
  voidOpen(
    work: Pick<TransactionContext, 'tx'>,
    accountId: number,
    purposes: readonly AccountTokenPurpose[],
    exceptId?: number,
  ): Promise<number> {
    return voidOpenAccountTokens(work.tx, accountId, purposes, this.clock.now(), exceptId);
  }

  /**
   * Reads when an account's newest invitation or reset link was created.
   *
   * @param accountId the account id
   * @param db the database or a transaction (default: the pool)
   * @returns the time, or `null` when no such link was ever sent
   */
  passwordLinkSentAt(accountId: number, db: DbExecutor = this.db.db): Promise<Date | null> {
    return latestAccountTokenAt(db, accountId, PASSWORD_LINK_PURPOSES);
  }
}
