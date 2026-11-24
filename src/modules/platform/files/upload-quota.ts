// The upload quotas of accounts and ticket links (decisions 053 and 064): the rules are constants, one function counts and refuses.
// The rule follows the rank kind of the account that uploads: merchant ranks get the merchant rule, every other rank the retail one.
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import type { RankKind } from '../../identity';
import type { FileOwnerType } from '../db/schema';
import { uploadUsage } from '../infra/file.repository';

const MIB = 1024 * 1024;

/**
 * One upload quota: how many files and bytes an owner may hold under some key prefixes, over a window.
 *
 * Why: decision 053. Nothing counted uploads per owner, so one account could fill the storage; the numbers are constants a code change
 * can raise.
 */
export interface UploadQuotaRule {
  /** The most files the owner may hold in the window, the new one included. */
  readonly maxFiles: number;
  /** The most bytes the owner may hold in the window, the new file included. */
  readonly maxBytes: number;
  /** The window in milliseconds; `null` counts everything the owner holds. */
  readonly windowMs: number | null;
  /** The object key prefixes that count: uploads only, so a generated document never counts. */
  readonly keyPrefixes: readonly string[];
  /** What a refused upload is told (the field message of the `quota` error). */
  readonly message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The quota of an account of a merchant rank: 500 files and 5 GiB in 24 hours.
 *
 * Why: decision 053. Far above the pace of the `upload` limiter that a real integration keeps; 5 GiB is 200 files of the 25 MiB maximum.
 * Decision 064: there is no waiting-for-approval quota any more (the status `pending` is gone), so every merchant rank has this one.
 */
export const MERCHANT_DAILY_QUOTA: UploadQuotaRule = {
  maxFiles: 500,
  maxBytes: 5 * 1024 * MIB,
  windowMs: DAY_MS,
  keyPrefixes: ['files/'],
  message: 'You can upload at most 500 files (5 GiB) in 24 hours. Try again later.',
};

/**
 * The quota of an account of a retail rank: 30 files and 100 MiB in 24 hours, receipts and ticket-link uploads together.
 *
 * Why: decision 053. Three times the pace of the top-up limiter of real use (10 per 10 minutes is a hint, 30 a day is the cap).
 * Decision 064: the rule belongs to the rank kind, not to the route: an account of a merchant rank is never held to it, whichever route its
 * file came through (see {@link uploadQuotaFor}). The name keeps the word of decision 053.
 */
export const CUSTOMER_DAILY_QUOTA: UploadQuotaRule = {
  maxFiles: 30,
  maxBytes: 100 * MIB,
  windowMs: DAY_MS,
  keyPrefixes: ['files/', 'tickets-'],
  message: 'You can upload at most 30 files (100 MiB) in 24 hours. Try again later.',
};

/**
 * The daily quota that belongs to a rank kind.
 *
 * Why: decision 064. One owner (`account`, id) now uploads through `/client/files` and `/store/v1/files`, and a ticket link
 * uploads for the account that asked, so a rule chosen by the route would hold a merchant rank to the retail 30 files or a retail rank to
 * the merchant 500. The rank kind decides: every caller that checks a quota for an account (the upload routes, the ticket-link upload)
 * picks the rule here.
 *
 * @param rankKind the rank kind of the account that uploads
 * @returns the merchant rule ({@link MERCHANT_DAILY_QUOTA}) for a merchant rank, the retail rule ({@link CUSTOMER_DAILY_QUOTA}) for a retail rank
 */
export function uploadQuotaFor(rankKind: RankKind): UploadQuotaRule {
  return rankKind === 'merchant' ? MERCHANT_DAILY_QUOTA : CUSTOMER_DAILY_QUOTA;
}

/**
 * The quota of one ticket's link: 20 files and 50 MiB in 24 hours.
 *
 * Why: decision 053. Four full messages of 5 attachments.
 *
 * @param ticketId the ticket whose link uploads
 * @returns the rule, counting the keys `tickets-<ticketId>/`
 */
export function ticketDailyQuota(ticketId: number): UploadQuotaRule {
  return {
    maxFiles: 20,
    maxBytes: 50 * MIB,
    windowMs: DAY_MS,
    keyPrefixes: [`tickets-${ticketId}/`],
    message: 'This ticket can take at most 20 files (50 MiB) in 24 hours.',
  };
}

/**
 * Tells whether one more file would take an owner over a quota.
 *
 * @param rule the quota
 * @param used the files and bytes the owner already holds in the window
 * @param incomingBytes the size of the new file
 * @returns true when the new file would be file number `maxFiles + 1`, or would take the bytes over `maxBytes` (equal is allowed)
 */
export function quotaExceeded(
  rule: UploadQuotaRule,
  used: { readonly files: number; readonly bytes: number },
  incomingBytes: number,
): boolean {
  return used.files + 1 > rule.maxFiles || used.bytes + incomingBytes > rule.maxBytes;
}

/**
 * Refuses an upload that would take its owner over a quota.
 *
 * Why: decision 053. It is called before the object is written (no object for an obvious refusal) and again, under
 * {@link lockUploadOwner}, together with the row insert (exact under concurrency).
 *
 * @param db the database or the transaction that holds the owner lock
 * @param owner the account (or staff member) who owns the file
 * @param rules the quotas to check, in order; the first exceeded one refuses (see {@link uploadQuotaFor})
 * @param incomingBytes the size of the new file
 * @param now the injected clock's time
 * @throws {AppError} `VALIDATION_FAILED` (422) on `file` with the code `quota` and the sentence of the rule
 */
export async function assertUploadQuota(
  db: DbExecutor,
  owner: { readonly type: FileOwnerType; readonly id: number },
  rules: readonly UploadQuotaRule[],
  incomingBytes: number,
  now: Date,
): Promise<void> {
  for (const rule of rules) {
    const since = rule.windowMs === null ? null : new Date(now.getTime() - rule.windowMs);
    const used = await uploadUsage(db, owner, rule.keyPrefixes, since);
    if (quotaExceeded(rule, used, incomingBytes)) {
      throw new AppError('VALIDATION_FAILED', {
        detail: rule.message,
        errors: [{ field: 'file', code: 'quota', message: rule.message }],
      });
    }
  }
}
