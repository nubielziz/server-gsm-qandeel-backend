// The CSRF guard (decision 018, ALIGNMENT § 6): a mutation that carries a session needs the matching X-CSRF-Token header;
// a session-less mutation on /admin or /client needs an Origin header that is one of the configured CORS origins. A GET whose
// contract sets `originCheck` (a download of personal data with a side effect, RESOLUTIONS b2c-8) needs a same-site request.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getContract } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { accessStateOf } from './access-state';
import { CSRF_HEADER, CsrfService } from './csrf';

/** Methods that never change data; the API's GETs do not change state (ALIGNMENT § 1). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The `Sec-Fetch-Site` values a browser sends for a request that starts on the same site (RESOLUTIONS b2c-8). */
const SAME_SITE_FETCH = new Set(['same-origin', 'same-site']);
/** The surfaces whose session-less mutations get the Origin check. */
const ORIGIN_CHECKED_SURFACES = new Set(['admin', 'client']);

/**
 * Protects mutations against cross-site request forgery.
 *
 * Why: the session cookie is sent by the browser with every request to the API host, including requests started by another
 * site. A request that carries a session must therefore also carry the CSRF token the session's own sign-in answered with;
 * another site cannot read it. Mutations without a session (login, password set by emailed token, register) have nothing to
 * bind a token to, so they are protected by the exact-origin check instead. A refusal is `403 CSRF_FAILED`, which never signs
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
   * @throws {AppError} `CSRF_FAILED` (403) when the token is missing or wrong, or the Origin is missing or not allowed (or, for an
   *   `originCheck` GET, the request is not same-site)
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const contract = getContract(context.getHandler());
    if (!contract) return true;
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      // A GET changes no state, except the routes that declare `originCheck`: they have no token to bind (a download), so the
      // request must come from this site instead.
      if (contract.originCheck) this.assertSameSite(request);
      return true;
    }

    const { session } = accessStateOf(request);
    if (session) {
      this.csrf.assert(session.tokenHash, request.headers[CSRF_HEADER]);
      return true;
    }
    if (ORIGIN_CHECKED_SURFACES.has(contract.surface)) this.assertAllowedOrigin(request.headers.origin);
    return true;
  }

  /** Accepts `Sec-Fetch-Site` `same-origin` or `same-site`; without that header, an `Origin` exactly in the CORS origins. */
  private assertSameSite(request: FastifyRequest): void {
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string') {
      if (SAME_SITE_FETCH.has(site)) return;
      throw new AppError('CSRF_FAILED', { detail: 'This download must be started from the admin console.' });
    }
    this.assertAllowedOrigin(request.headers.origin);
  }

  private assertAllowedOrigin(origin: string | undefined): void {
    if (origin !== undefined && this.config.http.corsOrigins.includes(origin)) return;
    throw new AppError('CSRF_FAILED', {
      detail:
        origin === undefined
          ? 'This request must come from an allowed website (the Origin header is missing).'
          : 'This request comes from a website that is not allowed to call this API.',
    });
  }
}
