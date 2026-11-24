// SessionAuthenticator: turns a session cookie into a principal (decision 018). The same mechanics serve staff and accounts of every
// rank: cookie, lookup, expiry, account state, stage, permissions of the role, and the once-a-minute last-seen write.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import type { RouteRank } from '../../../common/contract';
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
 * Refuses a session whose rank is not the one the route serves.
 *
 * Why: decision 064, the default-deny rank gate. A `merchant` route serves merchant ranks, a `retail` route the retail rank, `any` every
 * rank. A view without a rank is refused on every route that names one (fail closed). The refusal is `403 RANK_NOT_ALLOWED`, a code
 * that never signs the caller out: the shops keep the session and show the account's own pages.
 *
 * @param view the live session of an account
 * @param required the rank of the route (`contract.rank`); `null` (a route outside the gate) and `any` let every rank through
 * @throws {AppError} `RANK_NOT_ALLOWED` (403) when the rank kind of the session is not `required`
 */
export function assertRankAllowed(view: Pick<SessionView, 'subject'>, required: RouteRank | null): void {
  if (required === null || required === 'any' || view.subject.rank?.kind === required) return;
  throw new AppError('RANK_NOT_ALLOWED', {
    detail: required === 'merchant' ? 'This is available to merchant accounts.' : 'This is available to shop accounts.',
  });
}

/**
 * The key of the failed-lookup budget of a client address and audience, on the `ip` limiter.
 *
 * Why: decision 053. A session cookie that names no live session costs a cache read and, on a miss, a database read; the budget bounds
 * those lookups per address (the IPv4 address or the IPv6 /64) and per audience, so a stale cookie of one audience never uses up
 * the budget of another, and one address never uses up the budget of another.
 *
 * @param subject the audience of the cookie (staff or account: one budget for both URL families of the accounts)
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
 * the budget of unknown API keys); once it is used up the address costs no database lookup: its cookies are answered from the session
 * cache alone, so a session in use there (its view is kept fresh by its requests) is still served, and a cookie the cache does not
 * hold is refused `429`. A request without the cookie costs nothing, and neither does a cookie of a live session.
 * `authenticateOptional` (public routes that accept an optional session) charges nothing: the store is counted per address by the
 * `ip` stage already.
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
   * @param subject which subject's cookie to read (staff or account)
   * @param request the Fastify request
   * @param options the stages the route accepts
   * @returns the session and the principal
   * @throws {AppError} `UNAUTHORIZED` (401) for no, unknown, revoked, ended or wrong-stage sessions, and for an account session without
   *   a readable rank; `ACCOUNT_SUSPENDED` (403) for a suspended or blocked account; `RATE_LIMITED` (429 with `Retry-After`) when the address used up its failed-lookup budget and the
   *   cache holds no live view of the session
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
   * here before the body is read. It judges that the cookie names a live session of this audience (stricter than a well-formed
   * cookie: a random string of the right shape fails) and, for an account's route, the rank gate (decision 064, the upload pre-check):
   * a retail session posting to a merchant route is refused before the body is buffered. Suspension, stage, CSRF and permission stay
   * with the guard (a suspended account is not judged here: the guard answers it `ACCOUNT_SUSPENDED`). A cookie that fails costs one
   * point of the failed-lookup budget of the address and audience.
   *
   * Side effects: reads the session cache and, on a miss, the database; one point of the failed-lookup budget on a failure. No touch,
   * no principal.
   *
   * @param subject which subject's cookie to read
   * @param request the Fastify request
   * @param rank the rank of the route (`contract.rank`); left out or `null` for a route outside the rank gate
   * @throws {AppError} `UNAUTHORIZED` (401) for no cookie or a cookie that names no live session of the audience; `RANK_NOT_ALLOWED`
   *   (403) for a session of another rank; `RATE_LIMITED` (429 with `Retry-After`) when the address used up its failed-lookup budget and
   *   the cache holds no live view of the session
   */
  async precheck(subject: SubjectType, request: FastifyRequest, rank: RouteRank | null = null): Promise<void> {
    const token = this.cookies.readToken(request, subject);
    if (token === undefined) throw new AppError('UNAUTHORIZED');
    const view = await this.liveView(subject, request, token, true);
    if (view === undefined) throw new AppError('UNAUTHORIZED');
    if (subject === 'account' && view.subject.state === 'ok') assertRankAllowed(view, rank);
  }

  /**
   * The session a cookie names, when it is live and of the audience.
   *
   * Why: decision 053. With `charge` the failed-lookup budget of the address is read first: for an address that used it up the session
   * is looked up in the cache only (no database read), so a session in use there is still served; otherwise a cookie that does not
   * count costs one point after the lookup. A valid session pays nothing.
   *
   * @throws {AppError} `RATE_LIMITED` when `charge` is set, the budget is used up and the cache holds no live view of the session
   */
  private async liveView(
    subject: SubjectType,
    request: FastifyRequest,
    token: string,
    charge: boolean,
  ): Promise<SessionView | undefined> {
    const key = sessionFailureKey(subject, request.ip);
    const budget = charge ? await this.limits.peek('ip', key) : undefined;
    // An address that used up its budget costs no database lookup; a session whose view is cached is still served.
    const exhausted = budget !== undefined && !budget.allowed;
    const view = exhausted ? await this.sessions.lookupCached(token) : await this.sessions.lookup(token);
    if (view && view.subjectType === subject && livenessOf(view, this.clock.nowMs()) === 'live') return view;
    if (budget && !budget.allowed) throw rateLimitedError(budget.retryAfterSeconds);
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
      case 'account': {
        // A view without a rank cannot have been built by the account resolver; refuse it instead of guessing a kind (fail closed).
        const rank = view.subject.rank;
        if (rank === undefined) throw new AppError('UNAUTHORIZED');
        return {
          kind: 'account',
          accountId: view.subjectId,
          clientId: view.subjectId,
          rank: { id: rank.id, kind: rank.kind },
          stage: view.stage,
          ip,
          session: view,
        };
      }
    }
  }
}
