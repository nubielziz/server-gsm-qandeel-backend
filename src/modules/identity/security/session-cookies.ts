// Cookie helpers of the session surfaces (decision 018, ALIGNMENT § 3, § 6): one session cookie name per subject, httpOnly,
// Secure from COOKIE_SECURE, SameSite=Lax, Path=/, `__Host-` prefix when secure; plus the readable CSRF cookie and header.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../../config';
import type { SubjectType } from '../db/schema';
import { CSRF_HEADER, CsrfService } from './csrf';
import { TokenService } from '../../../infra/crypto';

/**
 * The session cookie name of each subject, without the `__Host-` prefix.
 *
 * Why: decision 018: one name per subject so the three never collide on the API host (the console, the merchant portal
 * and the storefront share it).
 */
export const SESSION_COOKIE_NAMES: Readonly<Record<SubjectType, string>> = {
  staff: 'gsm_admin_session',
  client: 'gsm_client_session',
  customer: 'gsm_store_session',
};

/**
 * The readable CSRF cookie name of each subject.
 *
 * Why: the console reads `csrf_token` (ALIGNMENT § 3). The merchant portal and the storefront get their own names so that
 * two apps on one registrable domain do not overwrite each other's token.
 */
export const CSRF_COOKIE_NAMES: Readonly<Record<SubjectType, string>> = {
  staff: 'csrf_token',
  client: 'csrf_token_client',
  customer: 'csrf_token_store',
};

/**
 * Reads, sets and clears the cookies of a session.
 *
 * Why: the sign-in routes of the three subjects must set exactly the same cookies and header, and the guards must read the
 * same names. The session cookie is host-only (no `Domain`), which `__Host-` requires; the CSRF cookie carries `Domain`
 * from `CSRF_COOKIE_DOMAIN` so a console on a sibling origin can read it.
 *
 * Side effects: `set` and `clear` write `Set-Cookie` headers and (`set`) the `X-CSRF-Token` response header.
 */
@Injectable()
export class SessionCookies {
  private readonly secure: boolean;
  private readonly csrfDomain: string | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly csrf: CsrfService,
    private readonly tokens: TokenService,
  ) {
    this.secure = config.security.cookieSecure;
    this.csrfDomain = config.security.csrfCookieDomain;
  }

  /**
   * Returns the session cookie name of a subject.
   *
   * @param subject staff, merchant (`client`) or customer
   * @returns for example `gsm_admin_session`, or `__Host-gsm_admin_session` when cookies are Secure
   */
  sessionCookieName(subject: SubjectType): string {
    const name = SESSION_COOKIE_NAMES[subject];
    return this.secure ? `__Host-${name}` : name;
  }

  /**
   * Returns the CSRF cookie name of a subject.
   *
   * @param subject staff, merchant (`client`) or customer
   * @returns `csrf_token` for staff, `csrf_token_client` and `csrf_token_store` for the others
   */
  csrfCookieName(subject: SubjectType): string {
    return CSRF_COOKIE_NAMES[subject];
  }

  /**
   * Reads the session token from the request's cookie.
   *
   * @param request the Fastify request (cookies are parsed by `@fastify/cookie`)
   * @param subject which subject's cookie to read
   * @returns the token, or `undefined` when the cookie is missing or empty
   */
  readToken(request: FastifyRequest, subject: SubjectType): string | undefined {
    const value = request.cookies?.[this.sessionCookieName(subject)];
    return value === undefined || value === '' ? undefined : value;
  }

  /**
   * Sets the session cookie, the CSRF cookie and the `X-CSRF-Token` header for a new or rotated session.
   *
   * Why: login, the 2FA step and the other sign-ins answer with all three, so the console can read the token from the cookie
   * or, cross-site, from the header.
   *
   * @param reply the Fastify reply
   * @param subject the subject the session belongs to
   * @param token the session token (from `SessionService.create` or `rotate`)
   * @param expiresAt when the session ends; the cookies get the same lifetime
   * @returns the CSRF token that was set
   */
  set(reply: FastifyReply, subject: SubjectType, token: string, expiresAt: Date): string {
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const csrfToken = this.csrf.tokenFor(this.tokens.hash(token));
    void reply
      .setCookie(this.sessionCookieName(subject), token, {
        httpOnly: true,
        secure: this.secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      })
      .setCookie(this.csrfCookieName(subject), csrfToken, {
        httpOnly: false,
        secure: this.secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
        ...(this.csrfDomain ? { domain: this.csrfDomain } : {}),
      })
      .header(CSRF_HEADER, csrfToken);
    return csrfToken;
  }

  /**
   * Clears both cookies (`Max-Age=0`), as the logout answer does.
   *
   * @param reply the Fastify reply
   * @param subject the subject that signs out
   */
  clear(reply: FastifyReply, subject: SubjectType): void {
    void reply
      .clearCookie(this.sessionCookieName(subject), { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' })
      .clearCookie(this.csrfCookieName(subject), {
        httpOnly: false,
        secure: this.secure,
        sameSite: 'lax',
        path: '/',
        ...(this.csrfDomain ? { domain: this.csrfDomain } : {}),
      });
  }
}
