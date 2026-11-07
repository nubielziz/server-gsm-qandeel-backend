// StaffPasswordService: the use case of POST /admin/auth/password/set (map domain A, stage 2): a new staff password from an
// emailed invite or reset link, or after a temporary password (B3). It never signs anybody in.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { setRequestActor } from '../../../common/request-context';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService, type TransactionContext } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { StaffUser } from '../db/schema';
import { checkPasswordPolicy } from '../domain/password-policy';
import {
  STAFF_TOKEN_PURPOSES,
  consumeAuthToken,
  findStaffTokenByHash,
  voidOpenStaffTokens,
} from '../infra/auth-token.repository';
import { findStaffById, savePassword } from '../infra/staff-auth.repository';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import { SessionAuthenticator } from '../security/session-authenticator';
import { SessionService } from '../security/session.service';
import type { RequestMeta } from './request-meta';
import { SignInLimiter } from './sign-in-limiter';

/** The body of the route. */
export interface SetPasswordInput {
  /** The token of the emailed link; absent for the forced change on a `pending_password` session. */
  readonly token?: string | undefined;
  readonly password: string;
}

/**
 * Sets a staff member's password.
 *
 * Why: B3. Two ways in, one rule set: a one-time link (public, single use, one hour) or the pending session of a member who
 * must change a temporary password (session cookie + CSRF token). Either way the password must pass the policy and differ
 * from the current one, the hash is argon2id, every session of the account ends (so the person signs in again with the new
 * password and then sets up 2FA if needed), and the status stays `invited` until the first full sign-in.
 *
 * Side effects: updates `staff_users`; marks the link used and voids the account's other unused links; revokes every session
 * of the account; writes an audit row `set a new password`.
 *
 * @see docs/contract/endpoints/identity.md (POST /admin/auth/password/set)
 */
@Injectable()
export class StaffPasswordService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
    private readonly limiter: SignInLimiter,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sets the password by link or by pending session.
   *
   * @param input the password and, for a link, its token
   * @param request the request (the pending session mode reads its cookie and CSRF header)
   * @param meta the caller's address and user agent
   * @returns nothing; the answer is `204`
   * @throws {AppError} `TOKEN_INVALID` (410: unknown, used, expired or superseded link, or its account is suspended),
   *   `UNAUTHORIZED` (401: no token and no pending-password session), `CSRF_FAILED` (403), `ACCOUNT_SUSPENDED` (403),
   *   `WEAK_PASSWORD` (422 on `password`), `RATE_LIMITED` (429)
   */
  async setPassword(input: SetPasswordInput, request: FastifyRequest, meta: RequestMeta): Promise<void> {
    if (input.token !== undefined) return this.byLink(input.token, input.password, meta);
    return this.byPendingSession(input.password, request, meta);
  }

  private async byLink(token: string, password: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const now = this.clock.now();
    const link = await findStaffTokenByHash(this.db.db, this.tokens.hash(token));
    const usable =
      link !== undefined &&
      link.usedAt === null &&
      link.expiresAt.getTime() > now.getTime() &&
      (STAFF_TOKEN_PURPOSES as readonly string[]).includes(link.purpose);
    const staff = usable ? await findStaffById(this.db.db, link.subjectId) : undefined;
    // A suspended member's link is as dead as an unknown one (RULES auth).
    if (!usable || !staff || staff.status === 'suspended') throw new AppError('TOKEN_INVALID');

    const hashed = await this.acceptablePasswordHash(password, staff);
    await this.db.runInTransaction(async (work) => {
      const consumed = await consumeAuthToken(work.tx, link.id, now);
      // A parallel request used the link first.
      if (!consumed) throw new AppError('TOKEN_INVALID');
      await this.store(work, staff, hashed, now, meta, 'TOKEN_INVALID');
    });
  }

  private async byPendingSession(password: string, request: FastifyRequest, meta: RequestMeta): Promise<void> {
    const auth = await this.authenticator.authenticateOptional('staff', request, { stages: ['pending_password'] });
    if (auth?.principal.kind !== 'staff') throw new AppError('UNAUTHORIZED');
    // The CSRF guard ran without a session on this public route (it only checked the Origin): the token is checked here,
    // before anything changes.
    this.csrf.assert(auth.view.tokenHash, request.headers[CSRF_HEADER]);

    const staff = await findStaffById(this.db.db, auth.principal.staffId);
    if (!staff) throw new AppError('UNAUTHORIZED');
    if (staff.status === 'suspended') {
      await this.sessions.revokeAllOf('staff', staff.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    // The session was opened for the forced change; if the flag is gone the account moved on.
    if (!staff.mustChangePassword) throw new AppError('UNAUTHORIZED');

    const hashed = await this.acceptablePasswordHash(password, staff);
    const now = this.clock.now();
    await this.db.runInTransaction((work) => this.store(work, staff, hashed, now, meta, 'UNAUTHORIZED'));
  }

  /** Applies the policy, refuses the current password, and hashes (before any transaction: argon2 takes tens of milliseconds). */
  private async acceptablePasswordHash(password: string, staff: StaffUser): Promise<string> {
    const problem = checkPasswordPolicy(password, { email: staff.email, name: staff.name });
    if (problem) throw weakPassword(problem.message);
    if (staff.passwordHash && (await this.hasher.verify(staff.passwordHash, password))) {
      throw weakPassword('Choose a password you are not using now.');
    }
    return this.hasher.hash(password);
  }

  private async store(
    work: TransactionContext,
    staff: StaffUser,
    passwordHash: string,
    now: Date,
    meta: RequestMeta,
    refusal: 'TOKEN_INVALID' | 'UNAUTHORIZED',
  ): Promise<void> {
    // The account was suspended or deleted since it was read: the change must not land.
    if (!(await savePassword(work.tx, staff.id, passwordHash, now))) throw new AppError(refusal);
    await voidOpenStaffTokens(work.tx, staff.id, now);
    // Every session of the account ends, the pending one that made this request included.
    await this.sessions.revokeAllOf('staff', staff.id, {}, work);
    // The link route has no signed-in caller: the audit row names the account owner as the actor.
    setRequestActor({ type: 'staff', id: staff.id, name: staff.name }, meta.ip);
    await this.audit.record(work.tx, {
      action: 'set a new password',
      entityType: 'staff',
      entityId: staff.id,
      entityLabel: staff.name,
    });
  }
}

function weakPassword(message: string): AppError {
  return new AppError('WEAK_PASSWORD', {
    detail: message,
    errors: [{ field: 'password', code: 'WEAK_PASSWORD', message }],
  });
}
