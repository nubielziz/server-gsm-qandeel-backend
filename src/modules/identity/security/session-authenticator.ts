// SessionAuthenticator: turns a session cookie into a principal (decision 018). The same mechanics serve staff, merchants and
// customers: cookie, lookup, expiry, account state, stage, permissions of the role, and the once-a-minute last-seen write.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { ipRateLimitKey, parseIpAddress } from '../../../common/ip-address';
import { RateLimitService, rateLimitedError } from '../../../infra/rate-limit';
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
 * The key of the failed-lookup budget of a client address and audience, on the `ip` limiter.
 *
 * Why: decision 053. A session cookie that names no live session costs a cache read and, on a miss, a database read; the budget bounds
 * those lookups per address (the IPv4 address or the IPv6 /64) and per audience, so a stale cookie of one audience never uses up
 * the budget of another, and one address never uses up the budget of another.
 *
 * @param subject the audience of the cookie (staff, client, customer)
 * @param ip the client address (`request.ip`)
 * @returns `session-failures:<subject>:<address key>`
 */
export function sessionFailureKey(subject: SubjectType, ip: string): string {
  return `session-failures:${subject}:${ipRateLimitKey(parseIpAddress(ip))}`;
}

/**
 * Authenticates requests by session cookie.
 *
 * Why: decision 018. The order of the checks is part of the contract with the console: no or unknown or ended session
 * (`401`), then a suspended account (`403 ACCOUNT_SUSPENDED`, which also revokes every session of the account), then the
 * stage (`401`: a pending sign-in step can only call its own routes). `403 FORBIDDEN` and `403 CSRF_FAILED` come later and
 * never sign the caller out (ALIGNMENT § 3).
 *
 * Decision 053: in required mode (the access guard, the queues board, {@link SessionAuthenticator.precheck}) a cookie that names no live
 * session of the audience costs one point of the budget `session-failures:<subject>:<address key>` on the `ip` limiter (300 a minute,
 * the budget of unknown API keys); once it is used up the address is answered `429` without a lookup. A request without the cookie
 * costs nothing, and neither does a cookie of a live session. `authenticateOptional` (public routes that accept an optional session)
 * charges nothing: the store is counted per address by the `ip` stage already.
 *
 * Side effects: reads the session and role caches; writes `sessions.last_seen_at` at most once a minute; a suspended account
 * has all its sessions revoked; one point of the failed-lookup budget on the cache Redis per unknown cookie.
 */
@Injectable()
export class SessionAuthenticator {
  private readonly logger = new Logger(SessionAuthenticator.name);

  constructor(
    private readonly cookies: SessionCookies,
    private readonly sessions: SessionService,
    private readonly roles: RolePermissions,
    private readonly limits: RateLimitService,
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
   *   (403) for a suspended account; `RATE_LIMITED` (429 with `Retry-After`) when the address used up its failed-lookup budget
   */
  async authenticate(
    subject: SubjectType,
    request: FastifyRequest,
    options: SessionAuthOptions,
  ): Promise<AuthenticatedSession> {
    return this.authenticateWith(subject, request, options, true);
  }

  /**
   * Refuses a request that does not carry a live session of the audience, and does nothing else.
   *
   * Why: decision 053. A multipart body of a session-cookie route is parsed before the access guard runs, so the `upload-session` stage asks
   * here before the body is read. It judges only that the cookie names a live session of this audience (stricter than a well-formed
   * cookie: a random string of the right shape fails); suspension, stage, approval, CSRF and permission stay with the guard. A cookie
   * that fails costs one point of the failed-lookup budget of the address and audience.
   *
   * Side effects: reads the session cache and, on a miss, the database; one point of the failed-lookup budget on a failure. No touch,
   * no principal.
   *
   * @param subject which subject's cookie to read
   * @param request the Fastify request
   * @throws {AppError} `UNAUTHORIZED` (401) for no cookie or a cookie that names no live session of the audience; `RATE_LIMITED` (429
   *   with `Retry-After`) when the address used up its failed-lookup budget
   */
  async precheck(subject: SubjectType, request: FastifyRequest): Promise<void> {
    const token = this.cookies.readToken(request, subject);
    if (token === undefined) throw new AppError('UNAUTHORIZED');
    if ((await this.liveView(subject, request, token, true)) === undefined) throw new AppError('UNAUTHORIZED');
  }

  /**
   * The session a cookie names, when it is live and of the audience.
   *
   * Why: decision 053. With `charge` the failed-lookup budget of the address is read first (nothing is looked up for an address that used
   * it up) and a cookie that does not count costs one point after the lookup; a valid session pays nothing.
   *
   * @throws {AppError} `RATE_LIMITED` when `charge` is set and the budget is used up
   */
  private async liveView(
    subject: SubjectType,
    request: FastifyRequest,
    token: string,
    charge: boolean,
  ): Promise<SessionView | undefined> {
    const key = sessionFailureKey(subject, request.ip);
    if (charge) {
      const budget = await this.limits.peek('ip', key);
      if (!budget.allowed) throw rateLimitedError(budget.retryAfterSeconds);
    }
    const view = await this.sessions.lookup(token);
    if (view && view.subjectType === subject && livenessOf(view, this.clock.nowMs()) === 'live') return view;
    if (charge) {
      const spent = await this.limits.consume('ip', key);
      if (!spent.allowed) throw rateLimitedError(spent.retryAfterSeconds);
    }
    return undefined;
  }

  /** The checks of {@link SessionAuthenticator.authenticate}; `charge` says whether a failed lookup is counted (decision 053). */
  private async authenticateWith(
    subject: SubjectType,
    request: FastifyRequest,
    options: SessionAuthOptions,
    charge: boolean,
  ): Promise<AuthenticatedSession> {
    const token = this.cookies.readToken(request, subject);
    if (token === undefined) throw new AppError('UNAUTHORIZED');
    const view = await this.liveView(subject, request, token, charge);
    if (!view) throw new AppError('UNAUTHORIZED');
    const now = this.clock.nowMs();

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
      return await this.authenticateWith(subject, request, options, false);
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
