// Unit tests of the session cookie helpers (decisions 018 and 064): names per subject, __Host- prefix when secure, attributes, the CSRF
// cookie named by the rank kind of an account, and the clearing of the old shop cookie.
import { describe, expect, it } from 'bun:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseEnv } from '@src/config';
import { TokenService } from '@src/infra/crypto';
import { SECOND, TestClock } from '../../../../support/clock';
import { CsrfService } from '@src/modules/identity/security/csrf';
import {
  CSRF_COOKIE_NAMES,
  LEGACY_STORE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAMES,
  SessionCookies,
} from '@src/modules/identity/security/session-cookies';

interface Call {
  readonly kind: 'set' | 'clear';
  readonly name: string;
  readonly value?: string;
  readonly options: Record<string, unknown>;
}

/** A reply that records the cookie calls and headers; every method returns the reply, as Fastify's do. */
function fakeReply() {
  const calls: Call[] = [];
  const headers: Record<string, string> = {};
  const reply = {
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      calls.push({ kind: 'set', name, value, options });
      return reply;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      calls.push({ kind: 'clear', name, options });
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, calls, headers };
}

/** The moment every test starts at: cookie lifetimes are counted from it, so they are exact. */
const clock = new TestClock('2026-11-01T10:00:00.000Z');
const after = (ms: number): Date => new Date(clock.nowMs() + ms);

function cookiesFor(env: Record<string, string>) {
  const config = parseEnv({ NODE_ENV: 'test', ...env });
  return new SessionCookies(config, new CsrfService(config), new TokenService(config), clock);
}

describe('names', () => {
  it("uses one session cookie name per subject, and the console's csrf_token for staff", () => {
    expect(SESSION_COOKIE_NAMES).toEqual({ staff: 'gsm_admin_session', account: 'gsm_client_session' });
    expect(CSRF_COOKIE_NAMES.staff).toBe('csrf_token');
    expect(new Set(Object.values(CSRF_COOKIE_NAMES)).size).toBe(3);
    const cookies = cookiesFor({});
    expect(cookies.sessionCookieName('staff')).toBe('gsm_admin_session');
    expect(cookies.sessionCookieName('account')).toBe('gsm_client_session');
  });

  it('names the readable CSRF cookie of an account by its rank kind, for good', () => {
    expect(CSRF_COOKIE_NAMES.merchant).toBe('csrf_token_client');
    expect(CSRF_COOKIE_NAMES.retail).toBe('csrf_token_store');
    const cookies = cookiesFor({});
    expect(cookies.csrfCookieName('merchant')).toBe('csrf_token_client');
    expect(cookies.csrfCookieName('retail')).toBe('csrf_token_store');
  });

  it('has no cookie of a customer subject any more: the shop cookie of before is only cleared', () => {
    expect(Object.keys(SESSION_COOKIE_NAMES)).not.toContain('customer');
    expect(Object.keys(SESSION_COOKIE_NAMES)).not.toContain('client');
    expect(LEGACY_STORE_SESSION_COOKIE_NAME).toBe('gsm_store_session');
    expect(Object.values(SESSION_COOKIE_NAMES)).not.toContain(LEGACY_STORE_SESSION_COOKIE_NAME);
  });

  it('adds the __Host- prefix to the session cookie when cookies are Secure', () => {
    const cookies = cookiesFor({ COOKIE_SECURE: 'true' });
    expect(cookies.sessionCookieName('staff')).toBe('__Host-gsm_admin_session');
    expect(cookies.sessionCookieName('account')).toBe('__Host-gsm_client_session');
    // The CSRF cookie must be readable and may carry a Domain, which __Host- forbids.
    expect(cookies.csrfCookieName('staff')).toBe('csrf_token');
  });
});

describe('set (staff)', () => {
  it('sets the httpOnly session cookie, the readable CSRF cookie and the response header', () => {
    const cookies = cookiesFor({});
    const { reply, calls, headers } = fakeReply();
    const csrf = cookies.set(reply, 'staff', 'the-session-token', after(600 * SECOND));
    const [session, csrfCookie] = calls;
    expect(session).toMatchObject({ kind: 'set', name: 'gsm_admin_session', value: 'the-session-token' });
    expect(session!.options).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
    expect(session!.options.maxAge).toBe(600);
    expect('domain' in session!.options).toBe(false);
    expect(csrfCookie).toMatchObject({ kind: 'set', name: 'csrf_token', value: csrf });
    expect(csrfCookie!.options).toMatchObject({ httpOnly: false, secure: false, sameSite: 'lax', path: '/' });
    expect('domain' in csrfCookie!.options).toBe(false);
    expect(csrfCookie!.options.maxAge).toBe(session!.options.maxAge);
    expect(headers['x-csrf-token']).toBe(csrf);
    expect(calls).toHaveLength(2);
  });

  it('gives a session that already ended a Max-Age of 0 instead of a negative one', () => {
    const { reply, calls } = fakeReply();
    cookiesFor({}).set(reply, 'staff', 'tok', after(-5 * SECOND));
    expect(calls[0]!.options.maxAge).toBe(0);
  });

  it('derives the CSRF token from the hash of the token it sets', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const csrf = new CsrfService(config);
    const tokens = new TokenService(config);
    const { reply } = fakeReply();
    const value = new SessionCookies(config, csrf, tokens, clock).set(reply, 'staff', 'abc', after(SECOND));
    expect(value).toBe(csrf.tokenFor(tokens.hash('abc')));
  });
});

describe('setAccount', () => {
  const names = (calls: readonly Call[]) => calls.map((call) => [call.kind, call.name]);

  it('sets the one session cookie and the CSRF cookie of a retail account, and clears the merchant name and the old shop cookie', () => {
    const cookies = cookiesFor({});
    const { reply, calls, headers } = fakeReply();
    const csrf = cookies.setAccount(reply, 'the-session-token', after(600 * SECOND), 'retail');
    expect(names(calls)).toEqual([
      ['set', 'gsm_client_session'],
      ['set', 'csrf_token_store'],
      ['clear', 'csrf_token_client'],
      ['clear', 'gsm_store_session'],
    ]);
    expect(calls[0]).toMatchObject({ value: 'the-session-token' });
    expect(calls[0]!.options).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 600 });
    expect(calls[1]).toMatchObject({ value: csrf });
    expect(calls[1]!.options).toMatchObject({ httpOnly: false, sameSite: 'lax', path: '/', maxAge: 600 });
    expect(headers['x-csrf-token']).toBe(csrf);
  });

  it('sets the CSRF cookie of a merchant account and clears the retail name (the reverse)', () => {
    const { reply, calls } = fakeReply();
    cookiesFor({}).setAccount(reply, 'tok', after(60 * SECOND), 'merchant');
    expect(names(calls)).toEqual([
      ['set', 'gsm_client_session'],
      ['set', 'csrf_token_client'],
      ['clear', 'csrf_token_store'],
      ['clear', 'gsm_store_session'],
    ]);
  });

  it('never sets both readable CSRF names: the shop decides merchant or retail from the one that exists', () => {
    for (const kind of ['merchant', 'retail'] as const) {
      const { reply, calls } = fakeReply();
      cookiesFor({}).setAccount(reply, 'tok', after(60 * SECOND), kind);
      const set = calls.filter((call) => call.kind === 'set' && call.name.startsWith('csrf_token'));
      expect(
        set.map((call) => call.name),
        kind,
      ).toEqual([CSRF_COOKIE_NAMES[kind]]);
    }
  });

  it('gives both CSRF names one value: the HMAC of the one session', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const csrf = new CsrfService(config);
    const tokens = new TokenService(config);
    const expected = csrf.tokenFor(tokens.hash('abc'));
    for (const kind of ['merchant', 'retail'] as const) {
      const { reply, headers } = fakeReply();
      expect(new SessionCookies(config, csrf, tokens, clock).setAccount(reply, 'abc', after(SECOND), kind), kind).toBe(
        expected,
      );
      expect(headers['x-csrf-token']).toBe(expected);
    }
  });

  it('marks the cookies Secure, prefixes the session cookie and the old shop cookie, and gives the CSRF names a Domain', () => {
    const { reply, calls } = fakeReply();
    cookiesFor({ COOKIE_SECURE: 'true', CSRF_COOKIE_DOMAIN: 'example.com' }).setAccount(
      reply,
      'tok',
      after(60 * SECOND),
      'merchant',
    );
    expect(names(calls)).toEqual([
      ['set', '__Host-gsm_client_session'],
      ['set', 'csrf_token_client'],
      ['clear', 'csrf_token_store'],
      ['clear', '__Host-gsm_store_session'],
    ]);
    expect(calls[0]!.options).toMatchObject({ secure: true, httpOnly: true });
    expect('domain' in calls[0]!.options).toBe(false);
    expect(calls[1]!.options).toMatchObject({ secure: true, httpOnly: false, domain: 'example.com' });
    // The cleared name carries the same Domain as the one it replaces, or the browser keeps it.
    expect(calls[2]!.options).toMatchObject({ domain: 'example.com', path: '/' });
    expect(calls[3]!.options).toMatchObject({ secure: true, httpOnly: true, path: '/' });
    expect('domain' in calls[3]!.options).toBe(false);
  });
});

describe('clear (staff)', () => {
  it('clears both cookies with the attributes they were set with', () => {
    const cookies = cookiesFor({ COOKIE_SECURE: 'true', CSRF_COOKIE_DOMAIN: 'example.com' });
    const { reply, calls } = fakeReply();
    cookies.clear(reply, 'staff');
    expect(calls.map((call) => [call.kind, call.name])).toEqual([
      ['clear', '__Host-gsm_admin_session'],
      ['clear', 'csrf_token'],
    ]);
    expect(calls[0]!.options).toMatchObject({ path: '/', secure: true, httpOnly: true });
    expect(calls[1]!.options).toMatchObject({ path: '/', domain: 'example.com' });
  });
});

describe('clearAccount', () => {
  it('clears the session cookie, both CSRF names with their Domain and the old shop cookie', () => {
    const cookies = cookiesFor({ COOKIE_SECURE: 'true', CSRF_COOKIE_DOMAIN: 'example.com' });
    const { reply, calls } = fakeReply();
    cookies.clearAccount(reply);
    expect(calls.map((call) => [call.kind, call.name])).toEqual([
      ['clear', '__Host-gsm_client_session'],
      ['clear', 'csrf_token_client'],
      ['clear', 'csrf_token_store'],
      ['clear', '__Host-gsm_store_session'],
    ]);
    expect(calls[0]!.options).toMatchObject({ path: '/', secure: true, httpOnly: true });
    expect(calls[1]!.options).toMatchObject({ path: '/', domain: 'example.com' });
    expect(calls[2]!.options).toMatchObject({ path: '/', domain: 'example.com' });
    expect(calls[3]!.options).toMatchObject({ path: '/', secure: true, httpOnly: true });
  });

  it('does not touch the staff cookies', () => {
    const { reply, calls } = fakeReply();
    cookiesFor({}).clearAccount(reply);
    expect(calls.map((call) => call.name)).not.toContain('gsm_admin_session');
    expect(calls.map((call) => call.name)).not.toContain('csrf_token');
  });
});

describe('readToken', () => {
  const request = (cookies: Record<string, string | undefined> | undefined) =>
    ({ cookies }) as unknown as FastifyRequest;

  it('reads the cookie of the subject only, and never the old shop cookie', () => {
    const cookies = cookiesFor({});
    const req = request({
      gsm_admin_session: 'staff-token',
      gsm_client_session: 'account-token',
      gsm_store_session: 'old-shop-token',
    });
    expect(cookies.readToken(req, 'staff')).toBe('staff-token');
    expect(cookies.readToken(req, 'account')).toBe('account-token');
    expect(cookies.readToken(request({ gsm_store_session: 'old-shop-token' }), 'account')).toBeUndefined();
  });

  it('treats a missing or empty cookie as no session, and reads the prefixed name when Secure', () => {
    expect(cookiesFor({}).readToken(request({ gsm_admin_session: '' }), 'staff')).toBeUndefined();
    expect(cookiesFor({}).readToken(request(undefined), 'staff')).toBeUndefined();
    const secure = cookiesFor({ COOKIE_SECURE: 'true' });
    expect(secure.readToken(request({ gsm_admin_session: 'plain' }), 'staff')).toBeUndefined();
    expect(secure.readToken(request({ '__Host-gsm_admin_session': 'prefixed' }), 'staff')).toBe('prefixed');
    expect(secure.readToken(request({ '__Host-gsm_client_session': 'prefixed' }), 'account')).toBe('prefixed');
  });
});
