// Pure rules of the account mails (decision 064): the key of the `account-mail` limiter (feature 20, decision 052: five account emails an
// hour per account and kind of mail) and which outbox event type each mail has for each rank kind.
import { RateLimitService } from '../../../infra/rate-limit';
import { sessionStateOf } from '../accounts/account-status';
import type { RankKind } from '../ports/rank-kind';
import type { ClientStatus } from '../db/schema';
import type { AccountTokenPurpose } from '../ports/account-auth-tokens';
import type { AccountMailKind } from '../ports/account-mail-outbox';

/**
 * Whose account a mail goes to: the first part of the key (staff and account ids overlap).
 *
 * Why: one account type serves merchants and shoppers (decision 064), so one budget covers every rank of one account: a mail asked for
 * through the forgot-password route, the sign-in link or a resend spends from the same counter.
 */
export type AccountMailSubject = 'account' | 'staff';

/**
 * The kinds of account mail the limiter counts separately.
 *
 * Why: the mails a visitor can ask for (`forgot_password`, `sign_in_link`) have kinds apart from the ones staff send
 * (`password_link`), so a stranger who spends them cannot block a link a staff member sends (decision 052).
 */
export type AccountMailBudgetKind =
  'password_link' | 'verification' | 'email_change' | 'forgot_password' | 'sign_in_link';

/**
 * The limiter key of one kind of mail to one account.
 *
 * Why: a staff member or an account holder must not mail-bomb an inbox or use up the mail quota (decision 021, feature 20, O-11). The
 * subject type is part of the key because staff and account ids overlap; the kind is part of it so a verification resend does not use up
 * the password-link budget. The account's own resend and the staff action share the key `verification`.
 *
 * @param subject whose account: `account` or `staff`
 * @param id the account id
 * @param kind the kind of mail
 * @returns a 32-character hex key for `RateLimitService.enforce('account-mail', key)`
 */
export function accountMailKey(subject: AccountMailSubject, id: number, kind: AccountMailBudgetKind): string {
  return RateLimitService.compositeKey(subject, String(id), kind);
}

/**
 * The limiter key of the mails a visitor asks for an address that no login account holds (decision 079): the note, and the sign-up link
 * sent to the address's guest row.
 *
 * Why: the note goes to the typed address, with no row behind it (the review of decision 079), so its budget is the address's: five mails
 * an hour per address, whoever asks, as an account's budget is five links an hour. The re-review: the sign-up links of the address spend
 * from it too (counted by the guest row's id they made a second budget). The subject `address` keeps the key apart from every account key.
 *
 * @param email the normalised address
 * @param kind the kind of mail the visitor asked for
 * @returns a 32-character hex key for `RateLimitService.consume('account-mail', key)`
 */
export function accountAddressMailKey(email: string, kind: Extract<AccountMailBudgetKind, 'sign_in_link'>): string {
  return RateLimitService.compositeKey('address', email, kind);
}

/**
 * The outbox event type of each mail, by the rank kind of the account that gets it.
 *
 * Why: decision 064, no new events and no template migration: the stored templates keep their names, so a merchant rank gets the
 * `merchant.*` family and a retail rank the `customer.*` family (a sign-in link is for the retail rank only). The family follows the rank
 * kind read under the account row lock, never a flag the caller passes.
 */
export const ACCOUNT_MAIL_EVENTS = {
  merchant: {
    email_verification: 'merchant.email_verification',
    password_reset: 'merchant.password_reset',
    invited: 'merchant.invited',
  },
  retail: {
    email_verification: 'customer.email_verification',
    password_reset: 'customer.password_reset',
    invited: 'customer.invited',
    magic_link: 'customer.magic_link',
  },
} as const satisfies Record<RankKind, Partial<Record<AccountMailKind, string>>>;

/**
 * The two link mails of the shop's sign-up (decision 079), for the retail rank only: "finish creating your account" (the link the details
 * of the form wait beside) and "you already have an account, nothing was changed" (the ordinary sign-in link of an address that already
 * has one).
 *
 * Why: the review of decision 079 (S3): the reader must be told which of the two happened, and that no account exists until the link is
 * opened. Kept apart from {@link ACCOUNT_MAIL_EVENTS}, whose retail family the platform's built-in events copy: these two events are the
 * identity module's own (`IDENTITY_MAIL_EVENTS`), with shipped texts and no template migration.
 */
export const SIGN_UP_MAIL_EVENTS = {
  sign_up_link: 'customer.sign_up_link',
  sign_up_existing: 'customer.sign_up_existing',
} as const satisfies Partial<Record<AccountMailKind, string>>;

/** The event type of each mail, by rank kind: the built-in families plus the sign-up mails of the retail rank. */
const FAMILIES: Readonly<Record<RankKind, Readonly<Partial<Record<AccountMailKind, string>>>>> = {
  merchant: ACCOUNT_MAIL_EVENTS.merchant,
  retail: { ...ACCOUNT_MAIL_EVENTS.retail, ...SIGN_UP_MAIL_EVENTS },
};

/** Every event type the account mails write: the nine the processors handle. */
export const ACCOUNT_MAIL_EVENT_TYPES: readonly string[] = [
  ...Object.values(FAMILIES.merchant),
  ...Object.values(FAMILIES.retail),
];

/** What an event type of the account mails means. */
export interface AccountMailEventInfo {
  /** The rank kind whose family the event belongs to. */
  readonly rankKind: RankKind;
  readonly kind: AccountMailKind;
}

/**
 * Tells which mail an outbox event type is.
 *
 * Why: the mail job gets only the event type and reads the family and the kind from it.
 *
 * @param type the outbox event type
 * @returns the family's rank kind and the mail kind, or `undefined` when the type is not an account mail
 */
export function accountMailEventInfo(type: string): AccountMailEventInfo | undefined {
  for (const rankKind of ['merchant', 'retail'] as const) {
    const events = FAMILIES[rankKind];
    for (const [kind, event] of Object.entries(events)) {
      if (event === type) return { rankKind, kind: kind as AccountMailKind };
    }
  }
  return undefined;
}

/**
 * Picks the event type of a mail.
 *
 * @param rankKind the rank kind of the account that gets the mail
 * @param kind which mail
 * @returns the event type
 * @throws {Error} for a sign-in link (or a sign-up mail) to a merchant rank (the retail rank only: the caller refuses it first)
 */
export function accountMailEventOf(rankKind: RankKind, kind: AccountMailKind): string {
  const type = FAMILIES[rankKind][kind];
  if (type === undefined) throw new Error(`The mail "${kind}" is not sent to a ${rankKind} account.`);
  return type;
}

/** The token purpose each mail is about; a job whose link says otherwise is not sent. */
export const ACCOUNT_MAIL_PURPOSES: Readonly<Record<AccountMailKind, AccountTokenPurpose>> = {
  email_verification: 'verify_email',
  password_reset: 'reset',
  invited: 'invite',
  magic_link: 'magic_link',
  sign_up_link: 'magic_link',
  sign_up_existing: 'magic_link',
};

/**
 * Reads the account a mail job is about.
 *
 * Why: decision 064: a job carries `accountId`; a job with only the old customer number is a job of the retired customer table, and that
 * number must never be read as an account id (it names another person). A merchant mail queued before the cut-over names the merchant as
 * the aggregate, and a merchant's id is its account id, so that one is accepted.
 *
 * @param info which mail the job is
 * @param data the job's aggregate and payload
 * @returns the account id, or `undefined` for a job that must not be read as an account's
 */
export function accountIdOfMailJob(
  info: Pick<AccountMailEventInfo, 'rankKind'>,
  data: {
    readonly aggregateType: string;
    readonly aggregateId: number;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): number | undefined {
  const accountId = data.payload['accountId'];
  if (typeof accountId === 'number') return accountId;
  if (info.rankKind !== 'merchant' || data.aggregateType !== 'clients') return undefined;
  const clientId = data.payload['clientId'];
  return typeof clientId === 'number' ? clientId : data.aggregateId;
}

/** Why a mail job sends nothing, before it looks at the link. */
export type AccountMailAccountSkip = 'account_gone' | 'account_not_active' | 'rank_changed';

/**
 * Judges the account of a mail job.
 *
 * Why: only an account that can act gets a link, not even a sign-in or reset link (suspended and blocked get nothing; an anonymized
 * account reads as gone), and the family was chosen when the mail was queued, so an account whose rank kind changed since gets neither
 * text (decision 064).
 *
 * @param info which mail the job is (its family's rank kind)
 * @param account the account as read now, or `undefined` when the row is gone
 * @returns the reason to send nothing, or `undefined` to go on
 */
export function accountMailAccountSkip(
  info: Pick<AccountMailEventInfo, 'rankKind'>,
  account: { readonly status: ClientStatus; readonly rankKind: RankKind } | undefined,
): AccountMailAccountSkip | undefined {
  if (account === undefined) return 'account_gone';
  const state = sessionStateOf(account.status);
  if (state === 'gone') return 'account_gone';
  if (state !== 'ok') return 'account_not_active';
  return account.rankKind === info.rankKind ? undefined : 'rank_changed';
}

/**
 * Tells whether the link a mail job names is still worth sending.
 *
 * Why: the subject type is checked here as well as in the query, so a token of another subject type whose number equals this account's
 * (an old customer link) is not its link; the purpose must be the mail's; a used, voided or expired link is not sent.
 *
 * @param info which mail the job is (its kind)
 * @param accountId the account the job is about
 * @param link the stored link, or `undefined` when there is none
 * @param now the time from the injected clock
 * @returns true when the link is the account's, of the mail's purpose, unused and unexpired
 */
export function accountMailLinkUsable(
  info: Pick<AccountMailEventInfo, 'kind'>,
  accountId: number,
  link:
    | {
        readonly subjectType: string;
        readonly subjectId: number;
        readonly purpose: string;
        readonly usedAt: Date | null;
        readonly expiresAt: Date;
      }
    | undefined,
  now: Date,
): boolean {
  return (
    link !== undefined &&
    link.subjectType === 'account' &&
    link.subjectId === accountId &&
    link.purpose === ACCOUNT_MAIL_PURPOSES[info.kind] &&
    link.usedAt === null &&
    link.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Formats the expiry of a link for the mail text.
 *
 * Why: the account and staff link mails tell the reader until when the link works.
 *
 * @param expiresAt when the link stops working
 * @returns `2026-11-01 11:00 UTC`
 */
export function formatExpiry(expiresAt: Date): string {
  return `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
