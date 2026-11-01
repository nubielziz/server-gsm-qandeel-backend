// StaffSignInService: the use cases of the staff sign-in routes login, 2fa, 2fa/setup, logout and me (map domain A, stage 2).
// Sensitive steps read the account from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { StaffUser } from '../db/schema';
import { nextStepOf, stageOfStep, type SignInStep } from '../domain/sign-in-step';
import {
  completeSignIn,
  findStaffByEmail,
  findStaffById,
  findStaffWithRole,
  replacePasswordHash,
  savePendingTotpSecret,
} from '../infra/staff-auth.repository';
import type { StaffPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import type { IssuedSession } from '../security/session.types';
import type { RequestMeta } from './request-meta';
import { SignInLimiter } from './sign-in-limiter';
import { TotpService } from './totp.service';

/** The answer of `login`: the next step and the pending session to put in the cookies. */
export interface LoginResult {
  readonly next: SignInStep;
  readonly session: IssuedSession;
}

/** The answer of `setupTwoFactor`. */
export interface TwoFactorSetupResult {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrSvg: string;
}

/** The answer of `me`, before the contract strips and serialises it. */
export interface MeResult {
  readonly id: number;
  readonly email: string;
  readonly name: string;
  readonly status: StaffUser['status'];
  readonly role: { readonly id: number; readonly name: string };
  readonly permissions: readonly string[];
  readonly twofaEnabled: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
}

const WRONG_CREDENTIALS = 'The email or password is not correct.';

function invalidCode(detail: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail,
    errors: [{ field: 'code', code: 'INVALID_CODE', message: detail }],
  });
}

/**
 * The staff sign-in: password, authenticator code, authenticator setup, sign-out and the signed-in member.
 *
 * Why: ALIGNMENT § 3 and decision 018. The order of `login` is part of the contract with the console: rate limit, then
 * credentials (one indistinguishable `401` for an unknown email, a wrong password and an account with no password yet, with
 * the same work done in each case), then suspension, then a pending session. Reaching `active` rotates the session token.
 *
 * Side effects: reads and writes `staff_users` and `sessions`; counts rate-limit attempts; the code step writes audit rows
 * (`logged in`, and `enabled two-factor sign-in` the first time); a failed attempt is logged without the email.
 *
 * @see docs/contract/endpoints/identity.md (the six auth sections)
 */
@Injectable()
export class StaffSignInService implements OnModuleInit {
  private readonly logger = new Logger(StaffSignInService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly limiter: SignInLimiter,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Makes the dummy hash at boot, so the first unknown-email login takes as long as every other one. */
  onModuleInit(): void {
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
  }

  /**
   * Checks the email and password and opens a pending session.
   *
   * @param input the credentials as typed
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the next step and the pending session
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401: unknown email, wrong password or no password yet),
   *   `ACCOUNT_SUSPENDED` (403: correct password, suspended account)
   */
  async login(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<LoginResult> {
    await this.limiter.enforceLogin(input.email, meta.ip);
    const staff = await findStaffByEmail(this.db.db, input.email);
    const correct = await this.passwordMatches(staff, input.password);
    if (!staff || !correct) {
      this.logger.warn(
        `Staff sign-in refused (${staff ? (staff.passwordHash ? 'wrong password' : 'no password yet') : 'unknown email'}) from ${meta.ip}`,
      );
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    if (staff.status === 'suspended') {
      this.logger.warn(`Staff ${staff.id} signed in with a correct password but is suspended (${meta.ip})`);
      throw new AppError('ACCOUNT_SUSPENDED', {
        detail: 'This account is suspended. Ask an owner to reactivate it.',
      });
    }

    await this.limiter.resetLogin(input.email, meta.ip);
    await this.upgradeHash(staff, input.password);
    await this.endStaleSession(staleToken);
    const next = nextStepOf(staff);
    const session = await this.sessions.create({
      subjectType: 'staff',
      subjectId: staff.id,
      stage: stageOfStep(next),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { next, session };
  }

  /**
   * Starts the authenticator setup: a new pending secret.
   *
   * @param principal the pending `totp_setup` session's staff member
   * @returns the key to type, the `otpauth://` link and the QR code
   * @throws {AppError} `RATE_LIMITED` (429), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401: the account is gone or no longer
   *   in this step), `TWOFA_ALREADY_ENABLED` (409)
   */
  async setupTwoFactor(principal: StaffPrincipal): Promise<TwoFactorSetupResult> {
    await this.limiter.enforceSetup(principal.staffId);
    const staff = await this.currentAccount(principal.staffId);
    // A password alone must not enrol a new authenticator once 2FA is on.
    if (staff.twofaEnabled) {
      throw new AppError('TWOFA_ALREADY_ENABLED', { detail: 'Two-factor sign-in is already on for this account.' });
    }
    if (nextStepOf(staff) !== 'totp_setup') throw new AppError('UNAUTHORIZED');

    const secret = this.totp.newSecret();
    const saved = await savePendingTotpSecret(this.db.db, staff.id, this.totp.seal(secret));
    if (!saved) {
      throw new AppError('TWOFA_ALREADY_ENABLED', { detail: 'Two-factor sign-in is already on for this account.' });
    }
    const otpauthUrl = this.totp.uriFor(staff.email, secret);
    return { secret, otpauthUrl, qrSvg: await this.totp.qrSvg(otpauthUrl) };
  }

  /**
   * Checks the authenticator code and opens the full session.
   *
   * @param principal the pending session's staff member
   * @param code the six digits
   * @param meta the caller's address and user agent
   * @returns the full session (a new token; the pending one is revoked)
   * @throws {AppError} `RATE_LIMITED` (429), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401: the account is gone or the
   *   session's step no longer matches the account), `VALIDATION_FAILED` (422 on `code`: wrong, expired or already used)
   */
  async verifyTwoFactor(principal: StaffPrincipal, code: string, meta: RequestMeta): Promise<IssuedSession> {
    await this.limiter.enforceCode(principal.staffId);
    const staff = await this.currentAccount(principal.staffId);
    const step = nextStepOf(staff);
    // The session was opened for one step; if the account moved on (2FA reset, new temporary password) it must sign in again.
    if (step === 'password' || principal.stage !== stageOfStep(step)) throw new AppError('UNAUTHORIZED');
    const secretEnc = staff.totpSecretEnc;
    if (secretEnc === null) {
      if (step === 'totp') throw new AppError('UNAUTHORIZED');
      throw invalidCode('Set up the authenticator first, then enter its code.');
    }

    const timeStep = await this.totp.check(this.totp.open(secretEnc), code, staff.totpLastStep, this.clock.nowMs());
    if (timeStep === undefined) throw invalidCode('That code is not correct or has expired. Enter the current code.');

    const issued = await this.db.runInTransaction(async (work) => {
      const done = await completeSignIn(work.tx, {
        id: staff.id,
        step: timeStep,
        secretEnc,
        ip: meta.ip,
        now: this.clock.now(),
      });
      // No row: a parallel request used this code first, the account was suspended, or the secret was replaced.
      if (!done) throw invalidCode('That code was already used. Wait for the next code and try again.');
      if (!staff.twofaEnabled) {
        await this.audit.record(work.tx, {
          action: 'turned on two-factor sign-in',
          entityType: 'staff',
          entityId: staff.id,
          entityLabel: staff.name,
          before: { twofaEnabled: false },
          after: { twofaEnabled: true },
        });
      }
      const rotated = await this.sessions.rotate(
        principal.session,
        { stage: 'active', ip: meta.ip, userAgent: meta.userAgent },
        work,
      );
      await this.audit.record(work.tx, {
        action: 'logged in',
        entityType: 'session',
        entityId: rotated.session.id,
        entityLabel: staff.name,
      });
      return rotated;
    });
    await this.limiter.resetCode(staff.id);
    return issued;
  }

  /**
   * Ends the caller's session.
   *
   * Why: sign-out always works. If the account was suspended meanwhile, every session of it ends, not only this one.
   *
   * @param principal the session's staff member (any sign-in step)
   */
  async logout(principal: StaffPrincipal): Promise<void> {
    const staff = await findStaffById(this.db.db, principal.staffId);
    await this.db.runInTransaction(async (work) => {
      if (staff?.status === 'suspended') {
        await this.sessions.revokeAllOf('staff', staff.id, {}, work);
        return;
      }
      const ended = await this.sessions.revoke(principal.session.id, work);
      // Only a full session was ever "logged in", so only it is "logged out".
      if (ended && staff && principal.stage === 'active') {
        await this.audit.record(work.tx, {
          action: 'logged out',
          entityType: 'session',
          entityId: principal.session.id,
          entityLabel: staff.name,
        });
      }
    });
  }

  /**
   * Describes the signed-in member.
   *
   * @param principal the full session's staff member
   * @returns the member, their role and the role's permissions as stored
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone; `ACCOUNT_SUSPENDED` (403) when it was suspended
   */
  async me(principal: StaffPrincipal): Promise<MeResult> {
    const found = await findStaffWithRole(this.db.db, principal.staffId);
    if (!found) throw new AppError('UNAUTHORIZED');
    const { staff, role } = found;
    if (staff.status === 'suspended') {
      await this.sessions.revokeAllOf('staff', staff.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    return {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      status: staff.status,
      role: { id: role?.id ?? staff.roleId, name: role?.name ?? '' },
      permissions: [...new Set(role?.permissions ?? [])],
      twofaEnabled: staff.twofaEnabled,
      mustChangePassword: staff.mustChangePassword,
      lastLoginAt: staff.lastLoginAt,
      lastLoginIp: staff.lastLoginIp,
    };
  }

  /** Reads the account for a sensitive step: gone is `401`, suspended is `403` and ends the account's sessions. */
  private async currentAccount(staffId: number): Promise<StaffUser> {
    const staff = await findStaffById(this.db.db, staffId);
    if (!staff) throw new AppError('UNAUTHORIZED');
    if (staff.status === 'suspended') {
      await this.sessions.revokeAllOf('staff', staff.id);
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    }
    return staff;
  }

  /**
   * Verifies a password in the same time whether or not the account exists.
   *
   * Why: an unknown email and an account with no password yet must not answer faster than a wrong password (decision 007,
   * brief P2.6): they verify against a dummy hash made at the configured cost.
   */
  private async passwordMatches(staff: StaffUser | undefined, password: string): Promise<boolean> {
    if (staff?.passwordHash) return this.hasher.verify(staff.passwordHash, password);
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
    await this.hasher.verify(await this.dummyHash, password);
    return false;
  }

  /** Re-hashes a correct password made at a lower cost than the configured one (decision 007); never fails the sign-in. */
  private async upgradeHash(staff: StaffUser, password: string): Promise<void> {
    if (!staff.passwordHash || !this.hasher.needsRehash(staff.passwordHash)) return;
    try {
      await replacePasswordHash(this.db.db, staff.id, await this.hasher.hash(password));
    } catch (error) {
      this.logger.warn(`Could not upgrade the password hash of staff ${staff.id}: ${String(error)}`);
    }
  }

  /** Ends the staff session a login request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'staff') await this.sessions.revoke(view.id);
  }
}
