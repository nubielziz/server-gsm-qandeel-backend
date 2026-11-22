// The CSRF guard (decisions 018 and 045, ALIGNMENT § 6): a mutation that carries a session needs the matching X-CSRF-Token
// header; a session-less mutation on /admin or /client (and the /store/v1 sign-in routes) needs an Origin header that is one of
// the origins of the route's surface. A GET whose contract sets `originCheck` (a download, a stream) needs a request started by
// the surface's own page.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { audienceOfSurface, originsOf } from '../../../common/browser-origins';
import { getContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { accessStateOf } from './access-state';
import { CSRF_HEADER, CsrfService } from './csrf';
import { originCheckedGetRefusal, sessionlessOriginRefusal } from './origin-checks';

/** Methods that never change data; the API's GETs do not change state (ALIGNMENT § 1). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The surfaces whose session-less mutations always get the Origin check (the store's only with `originCheck`). */
const ORIGIN_CHECKED_SURFACES = new Set(['admin', 'client']);

/**
 * Protects mutations against cross-site request forgery.
 *
 * Why: the session cookie is sent by the browser with every request to the API host, including requests started by another
 * site. A request that carries a session must therefore also carry the CSRF token the session's own sign-in answered with;
 * another site cannot read it. Mutations without a session (login, password set by emailed token, register) have nothing to
 * bind a token to, so they are protected by the exact-origin check instead, against the origins of the route's own surface (the
 * console's on `/admin`, the shop's on `/client` and `/store/v1`, decision 045). A refusal is `403 CSRF_FAILED`, which never signs
 * the caller out.
 *
 * Runs after authentication (it needs to know whether a session authenticated the request).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Checks the CSRF protection of a request.
   *
   * @param context the request being handled
   * @returns true when the request may proceed (a safe method, a matching token, or an allowed origin)
   * @throws {AppError} `CSRF_FAILED` (403) when the token is missing or wrong, or the Origin is missing or not on the route's
   *   surface's list (or, for an `originCheck` GET, the request is neither `Sec-Fetch-Site: same-origin` nor from a listed origin)
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const contract = getContract(context.getHandler());
    if (!contract) return true;
    const allowed = originsOf(this.config.http, audienceOfSurface(contract.surface));
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      // A GET changes no state, except the routes that declare originCheck: they carry no token (a download, a stream), so the
      // request must have been started by one of the surface's own pages instead.
      if (contract.originCheck) refuse(originCheckedGetRefusal(request.headers, allowed));
      return true;
    }
    const { session } = accessStateOf(request);
    if (session) {
      this.csrf.assert(session.tokenHash, request.headers[CSRF_HEADER]);
      return true;
    }
    // A mutation without a session: every one on /admin and /client, and the /store/v1 routes that declare originCheck (the
    // sign-in routes), must come from one of the surface's own origins.
    if (ORIGIN_CHECKED_SURFACES.has(contract.surface) || contract.originCheck) {
      refuse(sessionlessOriginRefusal(request.headers.origin, allowed));
    }
    return true;
  }
}

/** Throws `CSRF_FAILED` with the detail when an Origin rule refused the request. */
function refuse(detail: string | undefined): void {
  if (detail !== undefined) throw new AppError('CSRF_FAILED', { detail });
}
