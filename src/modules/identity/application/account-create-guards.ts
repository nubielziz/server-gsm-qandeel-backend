// AccountCreateChecks: the gate in front of every write that gives an email a login row (the staff create, "Make an account" and an email
// change of an account): the email rule of the two partitions of `clients`, then the checks other modules registered with
// `AccountCreateGuards` (the blocklist).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import type { Transaction } from '../../../infra/db';
import { AccountDirectory } from '../accounts/account-directory';
import type { RankKind } from '../ports/rank-kind';
import {
  EMAIL_CONFLICT_MESSAGES,
  type EmailConflictCode,
  type EmailRuling,
  emailRuleForChange,
  emailRuleForCreate,
  emailRuleForMakeAccount,
} from '../domain/account-rules';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountCreateGuards } from '../ports/account-create-guards';

/**
 * The error of an email that cannot be given to a login row.
 *
 * Why: the console tells the conflicts apart by `errors[].code`: `taken` (another login row), `guest` (a retail create: use "Make an
 * account" on the guest row instead) and `login_exists` ("Make an account" on a guest whose email another login row holds).
 *
 * @param code the conflict
 * @param email the email, for the sentence
 * @returns the `409 EMAIL_TAKEN` to throw
 */
export function emailConflictError(code: EmailConflictCode, email: string): AppError {
  const message = EMAIL_CONFLICT_MESSAGES[code];
  return new AppError('EMAIL_TAKEN', {
    detail: code === 'taken' ? `${email} already belongs to another account.` : message,
    errors: [{ field: 'email', code, message }],
  });
}

/** What an admitted write has to finish: the guest row of the email whose open links the write voids. */
export interface Admitted {
  /** The guest row of the email, when its open email links must be voided in this transaction. */
  readonly guestIdToVoid: number | undefined;
}

/**
 * Applies the email rules and the registered checks before a write gives an email a login row.
 *
 * Why: decision 064. An email is unique among the rows with a login and, separately, among the guest rows, so a write reads the two
 * partitions through `AccountDirectory` (the one reader of an account by email) and judges them with the pure rules of
 * `domain/account-rules.ts`. A write that gives the email a login row also voids the open sign-in links of the guest row of that email, so a
 * mail sent to the guest row earlier can no longer turn it into a second login row. The checks of other modules (a blocklisted email
 * cannot get an account) run last through `AccountCreateGuards`.
 *
 * Side effects: reads `clients`; `voidGuestLinks` marks the guest row's open `magic_link` links used.
 */
@Injectable()
export class AccountCreateChecks {
  constructor(
    private readonly directory: AccountDirectory,
    private readonly guards: AccountCreateGuards,
    private readonly tokens: AccountAuthTokens,
  ) {}

  /**
   * Admits the create of an account with a login.
   *
   * @param tx the create's transaction
   * @param facts the email as normalised and the kind of the rank
   * @returns the guest row whose links the create voids, when a merchant create meets a guest row of the email
   * @throws {AppError} `EMAIL_TAKEN` (409, code `taken` or `guest`), or the refusal of a registered check (the blocklist: 422 on `email`)
   */
  async admitCreate(
    tx: Transaction,
    facts: { readonly email: string; readonly rankKind: RankKind },
  ): Promise<Admitted> {
    const login = await this.directory.findLoginByEmail(tx, facts.email);
    const guest = await this.directory.findGuestByEmail(tx, facts.email);
    const ruling = emailRuleForCreate({ login: login !== undefined, guest: guest !== undefined }, facts.rankKind);
    const guestIdToVoid = this.settle(ruling, facts.email, guest?.id);
    await this.guards.run(tx, facts);
    return { guestIdToVoid };
  }

  /**
   * Admits the new email of an account.
   *
   * @param tx the edit's transaction
   * @param facts the account, whether it has a login, the new email and its rank kind
   * @returns the guest row whose links the change voids (a login row that takes the email of a guest row)
   * @throws {AppError} `EMAIL_TAKEN` (409, code `taken`: another login row holds the email, or a guest row is given the email of another
   *   guest row or of a login row), or the refusal of a registered check (a blocklisted email: 422)
   */
  async admitEmailChange(
    tx: Transaction,
    facts: {
      readonly accountId: number;
      readonly hasAccount: boolean;
      readonly email: string;
      readonly rankKind: RankKind;
    },
  ): Promise<Admitted> {
    const login = await this.directory.findLoginByEmail(tx, facts.email);
    const guest = await this.directory.findGuestByEmail(tx, facts.email);
    // Another row: the account itself does not count against its own email.
    const otherLogin = login !== undefined && login.id !== facts.accountId;
    const otherGuest = guest !== undefined && guest.id !== facts.accountId;
    const ruling = emailRuleForChange({ login: otherLogin, guest: otherGuest }, facts.hasAccount);
    const guestIdToVoid = this.settle(ruling, facts.email, guest !== undefined && otherGuest ? guest.id : undefined);
    await this.guards.run(tx, { email: facts.email, rankKind: facts.rankKind });
    return { guestIdToVoid };
  }

  /**
   * Checks that "Make an account" may give a guest row a login: the email rule, then the registered checks, as a create does.
   *
   * @param tx the transaction
   * @param email the guest row's email
   * @throws {AppError} `EMAIL_TAKEN` (409, code `login_exists`) when a row with a login holds the email, or the refusal of a registered
   *   check (a blocklisted email: 422 on `email`)
   */
  async assertMayMakeAccount(tx: Transaction, email: string): Promise<void> {
    const login = await this.directory.findLoginByEmail(tx, email);
    this.settle(emailRuleForMakeAccount({ login: login !== undefined }), email, undefined);
    // A guest row always holds the retail rank, so the login it gets is a retail one.
    await this.guards.run(tx, { email, rankKind: 'retail' });
  }

  /**
   * Voids the open sign-in links of a guest row.
   *
   * @param tx the transaction of the write that gave the email a login row
   * @param guestId the guest row
   * @returns how many links were voided
   */
  voidGuestLinks(tx: Transaction, guestId: number): Promise<number> {
    return this.tokens.voidOpenOf(tx, guestId, ['magic_link']);
  }

  private settle(ruling: EmailRuling, email: string, guestId: number | undefined): number | undefined {
    if (!ruling.allowed) throw emailConflictError(ruling.code, email);
    return ruling.voidGuestLinks ? guestId : undefined;
  }
}
