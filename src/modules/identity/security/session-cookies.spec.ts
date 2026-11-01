// Unit tests of the session cookie helpers (decision 018): names per subject, __Host- prefix when secure, attributes, CSRF cookie.
import { describe, expect, it } from 'bun:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseEnv } from '../../../config';
import { TokenService } from '../../../infra/crypto';
import { SECOND, TestClock } from '../../../../test/support/clock';
import { CsrfService } from './csrf';
import { CSRF_COOKIE_NAMES, SESSION_COOKIE_NAMES, SessionCookies } from './session-cookies';

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
    expect(SESSION_COOKIE_NAMES).toEqual({
      staff: 'gsm_admin_session',
      client: 'gsm_client_session',
      customer: 'gsm_store_session',
    });
    expect(CSRF_COOKIE_NAMES.staff).toBe('csrf_token');
    expect(new Set(Object.values(CSRF_COOKIE_NAMES)).size).toBe(3);
    const cookies = cookiesFor({});
    expect(cookies.sessionCookieName('staff')).toBe('gsm_admin_session');
    expect(cookies.csrfCookieName('client')).toBe('csrf_token_client');
  });

  it('adds the __Host- prefix to the session cookie when cookies are Secure', () => {
    const cookies = cookiesFor({ COOKIE_SECURE: 'true' });
    expect(cookies.sessionCookieName('staff')).toBe('__Host-gsm_admin_session');
    expect(cookies.sessionCookieName('customer')).toBe('__Host-gsm_store_session');
    // The CSRF cookie must be readable and may carry a Domain, which __Host- forbids.
    expect(cookies.csrfCookieName('staff')).toBe('csrf_token');
  });
});

describe('set', () => {
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
  });

  it('marks both cookies Secure and prefixes the session cookie in production-style settings', () => {
    const cookies = cookiesFor({ COOKIE_SECURE: 'true', CSRF_COOKIE_DOMAIN: 'example.com' });
    const { reply, calls } = fakeReply();
    cookies.set(reply, 'client', 'tok', after(60 * SECOND));
    expect(calls[0]).toMatchObject({ name: '__Host-gsm_client_session' });
    expect(calls[0]!.options).toMatchObject({ secure: true, httpOnly: true });
    expect('domain' in calls[0]!.options).toBe(false);
    expect(calls[1]).toMatchObject({ name: 'csrf_token_client' });
    expect(calls[1]!.options).toMatchObject({ secure: true, httpOnly: false, domain: 'example.com' });
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

describe('clear', () => {
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

describe('readToken', () => {
  const request = (cookies: Record<string, string | undefined> | undefined) =>
    ({ cookies }) as unknown as FastifyRequest;

  it('reads the cookie of the subject only', () => {
    const cookies = cookiesFor({});
    const req = request({ gsm_admin_session: 'staff-token', gsm_client_session: 'client-token' });
    expect(cookies.readToken(req, 'staff')).toBe('staff-token');
    expect(cookies.readToken(req, 'client')).toBe('client-token');
    expect(cookies.readToken(req, 'customer')).toBeUndefined();
  });

  it('treats a missing or empty cookie as no session, and reads the prefixed name when Secure', () => {
    expect(cookiesFor({}).readToken(request({ gsm_admin_session: '' }), 'staff')).toBeUndefined();
    expect(cookiesFor({}).readToken(request(undefined), 'staff')).toBeUndefined();
    const secure = cookiesFor({ COOKIE_SECURE: 'true' });
    expect(secure.readToken(request({ gsm_admin_session: 'plain' }), 'staff')).toBeUndefined();
    expect(secure.readToken(request({ '__Host-gsm_admin_session': 'prefixed' }), 'staff')).toBe('prefixed');
  });
});
