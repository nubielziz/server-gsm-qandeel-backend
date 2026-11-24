// Pure rules of the staff writes on an account (decision 064): who may give a rank, which rules the email of a login row and of a guest row
// follow when a write gives an email a login, what a staff status write may name, and which staff security tool an account allows. No
// I/O, so the rules are unit-tested.
import { AppError } from '../../../common/errors';
import { canAct } from '../accounts/account-status';
import type { RankKind } from '../ports/rank-kind';
import type { ClientStatus } from '../db/schema';
import { type PermissionHolder, requireOwner } from '../security/principal';

/** The refusal text of every Owner-only check of a rank (the console shows it as it is). */
export const RANK_OWNER_DETAIL = 'Only the Owner gives or changes a rank.';

/**
 * Refuses a caller who may not create an account with a rank.
 *
 * Why: a merchant rank gives prices, credit and API keys, so only the Owner gives it, whatever else the caller's role holds (not even
 * `clients:*` with `groups:*` is enough); a retail rank needs only the route's own permission (decision 064).
 *
 * @param caller the signed-in staff member
 * @param rankKind the kind of the rank the account is made with
 * @throws {AppError} `FORBIDDEN` (403) for a merchant rank and a caller who is not an Owner
 */
export function assertMayGiveRank(caller: PermissionHolder, rankKind: RankKind): void {
  if (rankKind === 'merchant') requireOwner(caller, RANK_OWNER_DETAIL);
}

/**
 * Refuses a caller who may not change the rank of an account.
 *
 * Why: any change of rank, between kinds or inside one, is the Owner's (decision 064); this is the one sentence of the refusal.
 *
 * @param caller the signed-in staff member
 * @throws {AppError} `FORBIDDEN` (403) when the caller is not an Owner
 */
export function assertMayChangeRank(caller: PermissionHolder): void {
  requireOwner(caller, RANK_OWNER_DETAIL);
}

/** How an account gets its first or a new password from staff. */
export const PASSWORD_MODES = ['reset_link', 'temporary_password'] as const;

/** One value of {@link PASSWORD_MODES}. */
export type PasswordMode = (typeof PASSWORD_MODES)[number];

/** The permission a staff member needs besides the route's own to hand out a temporary password (decision 047). */
export const TEMPORARY_PASSWORD_PERMISSION = 'clients:security' as const;

/**
 * The second permission a way of giving a password needs.
 *
 * Why: decision 047: a temporary password is a working credential for the account, so it is an account-security action; the emailed
 * link hands staff nothing (the link goes to the account's own address), so it needs only the route's permission.
 *
 * @param mode how the account gets a password
 * @returns `clients:security` for a temporary password, else `null`
 */
export function passwordModePermission(mode: PasswordMode): typeof TEMPORARY_PASSWORD_PERMISSION | null {
  return mode === 'temporary_password' ? TEMPORARY_PASSWORD_PERMISSION : null;
}

/**
 * The permission an email change needs besides `clients:update`.
 *
 * Why: decision 047: the address of an account with a login receives its sign-in and password links, so changing it is an
 * account-security action; a guest holds no password and signs in only by a link to its own address, so a guest's address needs only the
 * route's permission.
 *
 * @param hasAccount whether the row has a login
 * @returns `clients:security` for a login row, else `null`
 */
export function emailChangePermission(hasAccount: boolean): 'clients:security' | null {
  return hasAccount ? 'clients:security' : null;
}

/** Why an email cannot be given to a row with a login: another login row has it, a guest row has it (retail create), or the guest row is the same email. */
export type EmailConflictCode = 'taken' | 'guest' | 'login_exists';

/** Which rows already hold an email, other than the row being written. */
export interface EmailHolders {
  /** Another row with a login holds the email. */
  readonly login: boolean;
  /** A guest row holds the email (another one, when a guest row itself changes its email). */
  readonly guest: boolean;
}

/** What a rule says about an email. */
export type EmailRuling =
  | {
      readonly allowed: true;
      /** The open email links of the guest row of that email must be voided in the same transaction (a mail sent to the guest row must not make a second login row). */
      readonly voidGuestLinks: boolean;
    }
  | { readonly allowed: false; readonly code: EmailConflictCode };

/**
 * The email rule of the staff create (decision 064).
 *
 * Why: an email is unique among the rows with a login and, separately, among the guest rows. A login row of the email stops the create. A
 * guest row of the email stops a retail create (the person ordered as a guest: staff use "Make an account" on that row) and is left alone by
 * a merchant create, which voids the guest row's open email links so that a mail sent to it earlier can no longer make a second login row.
 *
 * @param holders the rows that hold the email
 * @param rankKind the kind of the rank the new account gets
 * @returns the ruling
 */
export function emailRuleForCreate(holders: EmailHolders, rankKind: RankKind): EmailRuling {
  if (holders.login) return { allowed: false, code: 'taken' };
  if (holders.guest && rankKind === 'retail') return { allowed: false, code: 'guest' };
  return { allowed: true, voidGuestLinks: holders.guest };
}

/**
 * The email rule of "Make an account" on a guest row.
 *
 * Why: the guest row turns into a login row, so no other login row may hold its email (`login_exists`).
 *
 * @param holders the rows that hold the email (only `login` is read)
 * @returns the ruling; the guest row's own links are voided by the caller, not by this rule
 */
export function emailRuleForMakeAccount(holders: Pick<EmailHolders, 'login'>): EmailRuling {
  return holders.login ? { allowed: false, code: 'login_exists' } : { allowed: true, voidGuestLinks: false };
}

/**
 * The email rule of an email change.
 *
 * Why: a login row may take an email that only a guest row holds (the guest row's open links are voided), and not one another login row
 * holds. A guest row may take neither: not another guest row's email (one guest row per email), and not a login row's, the conflict the
 * create answers (`taken`). The export, the erasure and the guest-order claim of a login account find "the guest row of its proven email",
 * so a guest row that staff moved onto that email would hand one person's guest orders to another without a proven mailbox.
 *
 * @param holders the other rows that hold the new email
 * @param hasAccount whether the row being changed has a login
 * @returns the ruling
 */
export function emailRuleForChange(holders: EmailHolders, hasAccount: boolean): EmailRuling {
  if (hasAccount) {
    return holders.login ? { allowed: false, code: 'taken' } : { allowed: true, voidGuestLinks: holders.guest };
  }
  return holders.guest || holders.login ? { allowed: false, code: 'taken' } : { allowed: true, voidGuestLinks: false };
}

/** The sentence of each email conflict, for the console's form (`errors[].message`). */
export const EMAIL_CONFLICT_MESSAGES: Readonly<Record<EmailConflictCode, string>> = {
  taken: 'Another account uses this email address.',
  guest: 'A guest bought with this email: make that guest an account instead.',
  login_exists: 'Another account with a login uses this email address.',
};

/** The keys only a merchant rank may carry on a create. */
export interface RetailCreateKeys {
  readonly company?: string | undefined;
  readonly creditLimit?: string | undefined;
}

/** A field error in the shape the use cases turn into `422 VALIDATION_FAILED`. */
export interface AccountFieldProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * The first key a retail create may not carry.
 *
 * Why: a retail account has no company and no credit (a retail rank allows no overdraft, decision 064), so those keys are refused on the
 * key itself instead of being dropped without a word.
 *
 * @param keys the optional keys of the body
 * @returns the problem, or `undefined` when the body fits a retail account
 */
export function retailCreateProblem(keys: RetailCreateKeys): AccountFieldProblem | undefined {
  if (keys.company !== undefined && keys.company !== '') {
    return { field: 'company', code: 'invalid', message: 'A retail account has no company.' };
  }
  if (keys.creditLimit !== undefined) {
    return { field: 'creditLimit', code: 'invalid', message: 'A retail account has no credit limit.' };
  }
  return undefined;
}

/**
 * Tells what staff may write as a status in `PATCH /admin/clients/:id`.
 *
 * Why: staff only suspend an account and lift the suspension here. `blocked` and `anonymized` have their own routes (a block also writes the
 * blocklist, an erasure also closes the wallets), and `pending` has no writer any more: a status outside the list is a `422` on `status`.
 *
 * @param to the status asked for
 * @returns the problem, or `undefined` for `active` and `suspended`
 */
export function statusWriteProblem(to: string): AccountFieldProblem | undefined {
  if (to === 'active' || to === 'suspended') return undefined;
  const route = to === 'blocked' ? ' Use the block route.' : to === 'anonymized' ? ' Use the anonymize route.' : '';
  return { field: 'status', code: 'invalid', message: `Staff set the status to active or suspended here.${route}` };
}

/** The staff security tools an account has. */
export type SecurityTool = 'password' | 'reset_2fa' | 'revoke_sessions' | 'verification';

/**
 * Tells why a staff security tool cannot be used on an account, or nothing when it can.
 *
 * Why: decision 064: every tool works on an account with a login; a guest has nothing to secure (`NO_ACCOUNT`, "Make an
 * account first."), an anonymized account takes no write (`ANONYMIZED`), and a password or a verification link goes only to an account that may
 * act (`NOT_ACTIVE`: suspended or blocked). Ending sessions and turning two-step sign-in off stay possible for a suspended or blocked account:
 * they only take access away.
 *
 * @param account whether the row has a login, and its status
 * @param tool the tool
 * @returns the code of the refusal, or `undefined` when the tool may run
 */
export function securityToolRefusal(
  account: { readonly hasAccount: boolean; readonly status: ClientStatus },
  tool: SecurityTool,
): 'ANONYMIZED' | 'NO_ACCOUNT' | 'NOT_ACTIVE' | undefined {
  if (account.status === 'anonymized') return 'ANONYMIZED';
  if (!account.hasAccount) return 'NO_ACCOUNT';
  if ((tool === 'password' || tool === 'verification') && !canAct(account.status)) return 'NOT_ACTIVE';
  return undefined;
}

/**
 * Builds the error of a refused staff security tool.
 *
 * @param code the code from {@link securityToolRefusal}
 * @returns the error to throw, with the sentence the console shows
 */
export function securityToolError(code: 'ANONYMIZED' | 'NO_ACCOUNT' | 'NOT_ACTIVE'): AppError {
  if (code === 'NO_ACCOUNT') return new AppError('NO_ACCOUNT', { detail: 'Make an account first.' });
  if (code === 'ANONYMIZED') return new AppError('ANONYMIZED');
  return new AppError('NOT_ACTIVE', { detail: 'This account is not active. Reactivate the account first.' });
}

/**
 * The currency of each country the shop sells to.
 *
 * Why: the currency of a retail account is derived from its country, never typed (RESOLUTIONS b2c-1); a country not listed pays in the
 * base currency. The same table the customers module used before the accounts were merged.
 */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  GB: 'GBP',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  SE: 'SEK',
  US: 'USD',
  CA: 'CAD',
  AE: 'AED',
  SA: 'SAR',
};

/** The currency of a country with no entry in {@link COUNTRY_CURRENCY}: the ledger's base currency. */
export const FALLBACK_CURRENCY = 'USD';

/**
 * Names the currency code a retail account of a country pays in.
 *
 * @param country an upper-case ISO 3166 alpha-2 code (or `''` for unknown)
 * @returns the currency code (not yet checked against the `currencies` table)
 */
export function currencyCodeFor(country: string): string {
  return COUNTRY_CURRENCY[country] ?? FALLBACK_CURRENCY;
}
