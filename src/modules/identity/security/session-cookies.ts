// Cookie helpers of the session surfaces (decision 018, ALIGNMENT § 3, § 6): one session cookie name per subject, httpOnly,
// Secure from COOKIE_SECURE, SameSite=Lax, Path=/, `__Host-` prefix when secure; plus the readable CSRF cookie and header.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../config';
import type { RankKind } from '../ports/rank-kind';
import type { SubjectType } from '../db/schema';
import { CSRF_HEADER, CsrfService } from './csrf';
import { TokenService } from '../../../infra/crypto';

/**
 * The session cookie name of each subject, without the `__Host-` prefix.
 *
 * Why: decision 018: one name per subject so the two never collide on the API host. Every account has the one cookie
 * `gsm_client_session`, whatever its rank, and both URL families (`/client` and `/store/v1`) read it (decision 064).
 */
export const SESSION_COOKIE_NAMES: Readonly<Record<SubjectType, string>> = {
  staff: 'gsm_admin_session',
  account: 'gsm_client_session',
};

/**
 * The readable CSRF cookie name of the staff and of each rank kind.
 *
 * Why: the console reads `csrf_token` (ALIGNMENT § 3). An account gets the name of its rank kind, for good (decision 064): the shop
 * picks the API family from the name that is set (`csrf_token_client` for a merchant rank, `csrf_token_store` for the retail rank). The
 * value is the same for both names (the HMAC of the session), and a rank change across kinds ends every session, so a name never
 * outlives the kind it names.
 */
export const CSRF_COOKIE_NAMES: Readonly<Record<'staff' | RankKind, string>> = {
  staff: 'csrf_token',
  merchant: 'csrf_token_client',
  retail: 'csrf_token_store',
};

/**
 * The session cookie of the shop before the accounts merged, without the `__Host-` prefix.
 *
 * Why: it is never read again; every sign-in and sign-out of an account clears it, so a browser does not keep a dead credential
 * (decision 064; the contract release stops touching it).
 */
export const LEGACY_STORE_SESSION_COOKIE_NAME = 'gsm_store_session';

/**
 * The name of the cookie that marks the browser which asked for a storefront sign-in link, without the `__Host-` prefix.
 *
 * Why: `POST /store/v1/auth/verify` signs the browser that asked for the link in at once, and must not let a link asked for in
 * another browser replace a customer's session there; this cookie (HttpOnly, as long as the link lives) tells the two apart.
 */
const LINK_BROWSER_COOKIE_NAME = 'gsm_store_link';

/**
 * Reads, sets and clears the cookies of a session.
 *
 * Why: the sign-in routes of both subjects must set exactly the same cookies and header, and the guards must read the
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.secure = config.security.cookieSecure;
    this.csrfDomain = config.security.csrfCookieDomain;
  }

  /**
   * Returns the session cookie name of a subject.
   *
   * @param subject staff or account
   * @returns `gsm_admin_session` or `gsm_client_session`, with the `__Host-` prefix when cookies are Secure
   */
  sessionCookieName(subject: SubjectType): string {
    return this.hostPrefixed(SESSION_COOKIE_NAMES[subject]);
  }

  /**
   * Returns the CSRF cookie name of the staff or of a rank kind.
   *
   * @param holder `staff`, or the rank kind of an account
   * @returns `csrf_token` for staff, `csrf_token_client` for a merchant rank, `csrf_token_store` for the retail rank
   */
  csrfCookieName(holder: 'staff' | RankKind): string {
    return CSRF_COOKIE_NAMES[holder];
  }

  private hostPrefixed(name: string): string {
    return this.secure ? `__Host-${name}` : name;
  }

  /**
   * Reads the session token from the request's cookie.
   *
   * @param request the Fastify request (cookies are parsed by `@fastify/cookie`)
   * @param subject which subject's cookie to read (an account reads `gsm_client_session`, whatever its rank)
   * @returns the token, or `undefined` when the cookie is missing or empty
   */
  readToken(request: FastifyRequest, subject: SubjectType): string | undefined {
    const value = request.cookies?.[this.sessionCookieName(subject)];
    return value === undefined || value === '' ? undefined : value;
  }

  /**
   * Reads the cookie that marks the browser which asked for a storefront sign-in link.
   *
   * @param request the Fastify request
   * @returns the value, or `undefined` when the cookie is missing or empty
   */
  readLinkBrowser(request: FastifyRequest): string | undefined {
    const value = request.cookies?.[this.linkBrowserCookieName()];
    return value === undefined || value === '' ? undefined : value;
  }

  /**
   * Sets the cookie that marks the browser which asked for a storefront sign-in link.
   *
   * Why: the link's row keeps the keyed hash of this value, so the exchange can tell the asking browser from another one. HttpOnly,
   * SameSite=Lax, host-only, and it lives as long as the link.
   *
   * Side effects: writes a `Set-Cookie` header.
   *
   * @param reply the Fastify reply
   * @param value the random value whose keyed hash the link stores
   * @param expiresAt when the link ends; the cookie gets the same lifetime
   */
  setLinkBrowser(reply: FastifyReply, value: string, expiresAt: Date): void {
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - this.clock.nowMs()) / 1000));
    void reply.setCookie(this.linkBrowserCookieName(), value, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
  }

  /** The asking-browser cookie's name, with the `__Host-` prefix when cookies are Secure. */
  private linkBrowserCookieName(): string {
    return this.secure ? `__Host-${LINK_BROWSER_COOKIE_NAME}` : LINK_BROWSER_COOKIE_NAME;
  }

  /**
   * Sets the session cookie, the CSRF cookie and the `X-CSRF-Token` header for a new or rotated staff session.
   *
   * Why: login and the 2FA step answer with all three, so the console can read the token from the cookie or, cross-site, from the
   * header. Accounts use {@link SessionCookies.setAccount}, whose CSRF cookie name depends on the rank kind.
   *
   * @param reply the Fastify reply
   * @param subject `staff`
   * @param token the session token (from `SessionService.create` or `rotate`)
   * @param expiresAt when the session ends; the cookies get the same lifetime
   * @returns the CSRF token that was set
   */
  set(reply: FastifyReply, subject: 'staff', token: string, expiresAt: Date): string {
    const csrfToken = this.csrf.tokenFor(this.tokens.hash(token));
    void this.writeSession(reply, subject, token, expiresAt)
      .setCookie(this.csrfCookieName('staff'), csrfToken, this.csrfOptions(this.maxAgeOf(expiresAt)))
      .header(CSRF_HEADER, csrfToken);
    return csrfToken;
  }

  /**
   * Clears the staff cookies (`Max-Age=0`), as the logout answer does.
   *
   * @param reply the Fastify reply
   * @param subject `staff`
   */
  clear(reply: FastifyReply, subject: 'staff'): void {
    void reply
      .clearCookie(this.sessionCookieName(subject), this.sessionOptions())
      .clearCookie(this.csrfCookieName('staff'), this.csrfOptions());
  }

  /**
   * Sets the cookies of a new or rotated account session: the one session cookie, the readable CSRF cookie named by the rank kind and
   * the `X-CSRF-Token` header; the other CSRF name and the shop's old session cookie are cleared.
   *
   * Why: decision 064. Both URL families read `gsm_client_session`. The shop decides "merchant or retail" from which readable CSRF
   * cookie exists, so only the one of the account's rank kind may be set (setting both would send a retail account to the merchant
   * routes); the other name is cleared in case a browser still holds it from before a rank change. `gsm_store_session` is never read
   * again, so it is cleared on every sign-in.
   *
   * Side effects: writes `Set-Cookie` headers (four) and the `X-CSRF-Token` header.
   *
   * @param reply the Fastify reply
   * @param token the session token (from `SessionService.create` or `rotate`)
   * @param expiresAt when the session ends; the cookies get the same lifetime
   * @param rankKind the rank kind of the account, read under its lock when the session is opened
   * @returns the CSRF token that was set
   */
  setAccount(reply: FastifyReply, token: string, expiresAt: Date, rankKind: RankKind): string {
    const csrfToken = this.csrf.tokenFor(this.tokens.hash(token));
    const other: RankKind = rankKind === 'merchant' ? 'retail' : 'merchant';
    void this.writeSession(reply, 'account', token, expiresAt)
      .setCookie(this.csrfCookieName(rankKind), csrfToken, this.csrfOptions(this.maxAgeOf(expiresAt)))
      .clearCookie(this.csrfCookieName(other), this.csrfOptions())
      .clearCookie(this.legacyStoreSessionName(), this.sessionOptions())
      .header(CSRF_HEADER, csrfToken);
    return csrfToken;
  }

  /**
   * Clears every cookie of an account session: the session cookie, both CSRF names and the shop's old session cookie (`Max-Age=0`).
   *
   * Why: decision 064: sign-out does not know the rank kind any more (it may have changed), so both readable names go.
   *
   * @param reply the Fastify reply
   */
  clearAccount(reply: FastifyReply): void {
    void reply
      .clearCookie(this.sessionCookieName('account'), this.sessionOptions())
      .clearCookie(this.csrfCookieName('merchant'), this.csrfOptions())
      .clearCookie(this.csrfCookieName('retail'), this.csrfOptions())
      .clearCookie(this.legacyStoreSessionName(), this.sessionOptions());
  }

  /** The shop's old session cookie name, with the `__Host-` prefix when cookies are Secure. */
  private legacyStoreSessionName(): string {
    return this.hostPrefixed(LEGACY_STORE_SESSION_COOKIE_NAME);
  }

  private writeSession(reply: FastifyReply, subject: SubjectType, token: string, expiresAt: Date): FastifyReply {
    return reply.setCookie(this.sessionCookieName(subject), token, {
      ...this.sessionOptions(),
      maxAge: this.maxAgeOf(expiresAt),
    });
  }

  private maxAgeOf(expiresAt: Date): number {
    return Math.max(0, Math.floor((expiresAt.getTime() - this.clock.nowMs()) / 1000));
  }

  /** The attributes of a session cookie (HttpOnly, host-only: `__Host-` needs no `Domain`). */
  private sessionOptions(): { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/' } {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' };
  }

  /** The attributes of a readable CSRF cookie; `Domain` from `CSRF_COOKIE_DOMAIN` so a console on a sibling origin can read it. */
  private csrfOptions(maxAge?: number): {
    httpOnly: false;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge?: number;
    domain?: string;
  } {
    return {
      httpOnly: false,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      ...(maxAge !== undefined ? { maxAge } : {}),
      ...(this.csrfDomain ? { domain: this.csrfDomain } : {}),
    };
  }
}
