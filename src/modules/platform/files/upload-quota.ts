// The upload quotas of merchants, customers and ticket links (decision 053): the rules are constants, one function counts and refuses.
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
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
 * The quota of a merchant that waits for approval: 10 files and 50 MiB in all.
 *
 * Why: decision 053. A merchant that waits for approval uploads only ticket attachments (the ticket routes allow a pending merchant, B153; the order
 * and billing routes answer it 403 ACCOUNT_PENDING_APPROVAL), and an account nobody approved yet has no reason to hold more.
 */
export const PENDING_MERCHANT_QUOTA: UploadQuotaRule = {
  maxFiles: 10,
  maxBytes: 50 * MIB,
  windowMs: null,
  keyPrefixes: ['files/'],
  message:
    'An account that waits for approval can keep at most 10 uploaded files (50 MiB). Files that nothing uses are removed 7 days after their upload.',
};

/**
 * The quota of an approved merchant: 500 files and 5 GiB in 24 hours.
 *
 * Why: decision 053. Far above the pace of the `upload` limiter that a real integration keeps; 5 GiB is 200 files of the 25 MiB maximum.
 */
export const MERCHANT_DAILY_QUOTA: UploadQuotaRule = {
  maxFiles: 500,
  maxBytes: 5 * 1024 * MIB,
  windowMs: DAY_MS,
  keyPrefixes: ['files/'],
  message: 'You can upload at most 500 files (5 GiB) in 24 hours. Try again later.',
};

/**
 * The quota of a customer: 30 files and 100 MiB in 24 hours, receipts and ticket-link uploads together.
 *
 * Why: decision 053. Three times the pace of the top-up limiter of real use (10 per 10 minutes is a hint, 30 a day is the cap).
 */
export const CUSTOMER_DAILY_QUOTA: UploadQuotaRule = {
  maxFiles: 30,
  maxBytes: 100 * MIB,
  windowMs: DAY_MS,
  keyPrefixes: ['files/', 'tickets-'],
  message: 'You can upload at most 30 files (100 MiB) in 24 hours. Try again later.',
};

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
 * @param owner the merchant or customer who owns the file
 * @param rules the quotas to check, in order; the first exceeded one refuses
 * @param incomingBytes the size of the new file
 * @param now the injected clock's time
 * @throws {AppError} `VALIDATION_FAILED` (422) on `file` with the code `quota` and the sentence of the rule
 */
export async function assertUploadQuota(
  db: DbExecutor,
  owner: { readonly type: 'client' | 'customer'; readonly id: number },
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
