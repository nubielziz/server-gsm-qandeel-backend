// SessionAuthenticator: turns a session cookie into a principal (decision 018). The same mechanics serve staff, merchants and
// customers: cookie, lookup, expiry, account state, stage, permissions of the role, and the once-a-minute last-seen write.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { SessionStage, SubjectType } from '../db/schema';
import type { SessionPrincipal } from './principal';
import { RolePermissions } from './role-permissions';
import { SessionCookies } from './session-cookies';
import { SessionService } from './session.service';
import { type SessionView, livenessOf } from './session.types';

/** What a route accepts. */
export interface SessionAuthOptions {
  /** The stages the route accepts (`contract.sessionStages`). */
  readonly stages: readonly SessionStage[];
}

/** A request that passed the session checks. */
export interface AuthenticatedSession {
  readonly view: SessionView;
  readonly principal: SessionPrincipal;
}

/**
 * Authenticates requests by session cookie.
 *
 * Why: decision 018. The order of the checks is part of the contract with the console: no or unknown or ended session
 * (`401`), then a suspended account (`403 ACCOUNT_SUSPENDED`, which also revokes every session of the account), then the
 * stage (`401`: a pending sign-in step can only call its own routes). `403 FORBIDDEN` and `403 CSRF_FAILED` come later and
 * never sign the caller out (ALIGNMENT § 3).
 *
 * Side effects: reads the session and role caches; writes `sessions.last_seen_at` at most once a minute; a suspended account
 * has all its sessions revoked.
 */
@Injectable()
export class SessionAuthenticator {
  private readonly logger = new Logger(SessionAuthenticator.name);

  constructor(
    private readonly cookies: SessionCookies,
    private readonly sessions: SessionService,
    private readonly roles: RolePermissions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Authenticates a request, or refuses it.
   *
   * @param subject which subject's cookie to read (staff, client, customer)
   * @param request the Fastify request
   * @param options the stages the route accepts
   * @returns the session and the principal
   * @throws {AppError} `UNAUTHORIZED` (401) for no, unknown, revoked, ended or wrong-stage sessions; `ACCOUNT_SUSPENDED`
   *   (403) for a suspended account
   */
  async authenticate(
    subject: SubjectType,
    request: FastifyRequest,
    options: SessionAuthOptions,
  ): Promise<AuthenticatedSession> {
    const token = this.cookies.readToken(request, subject);
    if (token === undefined) throw new AppError('UNAUTHORIZED');
    const view = await this.sessions.lookup(token);
    if (!view || view.subjectType !== subject) throw new AppError('UNAUTHORIZED');
    const now = this.clock.nowMs();
    if (livenessOf(view, now) !== 'live') throw new AppError('UNAUTHORIZED');

    if (view.subject.state === 'suspended') {
      // Suspension ends the account's sessions wherever they are used (decision 018).
      const revoked = await this.sessions.revokeAllOf(view.subjectType, view.subjectId);
      this.logger.warn(`${subject} ${view.subjectId} is suspended: ${revoked} session(s) revoked`);
      throw new AppError('ACCOUNT_SUSPENDED');
    }
    if (!options.stages.includes(view.stage)) throw new AppError('UNAUTHORIZED');

    await this.touchQuietly(view, now);
    return { view, principal: await this.principalFor(view, request.ip) };
  }

  /**
   * Authenticates a request if it carries a usable session, otherwise returns nothing.
   *
   * Why: a few routes serve two kinds of callers on one path (the password set accepts an emailed token or a forced-change
   * session); they are public for the dispatcher and ask for the session here.
   *
   * The CSRF guard ran before this, without a session, so it applied only the Origin check: a mutation that goes on with
   * the returned session must call `CsrfService.assert` itself before it changes anything.
   *
   * @param subject which subject's cookie to read
   * @param request the Fastify request
   * @param options the stages the route accepts
   * @returns the session and principal, or `undefined` for a request without a usable session
   */
  async authenticateOptional(
    subject: SubjectType,
    request: FastifyRequest,
    options: SessionAuthOptions,
  ): Promise<AuthenticatedSession | undefined> {
    try {
      return await this.authenticate(subject, request, options);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'UNAUTHORIZED' || error.code === 'ACCOUNT_SUSPENDED')) {
        return undefined;
      }
      throw error;
    }
  }

  private async touchQuietly(view: SessionView, now: number): Promise<void> {
    try {
      await this.sessions.touch(view, now);
    } catch (error) {
      // Idle tracking is best effort: a failed write must not fail the request.
      this.logger.warn(
        `Could not record last use of session ${view.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async principalFor(view: SessionView, ip: string): Promise<SessionPrincipal> {
    switch (view.subjectType) {
      case 'staff': {
        const roleId = view.subject.roleId ?? 0;
        // A pending sign-in step has no privileges, so its principal carries no permissions.
        const permissions = view.stage === 'active' ? await this.roles.permissionsOf(roleId) : [];
        return { kind: 'staff', staffId: view.subjectId, roleId, permissions, stage: view.stage, ip, session: view };
      }
      case 'client':
        return { kind: 'merchant', clientId: view.subjectId, stage: view.stage, ip, session: view };
      case 'customer':
        return { kind: 'customer', customerId: view.subjectId, stage: view.stage, ip, session: view };
    }
  }
}
