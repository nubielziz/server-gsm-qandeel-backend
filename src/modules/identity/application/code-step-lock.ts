// CodeStepLock: the daily cap on wrong authenticator codes at the code step of the staff sign-in and the sign-in of every account. The count
// is a column of the account's own row in Postgres (`totp_failures`, `totp_failures_since`, `totp_locked_at`), written by
// infra/code-failures.repository.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import {
  MAX_FAILED_CODES,
  closesCodeStep,
  codeStepClosed,
  codeStepWaitText,
  secondsUntilCodeStepOpens,
} from '../domain/code-step-lock';
import {
  type CodeStepAccount,
  chargeCodeAttempt,
  giveBackCodeAttempt,
  markCodeStepClosed,
} from '../infra/code-failures.repository';
import type { RequestMeta } from './request-meta';

/** What a closed code step tells the person at it: when it opens again by itself, and what opens it sooner. */
const CLOSED_DETAIL: Readonly<Record<CodeStepAccount['type'], (wait: string) => string>> = {
  staff: (wait) =>
    `Too many wrong codes. The code step of this account opens again in ${wait}, or sooner with a password link, a temporary password or a 2FA reset from a member who manages staff accounts.`,
  account: (wait) =>
    `Too many wrong codes. The code step of this account opens again in ${wait}, or sooner with a password link ("Forgot password") or when support sets a new password or resets two-factor sign-in.`,
};

/** The audit word of each kind of person: an account of any rank is `account` (decision 064). */
const ENTITY_OF = { staff: 'staff', account: 'account' } as const satisfies Record<CodeStepAccount['type'], string>;

/**
 * Counts the authenticator codes of one account and closes its code step after twenty wrong ones within 24 hours.
 *
 * Why: the code step is the second factor and must hold also for a person who knows the password. Its budget of five codes per 15
 * minutes (`sign-in-code`) bounds their pace and starts again after a correct code; this cap bounds their total and follows the pattern
 * of the failed-sign-in lock of decision 052: every attempt is counted before its code is checked, atomically, and a correct code takes
 * back only its own count, so neither parallel attempts nor the member's own sign-in reset it.
 * The count runs 24 hours from the first counted wrong code. Twenty wrong codes in them are checked; from then on the step answers
 * `429` to every code, the right one included, until those 24 hours end (it then opens by itself, with a count of zero), a new password
 * is set by an emailed link or by staff, or staff reset two-factor sign-in (`clearCodeFailures`). Because the step always opens
 * again by itself, no account is shut out for good. The count lives on the account's row in Postgres, not
 * in the cache Redis: no eviction, restart or in-process fallback can end it early.
 *
 * Side effects: one `UPDATE` of `staff_users` or `clients` per attempt (and one when it is given back); every wrong code writes one
 * warning naming the account and the caller's address; the wrong code that closes the step records the closing once
 * (`totp_locked_at`) and writes an audit row (`locked the authenticator step of`); a refused attempt writes a warning.
 */
@Injectable()
export class CodeStepLock {
  private readonly logger = new Logger(CodeStepLock.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one code attempt before its code is checked, and refuses it while the code step is closed.
   *
   * @param account the staff member or account of the pending session
   * @param meta the caller's address (logged with a refusal)
   * @returns the attempts counted with this one (pass it to {@link failed} when the code is wrong)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`: the seconds until the 24 hours of the count end and the step opens),
   *   `UNAUTHORIZED` (401: the account is gone)
   */
  async charge(account: CodeStepAccount, meta: Pick<RequestMeta, 'ip'>): Promise<number> {
    const now = this.clock.now();
    const charged = await chargeCodeAttempt(this.db.db, account, now);
    if (charged === undefined) throw new AppError('UNAUTHORIZED');
    if (!codeStepClosed(charged.attempts, charged.lockedAt !== null)) return charged.attempts;
    // A refused attempt checked no code: its count goes back, so a closed step keeps the count it closed at.
    await giveBackCodeAttempt(this.db.db, account);
    const wait = secondsUntilCodeStepOpens(charged.since, now);
    this.logger.warn(
      `Authenticator code refused (${account.type} ${account.id}): the code step is closed after repeated wrong codes for ${wait} s more (${meta.ip})`,
    );
    throw new AppError('RATE_LIMITED', {
      detail: CLOSED_DETAIL[account.type](codeStepWaitText(wait)),
      retryAfterSeconds: wait,
    });
  }

  /**
   * Takes back the attempt counted by {@link charge}: its code was correct.
   *
   * @param account the staff member or account
   * @returns when the count is taken back
   */
  giveBack(account: CodeStepAccount): Promise<void> {
    return giveBackCodeAttempt(this.db.db, account);
  }

  /**
   * Records a wrong code: it is logged, and the one that reaches the cap closes the step, which is recorded and audited once.
   *
   * @param account the staff member or account
   * @param attempts what {@link charge} returned for this attempt
   * @param entityLabel the name of the account, for the audit row
   * @param meta the caller's address (logged)
   * @returns when the warning is written (and the closing with its audit row, when this code closes the step)
   */
  async failed(
    account: CodeStepAccount,
    attempts: number,
    entityLabel: string,
    meta: Pick<RequestMeta, 'ip'>,
  ): Promise<void> {
    // A code still being checked is counted too, so the closing may be recorded one wrong code early, never late.
    const closedSince = closesCodeStep(attempts) ? await this.close(account, entityLabel) : undefined;
    this.logger.warn(
      closedSince === undefined
        ? `Wrong authenticator code (${account.type} ${account.id}) (${meta.ip})`
        : `Wrong authenticator code (${account.type} ${account.id}): the code step is closed after ${MAX_FAILED_CODES} wrong codes within 24 hours, for ${secondsUntilCodeStepOpens(closedSince, this.clock.now())} s (${meta.ip})`,
    );
  }

  /** Records the closing once and audits it; `undefined` when another request recorded it, or nothing is closed any more. */
  private async close(account: CodeStepAccount, entityLabel: string): Promise<Date | undefined> {
    return this.db.runInTransaction(async (work) => {
      const since = await markCodeStepClosed(work.tx, account, this.clock.now());
      if (since === undefined) return undefined;
      await this.audit.record(work.tx, {
        action: 'locked the authenticator step of',
        entityType: ENTITY_OF[account.type],
        entityId: account.id,
        entityLabel,
        before: { codeStepClosed: false },
        after: { codeStepClosed: true, wrongCodes: MAX_FAILED_CODES },
      });
      return since;
    });
  }
}
