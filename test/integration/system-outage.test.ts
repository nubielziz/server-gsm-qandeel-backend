// Integration test of the database outage rule (resolution health-commissions-17) on the System health and dashboard reads: with Postgres
// unreachable, the reads that need rows answer `503 DATABASE_UNAVAILABLE` as problem+json without a hostname, and the pages that
// have a copy keep answering (`GET /admin/system/health` serves its last snapshot as an outage).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { parseEnv } from '../../src/config';
import { CacheKeys } from '../../src/infra/cache';
import { RedisService } from '../../src/infra/redis';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { CONSOLE_ORIGIN } from '../support/staff-console';
import { closeTestDb, resetDb } from '../support/db';

let t: TestApp;
let down: TestApp;
let staff: AdminApi;

/** A read of the console with the signed-in session, sent to the app whose Postgres is unreachable. */
const readDown = (url: string) =>
  down.app.inject({
    method: 'GET',
    url,
    headers: { ...staff.session.headers, origin: CONSOLE_ORIGIN },
    remoteAddress: staff.ip,
  });

/** Drops the cached System health snapshots (the short and the long copy) and the dashboard payload an earlier file may have cached for 15 s. */
async function clearSnapshots(): Promise<void> {
  const keys = t.app.get(CacheKeys, { strict: false });
  await t.app
    .get(RedisService, { strict: false })
    .cache.unlink(keys.healthSnapshot(), keys.healthSnapshot(true), keys.dashboard('all', 7));
}

beforeAll(async () => {
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['system:read', 'dashboard:read']);
  // An earlier test file may have left a snapshot behind: this file's "no copy yet" case needs none.
  await clearSnapshots();
  // One answer from the working app warms the session in the cache Redis, which the other app shares: a signed-in console stays
  // signed in during an outage (the session view is cached for a minute), so the routes themselves are what the test reaches.
  expect((await staff.get('/admin/system/queues')).status).toBe(200);
  const url = new URL(parseEnv({ NODE_ENV: 'test' }).database.testUrl);
  url.port = '1'; // nothing listens there
  down = await createTestApp({ env: { DATABASE_URL_TEST: url.toString() } });
});
afterAll(async () => {
  await down.close();
  await clearSnapshots();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('reads that need rows while Postgres is down', () => {
  for (const url of [
    '/admin/dashboard',
    '/admin/system/orders-health',
    '/admin/system/suppliers',
    '/admin/system/webhooks',
    '/admin/system/checks',
    '/admin/system/jobs',
  ]) {
    it(`answers 503 DATABASE_UNAVAILABLE for GET ${url}, without a hostname`, async () => {
      const res = await readDown(url);
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE', status: 503 });
      // The problem's `type` is a link to the error page (it names the API's own host); the detail must not name the database.
      expect(res.json().detail).not.toMatch(/localhost|127\.0\.0\.1|postgres:|ECONNREFUSED|:1\b/i);
    });
  }
});

describe('GET /admin/system/health during the outage', () => {
  it('has no copy yet, so it answers 503 DATABASE_UNAVAILABLE', async () => {
    const res = await readDown('/admin/system/health');
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('DATABASE_UNAVAILABLE');
  });

  it('serves the last snapshot as an outage once one exists', async () => {
    expect((await staff.get('/admin/system/health')).status).toBe(200);
    // The short copy would answer first: drop it so the outage path runs and falls back on the long one.
    await t.app
      .get(RedisService, { strict: false })
      .cache.unlink(t.app.get(CacheKeys, { strict: false }).healthSnapshot());
    const res = await readDown('/admin/system/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'outage' });
  });
});
