// Integration tests of the live event streams (decision 037, plan docs/briefs/27-realtime-notifications.md § 8): a listening test
// app on real Postgres and Redis with a TestClock and manual timers. The hijacked reply behind the guard and the contract
// interceptor, the headers, `ready` first, the refusals (401, CSRF, caps, kill switch), the heartbeat and the maximum age, the
// session doorbells, the shutdown, a client that does not read, and the access log and request histogram skipping the stream.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { MetricsService } from '@src/infra/metrics';
import {
  type Delivery,
  RealtimeHub,
  RealtimePublisher,
  type RealtimeSource,
  RealtimeSources,
} from '@src/infra/realtime';
import { SessionService } from '@src/modules/identity';
import { buildOpenApiDocuments } from '@src/modules/platform';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, clearRateLimits, insertRole, insertStaff, openSession } from '../../support/auth';
import { ManualTimers, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { logSink } from '../../support/log-sink';
import { metricValue } from '../../support/metrics';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { makeCustomer } from '../../support/store';
import { SAME_ORIGIN, type TestStream, clearStreamLimits, listen, openStream } from '../../support/stream';

const clock = new TestClock();
const timers = new ManualTimers(clock);
let t: TestApp;
let base: string;
const open: TestStream[] = [];

/** Opens a stream on an app and remembers it, so every test ends with its streams closed. */
async function stream(path: string, headers: Record<string, string>, on = base): Promise<TestStream> {
  const opened = await openStream(`${on}${path}`, headers);
  open.push(opened);
  return opened;
}

interface Viewer {
  readonly id: number;
  readonly sessionId: number;
  readonly token: string;
  /** The cookie and the CSRF token, for a mutation. */
  readonly mutation: Record<string, string>;
  /** The headers of a same-origin EventSource request with the session cookie. */
  readonly headers: Record<string, string>;
}

/** A signed-in customer (a new session of `existing` when given). */
async function customer(app: TestApp = t, existing?: number): Promise<Viewer> {
  const id = existing ?? (await makeCustomer(app)).id;
  const session = await openSession(app, { type: 'account', id });
  return {
    id,
    sessionId: session.sessionId,
    token: session.token,
    mutation: session.mutationHeaders,
    headers: { ...SAME_ORIGIN, ...session.headers },
  };
}

/** Takes `ready` and the snapshot's count, the frames every stream starts with. */
async function started(s: TestStream): Promise<TestStream> {
  expect(s.status).toBe(200);
  expect((await s.next()).event).toBe('ready');
  expect((await s.next()).event).toBe('unread.changed');
  return s;
}

const metrics = (app: TestApp = t) => app.app.get(MetricsService).render();
const hubOf = (app: TestApp = t) => app.app.get(RealtimeHub);

beforeAll(async () => {
  await testDb();
  t = await createTestApp({
    clock,
    timers,
    env: { CORS_ORIGINS: CONSOLE_ORIGIN, REALTIME_MAX_PER_IP: '4', REALTIME_MAX_AGE_SECONDS: '60' },
  });
  base = await listen(t);
});
afterAll(async () => {
  await t.close();
  await resetDb();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits(t);
  await clearStreamLimits(t);
  logSink.clear();
});
afterEach(async () => {
  for (const opened of open.splice(0)) opened.close();
  await eventually(() => (hubOf().size === 0 ? true : undefined));
});

describe('a stream', () => {
  it('passes the guard and the contract interceptor as a hijacked reply: SSE headers, retry, ready first, then the count', async () => {
    const { headers } = await customer();
    const s = await stream('/store/v1/me/stream', headers);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-cache, no-transform');
    expect(s.headers['x-accel-buffering']).toBe('no');
    expect(s.headers['x-request-id']).toMatch(/.+/);
    // The security headers of the pipeline (helmet, an onRequest hook) are on the hijacked reply too.
    expect(s.headers['x-content-type-options']).toBe('nosniff');
    expect(s.headers['content-security-policy']).toContain("default-src 'none'");
    expect(s.headers['content-length']).toBeUndefined();
    const ready = await s.next();
    expect(ready.event).toBe('ready');
    expect(ready.id).toBeUndefined();
    expect(ready.data).toEqual({ v: 1, heartbeatMs: 15_000, resumed: false, serverTime: clock.now().toISOString() });
    expect(s.retryMs).toBeGreaterThanOrEqual(2000);
    expect(s.retryMs).toBeLessThanOrEqual(5000);
    expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread: 0 } });
    expect(hubOf().size).toBe(1);
  });

  it('drops a `locale` query like any unknown key: the language parameter is gone (decision 039)', async () => {
    const { headers } = await customer();
    const s = await stream('/store/v1/me/stream?locale=en', headers);
    expect(s.status).toBe(200);
    expect((await s.next()).event).toBe('ready');
  });

  it('answers 401 without a session on each surface, as problem+json before any stream', async () => {
    for (const path of ['/admin/stream', '/client/stream', '/store/v1/me/stream']) {
      const s = await stream(path, { ...SAME_ORIGIN });
      expect(s.status, path).toBe(401);
      expect(s.headers['content-type']).toContain('application/problem+json');
      expect(s.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
    expect(hubOf().size).toBe(0);
  });

  it('refuses a cross-site request, a same-site one, and one without Sec-Fetch-Site or an allowed Origin (403 CSRF_FAILED)', async () => {
    const { headers } = await customer();
    const { cookie } = headers as { cookie: string };
    const crossSite = await stream('/store/v1/me/stream', { ...headers, 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toMatchObject({ code: 'CSRF_FAILED' });
    // Every host of the registrable domain is same-site: only same-origin or a listed Origin starts a stream (decision 045).
    const sameSite = await stream('/store/v1/me/stream', { ...headers, 'sec-fetch-site': 'same-site' });
    expect(sameSite.status).toBe(403);
    expect(sameSite.body).toMatchObject({ code: 'CSRF_FAILED' });
    const bare = await stream('/store/v1/me/stream', { cookie, accept: 'text/event-stream' });
    expect(bare.status).toBe(403);
    const foreign = await stream('/store/v1/me/stream', { cookie, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(hubOf().size).toBe(0);
  });

  it('accepts a same-origin EventSource (no Origin), the headers a Next rewrite or the Vite proxy forward, and an allowed Origin', async () => {
    const { headers } = await customer();
    const { cookie } = headers as { cookie: string };
    // A same-origin EventSource GET carries no Origin header, only Sec-Fetch-Site (the fetch spec).
    await started(await stream('/store/v1/me/stream', headers));
    // Next's rewrite proxy (httpxy, changeOrigin) and Vite's proxy keep the browser's Sec-Fetch-* headers and add X-Forwarded-*.
    await started(
      await stream('/store/v1/me/stream', {
        ...headers,
        'x-forwarded-host': 'shop.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '198.51.100.7',
      }),
    );
    const allowed = await stream('/store/v1/me/stream', { cookie, origin: CONSOLE_ORIGIN });
    await started(allowed);
    expect(allowed.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses the 4th stream of a session with 429 and lets a new one in once one closed', async () => {
    const viewer = await customer();
    const streams = [];
    for (let i = 0; i < 3; i++) streams.push(await started(await stream('/store/v1/me/stream', viewer.headers)));
    const fourth = await stream('/store/v1/me/stream', viewer.headers);
    expect(fourth.status).toBe(429);
    expect(fourth.headers['retry-after']).toBe('60');
    expect(fourth.body).toMatchObject({ code: 'RATE_LIMITED', detail: 'Too many open live connections.' });
    expect(metricValue(await metrics(), 'realtime_connections_refused_total', { reason: 'session_cap' })).toBe(1);
    streams[0]!.close();
    await eventually(() => (hubOf().size === 2 ? true : undefined));
    await started(await stream('/store/v1/me/stream', viewer.headers));
  });

  it('refuses the newest stream of an address over the per-address cap, never an older one', async () => {
    const first = await customer();
    const second = await customer();
    for (let i = 0; i < 3; i++) await started(await stream('/store/v1/me/stream', first.headers));
    const older = await started(await stream('/store/v1/me/stream', second.headers));
    const refused = await stream('/store/v1/me/stream', second.headers);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(metricValue(await metrics(), 'realtime_connections_refused_total', { reason: 'ip_cap' })).toBe(1);
    expect(older.isEnded).toBe(false);
    expect(hubOf().size).toBe(4);
  });

  it('sends hb every 15 seconds', async () => {
    const s = await started(await stream('/store/v1/me/stream', (await customer()).headers));
    const before = Math.floor(clock.nowMs() / 1000);
    timers.advance(15 * SECOND);
    const hb = await s.next();
    expect(hb.event).toBe('hb');
    expect(hb.data).toBeGreaterThanOrEqual(before);
    expect(hb.data).toBeLessThanOrEqual(before + 15);
    timers.advance(15 * SECOND);
    expect((await s.next()).event).toBe('hb');
  });

  it('ends a stream at its maximum age with bye max_age (plus its jitter), not before', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0);
    let s: TestStream;
    try {
      s = await started(await stream('/store/v1/me/stream', (await customer()).headers));
    } finally {
      random.mockRestore();
    }
    expect(s.retryMs).toBe(2000);
    timers.advance(59 * SECOND);
    await eventually(() => (s.frames.filter((frame) => frame.event === 'hb').length >= 3 ? true : undefined));
    expect(s.isEnded).toBe(false);
    timers.advance(16 * SECOND);
    expect(await s.next('bye')).toMatchObject({ data: { reason: 'max_age' } });
    await s.ended;
    expect(metricValue(await metrics(), 'realtime_connections_closed_total', { reason: 'max_age' })).toBeGreaterThan(0);
  });
});

describe('session doorbells', () => {
  it('a sign-out ends the stream of that session with bye session_ended', async () => {
    const viewer = await customer();
    const s = await started(await stream('/store/v1/me/stream', viewer.headers));
    const out = await t.app.inject({ method: 'POST', url: '/store/v1/auth/logout', headers: viewer.mutation });
    expect(out.statusCode).toBe(204);
    expect(await s.next('bye')).toMatchObject({ data: { reason: 'session_ended' } });
    await s.ended;
  });

  it('revokeAllOf ends the streams of every session of the account', async () => {
    const one = await customer();
    const two = await customer(t, one.id);
    const a = await started(await stream('/store/v1/me/stream', one.headers));
    const b = await started(await stream('/store/v1/me/stream', two.headers));
    expect(await t.app.get(SessionService).revokeAllOf('account', one.id)).toBe(2);
    for (const s of [a, b]) {
      expect(await s.next('bye')).toMatchObject({ data: { reason: 'session_ended' } });
      await s.ended;
    }
  });

  it("a block of a retail account ends the account's streams, and the reconnect is refused", async () => {
    const viewer = await customer();
    const s = await started(await stream('/store/v1/me/stream', viewer.headers));
    const staff = await adminWith(t, ['clients:block']);
    const blocked = await staff.post(`/admin/clients/${viewer.id}/block`, { blocked: true, reason: 'Other' });
    expect(blocked.status).toBe(204);
    expect(await s.next('bye')).toMatchObject({ data: { reason: 'session_ended' } });
    await s.ended;
    expect((await stream('/store/v1/me/stream', viewer.headers)).status).toBe(401);
  });

  it('a role change ends the staff stream with bye reauth, and the reconnect gets in with the new role', async () => {
    const { db } = await testDb();
    const roleId = await insertRole(db, ['orders:read']);
    const otherRole = await insertRole(db, ['orders:read', 'clients:read']);
    const staffId = await insertStaff(db, roleId);
    const session = await openSession(t, { type: 'staff', id: staffId });
    const headers = { ...SAME_ORIGIN, ...session.headers };
    const s = await started(await stream('/admin/stream', headers));
    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/staff/${staffId}`, { roleId: otherRole })).status).toBe(200);
    expect(await s.next('bye')).toMatchObject({ data: { reason: 'reauth' } });
    await s.ended;
    await started(await stream('/admin/stream', headers));
  });

  it('a change of the permissions of a role ends the streams of its members with bye reauth, and no other stream', async () => {
    const { db } = await testDb();
    const roleId = await insertRole(db, ['orders:read', 'support:read']);
    const otherRole = await insertRole(db, ['orders:read']);
    const members = [await insertStaff(db, roleId), await insertStaff(db, roleId)];
    const outsider = await insertStaff(db, otherRole);
    const open = [];
    for (const staffId of [...members, outsider]) {
      const session = await openSession(t, { type: 'staff', id: staffId });
      open.push(await started(await stream('/admin/stream', { ...SAME_ORIGIN, ...session.headers })));
    }
    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/roles/${roleId}`, { permissions: ['orders:read'] })).status).toBe(200);
    for (const s of open.slice(0, 2)) {
      expect(await s.next('bye')).toMatchObject({ data: { reason: 'reauth' } });
      await s.ended;
    }
    // Behind the members' bye frames: a barrier for the member of the other role, who got nothing.
    await t.app.get(RealtimePublisher).publish('inbox', 'recount', { types: ['staff'] });
    await open[2]!.next('unread.changed');
    expect(open[2]!.isEnded).toBe(false);
    expect(open[2]!.frames.some((frame) => frame.event === 'bye')).toBe(false);
  });

  it('a rename of a role, or the same permissions in another order, leaves the streams of its members open', async () => {
    const { db } = await testDb();
    const roleId = await insertRole(db, ['orders:read', 'support:read']);
    const staffId = await insertStaff(db, roleId);
    const session = await openSession(t, { type: 'staff', id: staffId });
    const s = await started(await stream('/admin/stream', { ...SAME_ORIGIN, ...session.headers }));
    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/roles/${roleId}`, { name: 'Renamed' })).status).toBe(200);
    expect((await owner.patch(`/admin/roles/${roleId}`, { permissions: ['support:read', 'orders:read'] })).status).toBe(
      200,
    );
    await t.app.get(RealtimePublisher).publish('inbox', 'recount', { types: ['staff'] });
    await s.next('unread.changed');
    expect(s.isEnded).toBe(false);
    expect(s.frames.some((frame) => frame.event === 'bye')).toBe(false);
  });
});

describe('the logs and metrics of a stream', () => {
  // nestjs-pino keeps one root logger per process (its level is the first app's), so these tests read the logger calls, not the
  // log sink: they hold whatever other test files ran before in the same process.
  /** Every structured line the hub (Nest Logger) and the access log (nestjs-pino Logger) wrote while `work` ran. */
  async function loggedDuring(
    work: () => Promise<void>,
  ): Promise<Array<{ level: string; line: Record<string, unknown> }>> {
    const calls: Array<{ level: string; line: Record<string, unknown> }> = [];
    const spies = (['log', 'debug', 'warn', 'error'] as const).flatMap((level) => [
      spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        if (typeof line === 'object' && line !== null) calls.push({ level, line: line as Record<string, unknown> });
      }),
      spyOn(PinoLogger.prototype, level).mockImplementation((line: unknown) => {
        if (typeof line === 'object' && line !== null) calls.push({ level, line: line as Record<string, unknown> });
      }),
    ]);
    try {
      await work();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return calls;
  }

  it('logs `stream opened` at debug and `stream closed` with ids only when the client hangs up', async () => {
    const closedBefore = metricValue(await metrics(), 'realtime_connections_closed_total', {
      surface: 'store',
      reason: 'client_closed',
    });
    const viewer = await customer();
    let requestId = '';
    const calls = await loggedDuring(async () => {
      const s = await started(await stream('/store/v1/me/stream?cursor=i424242', viewer.headers));
      requestId = s.headers['x-request-id']!;
      s.close();
      await eventually(() => (hubOf().size === 0 ? true : undefined));
    });
    const mine = calls.filter((call) => call.line['requestId'] === requestId);
    expect(mine.find((call) => call.line['msg'] === 'stream opened')).toMatchObject({ level: 'debug' });
    expect(mine.find((call) => call.line['msg'] === 'stream closed')).toMatchObject({
      level: 'log',
      line: {
        route: '/store/v1/me/stream',
        viewer: `account:${viewer.id}`,
        sessionId: viewer.sessionId,
        reason: 'client_closed',
        frames: 2,
      },
    });
    // Never a cookie, a token or the cursor of the query, in any line.
    const text = JSON.stringify([calls, logSink.lines]);
    expect(text).not.toContain(viewer.token);
    expect(text).not.toContain('i424242');
    expect(
      metricValue(await metrics(), 'realtime_connections_closed_total', { surface: 'store', reason: 'client_closed' }),
    ).toBe(closedBefore + 1);
  });

  it('logs the access line of a stream the server ended at debug and leaves it out of the request histogram', async () => {
    const viewer = await customer();
    let requestId = '';
    const calls = await loggedDuring(async () => {
      const s = await started(await stream('/store/v1/me/stream', viewer.headers));
      requestId = s.headers['x-request-id']!;
      await t.app.get(SessionService).revoke(viewer.sessionId);
      await s.ended;
      await eventually(() => (hubOf().size === 0 ? true : undefined));
    });
    const access = calls.filter(
      (call) => call.line['requestId'] === requestId && call.line['msg'] === 'request completed',
    );
    expect(access).toEqual([
      { level: 'debug', line: expect.objectContaining({ status: 200, route: '/store/v1/me/stream' }) as never },
    ]);
    const scrape = await metrics();
    expect(
      metricValue(scrape, 'http_request_duration_seconds_count', { route: '/store/v1/me/stream', status: '200' }),
    ).toBe(0);
    expect(metricValue(scrape, 'realtime_connections_opened_total', { surface: 'store' })).toBeGreaterThan(0);
    expect(metricValue(scrape, 'realtime_events_sent_total', { event: 'bye' })).toBeGreaterThan(0);
  });

  it('documents the three routes as text/event-stream in OpenAPI', () => {
    const paths = buildOpenApiDocuments(t.app).internal.paths as Record<string, Record<string, unknown>>;
    for (const path of ['/admin/stream', '/client/stream', '/store/v1/me/stream']) {
      const get = paths[path]?.['get'] as { responses: Record<string, { content?: Record<string, unknown> }> };
      expect(Object.keys(get.responses['200']!.content!), path).toEqual(['text/event-stream']);
    }
  });
});

describe('REALTIME_ENABLED=false', () => {
  it('answers every stream 503 UNAVAILABLE with Retry-After 30 (the clients keep polling)', async () => {
    const off = await createTestApp({ env: { REALTIME_ENABLED: 'false' } });
    try {
      const viewer = await customer(off);
      const res = await off.app.inject({ method: 'GET', url: '/store/v1/me/stream', headers: viewer.headers });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      expect(JSON.parse(res.body)).toMatchObject({ code: 'UNAVAILABLE' });
      expect(metricValue(await metrics(off), 'realtime_connections_refused_total', { reason: 'disabled' })).toBe(1);
    } finally {
      await off.close();
    }
  });
});

describe('a second app (system timers)', () => {
  let other: TestApp;
  let otherBase: string;
  let closed = false;
  /** A source whose every doorbell renders a 30 KB frame for one account: enough to fill a client that does not read. */
  const big: RealtimeSource = {
    topic: 'test-big',
    cursorKey: 'z',
    keysFor: () => [],
    head: () => Promise.resolve(0),
    replay: () => Promise.resolve([]),
    snapshot: () => Promise.resolve([]),
    resolve: (doorbell): Promise<Delivery[]> =>
      Promise.resolve([
        {
          keys: [`u:account:${String(doorbell['accountId'])}`],
          frame: { event: 'test.big', data: 'x'.repeat(30_000) },
        },
      ]),
  };

  beforeAll(async () => {
    other = await createTestApp({});
    other.app.get(RealtimeSources).register(big);
    otherBase = await listen(other);
    await eventually(() => (hubOf(other).listening ? true : undefined));
  });
  afterAll(async () => {
    if (!closed) await other.close();
  });

  it('drops a client that does not read once its backlog passes the buffer limit', async () => {
    await clearStreamLimits(other);
    const viewer = await customer(other);
    const s = await stream('/store/v1/me/stream', viewer.headers, otherBase);
    expect((await s.next()).event).toBe('ready');
    s.pause();
    const publisher = other.app.get(RealtimePublisher);
    // 300 frames of 30 KB: 9 MB, far more than the kernel buffers and the 256 KB the hub lets wait.
    for (let i = 0; i < 300 && hubOf(other).size > 0; i++)
      await publisher.publish('test-big', 'fill', { accountId: viewer.id });
    await eventually(() => (hubOf(other).size === 0 ? true : undefined), 15_000);
    const scrape = await metrics(other);
    expect(metricValue(scrape, 'realtime_drops_total', { reason: 'slow_consumer' })).toBe(1);
    expect(metricValue(scrape, 'realtime_connections_closed_total', { reason: 'slow_consumer' })).toBe(1);
  });

  it('sends bye shutdown to every stream and closes the app within 3 s with streams open', async () => {
    await clearStreamLimits(other);
    const a = await stream('/store/v1/me/stream', (await customer(other)).headers, otherBase);
    const c = await stream('/store/v1/me/stream', (await customer(other)).headers, otherBase);
    for (const s of [a, c]) expect((await s.next()).event).toBe('ready');
    const started = performance.now();
    await other.close();
    closed = true;
    expect(performance.now() - started).toBeLessThan(3000);
    for (const s of [a, c]) {
      expect(await s.next('bye')).toMatchObject({ data: { reason: 'shutdown' } });
      await s.ended;
    }
  });
});
