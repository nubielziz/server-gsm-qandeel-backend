// The security stack under production rules (decision 018), against the test instances: Secure cookies with the __Host-
// prefix, the audit enforcement that only logs, and the CORS origin list. The rest of the suite runs in test mode.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, productionEnvOnTestInstances, signInStaff } from '../support/auth';
import { closeTestDb, resetDb } from '../support/db';
import { logSink } from '../support/log-sink';
import { SecurityTestController } from '../support/security-routes';

const CONSOLE = 'https://console.example.com';
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    controllers: [SecurityTestController],
    env: productionEnvOnTestInstances({ CORS_ORIGINS: CONSOLE, CSRF_COOKIE_DOMAIN: 'example.com' }),
  });
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  logSink.clear();
});

describe('cookies in production', () => {
  it('reads the session from the __Host- cookie only', async () => {
    const { session } = await signInStaff(t, []);
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/t/sec/session', headers: session.headers })).statusCode,
    ).toBe(200);
    const unprefixed = { cookie: `gsm_admin_session=${session.token}` };
    expect((await t.app.inject({ method: 'GET', url: '/admin/t/sec/session', headers: unprefixed })).statusCode).toBe(
      401,
    );
  });

  it('sets Secure cookies: the session cookie host-only with the prefix, the CSRF cookie readable with the domain', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/admin/t/sec/issue', headers: { origin: CONSOLE } });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.cookies.map((cookie) => [cookie.name, cookie]));
    expect(byName['__Host-gsm_admin_session']).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect(byName['__Host-gsm_admin_session']?.domain).toBeUndefined();
    expect(byName.csrf_token).toMatchObject({ secure: true, sameSite: 'Lax', path: '/', domain: 'example.com' });
    expect(byName.csrf_token?.httpOnly).toBeUndefined();
    expect(res.headers['x-csrf-token']).toBe(byName.csrf_token?.value);
  });
});

describe('the audit enforcement in production', () => {
  it('logs an error but lets the answer through, because the change is already committed', async () => {
    const { session } = await signInStaff(t, []);
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/t/sec/forgets-audit',
      headers: session.mutationHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const logged = logSink.lines.find((line) => String(line.msg ?? '').includes('wrote no audit row'));
    expect(logged).toBeDefined();
    expect(logged?.level).toBe(50);
  });
});

describe('the Origin check in production', () => {
  it('accepts only the configured origin for a session-less mutation', async () => {
    const call = (origin?: string) =>
      t.app.inject({ method: 'POST', url: '/admin/t/sec/login', headers: origin ? { origin } : {} });
    expect((await call(CONSOLE)).statusCode).toBe(200);
    expect((await call('https://evil.example.com')).statusCode).toBe(403);
    expect((await call()).statusCode).toBe(403);
  });
});
