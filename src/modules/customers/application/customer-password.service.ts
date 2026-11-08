// CustomerPasswordService: the use cases of POST /store/v1/auth/password/forgot, /password/set and POST /store/v1/me/password
// (map domain I, stage 14). A password change always ends the customer's other sessions.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import {
  type CustomerPrincipal,
  CUSTOMER_PASSWORD_LINK_PURPOSES,
  CustomerAuthTokens,
  type IssuedSession,
  type RequestMeta,
  SessionService,
  checkPasswordPolicy,
  isUsableLink,
} from '../../identity';
import { canSignIn } from '../domain/customer-status';
import { findCredentials, upsertCredentials } from '../infra/customer-credentials.repository';
import { CustomerSignInFailures } from '../infra/customer-sign-in-failures';
import { findCustomerByEmail, findCustomerById, updateCustomerRow } from '../infra/customer.repository';
import { weakPassword } from './customer-errors';
import { CustomerLinks } from './customer-links';
import { CustomerSignInLimiter } from './customer-sign-in-limiter';

/** What `change` answers: a new session when the old one was a `pending_password` step, nothing otherwise. */
export interface PasswordChangeResult {
  readonly session?: IssuedSession;
}

/**
 * Sends reset links, sets a password from a link, and changes the password of a signed-in customer.
 *
 * Why: the map. "Forgot password" answers `204` for any email, so it cannot be used to find out who has an account; a link
 * works once, for an hour, and the newest wins; choosing a password ends the customer's sessions (set) or the others (change),
 * and a wrong current password is `422` on its field, never `401`, which would sign the caller out.
 *
 * Side effects: updates `customers` and `customer_credentials`; inserts `auth_tokens` rows and the outbox event
 * `customer.password_reset`; marks links used; revokes sessions (their cached views are dropped after the commit).
 *
 * @see docs/contract/MISMATCHES.md (feature 14b specs)
 */
@Injectable()
export class CustomerPasswordService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly authTokens: CustomerAuthTokens,
    private readonly sessions: SessionService,
    private readonly limiter: CustomerSignInLimiter,
    private readonly failures: CustomerSignInFailures,
    private readonly links: CustomerLinks,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sends a reset link when the email belongs to an active account.
   *
   * @param email the normalised email
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429); nothing else: an unknown email, a guest or a suspended account is silent
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceForgot(email, meta.ip);
    const customer = await findCustomerByEmail(this.db.db, email);
    if (!customer || !customer.hasAccount || !canSignIn(customer.status)) return;
    await this.db.runInTransaction((work) =>
      this.links.send(work, { kind: 'password_reset', customerId: customer.id, ip: meta.ip }),
    );
  }

  /**
   * Sets the password from an invitation or reset link. It never signs anybody in.
   *
   * @param linkId the `auth_tokens` id the guard resolved from the token
   * @param password the new password
   * @throws {AppError} `TOKEN_INVALID` (410: used, expired, replaced, of another kind, or the customer is not active),
   *   `WEAK_PASSWORD` (422 on `password`; the link is not used up)
   */
  async setByLink(linkId: number, password: string): Promise<void> {
    const now = this.clock.now();
    const link = await this.authTokens.findById(linkId);
    const usable =
      link !== undefined &&
      (CUSTOMER_PASSWORD_LINK_PURPOSES as readonly string[]).includes(link.purpose) &&
      isUsableLink(link, now.getTime());
    const customer = usable ? await findCustomerById(this.db.db, link.subjectId) : undefined;
    // A suspended customer's link is as dead as an unknown one.
    if (!link || !customer || !canSignIn(customer.status)) throw new AppError('TOKEN_INVALID');

    const problem = checkPasswordPolicy(password, { email: customer.email, name: customer.name });
    if (problem) throw weakPassword(problem.message, 'password');
    const passwordHash = await this.hasher.hash(password);
    await this.db.runInTransaction(async (work) => {
      // A parallel request used the link first.
      if (!(await this.authTokens.consume(work, link.id))) throw new AppError('TOKEN_INVALID');
      await upsertCredentials(work.tx, customer.id, {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: now,
        updatedBy: null,
        now,
      });
      // An invitation proves the address (the link went to it); the account holder exists from now on.
      await updateCustomerRow(work.tx, customer.id, {
        hasAccount: true,
        ...(link.purpose === 'invite' && customer.emailVerifiedAt === null ? { emailVerifiedAt: now } : {}),
        updatedAt: now,
      });
      await this.authTokens.voidOpen(work, customer.id, CUSTOMER_PASSWORD_LINK_PURPOSES, link.id);
      await this.sessions.revokeAllOf('customer', customer.id, {}, work);
      // The owner of the address chose a password: the wrong tries before it no longer count.
      work.afterCommit(() => this.failures.clear(customer.email));
    });
  }

  /**
   * Changes the password of the signed-in customer.
   *
   * @param principal the signed-in customer (a full session, or the `pending_password` step after a temporary password)
   * @param input the current and the new password
   * @param meta the caller's address and user agent (for the new session of a pending step)
   * @returns the new session when the caller's was a pending step, else nothing
   * @throws {AppError} `RATE_LIMITED` (429), `VALIDATION_FAILED` (422 on `currentPassword`), `WEAK_PASSWORD` (422 on
   *   `newPassword`), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async change(
    principal: CustomerPrincipal,
    input: { readonly currentPassword: string; readonly newPassword: string },
    meta: RequestMeta,
  ): Promise<PasswordChangeResult> {
    await this.limiter.enforcePasswordChange(principal.customerId);
    const customer = await findCustomerById(this.db.db, principal.customerId);
    if (!customer) throw new AppError('UNAUTHORIZED');
    if (!canSignIn(customer.status)) {
      await this.sessions.revokeAllOf('customer', customer.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    const credentials = await findCredentials(this.db.db, customer.id);
    if (!credentials?.passwordHash || !(await this.hasher.verify(credentials.passwordHash, input.currentPassword))) {
      const message = 'The current password is not correct.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        errors: [{ field: 'currentPassword', code: 'INVALID_PASSWORD', message }],
      });
    }
    await this.limiter.resetPasswordChange(customer.id);
    const problem = checkPasswordPolicy(input.newPassword, { email: customer.email, name: customer.name });
    if (problem) throw weakPassword(problem.message, 'newPassword');
    if (await this.hasher.verify(credentials.passwordHash, input.newPassword)) {
      throw weakPassword('Choose a password you are not using now.', 'newPassword');
    }
    const passwordHash = await this.hasher.hash(input.newPassword);

    const now = this.clock.now();
    const pending = principal.stage === 'pending_password';
    return this.db.runInTransaction(async (work) => {
      await upsertCredentials(work.tx, customer.id, {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: now,
        updatedBy: null,
        now,
      });
      // An old reset link must not be able to undo the change.
      await this.authTokens.voidOpen(work, customer.id, CUSTOMER_PASSWORD_LINK_PURPOSES);
      await this.sessions.revokeAllOf('customer', customer.id, { exceptSessionId: principal.session.id }, work);
      work.afterCommit(() => this.failures.clear(customer.email));
      if (!pending) return {};
      // The forced change is done: the pending step becomes a full session with a new token (no fixation).
      const session = await this.sessions.rotate(
        principal.session,
        { stage: 'active', ip: meta.ip, userAgent: meta.userAgent },
        work,
      );
      return { session };
    });
  }
}
