// Integration test of the database outage rule (resolution health-commissions-17) on the reads of feature 12b: with Postgres unreachable the alert rule,
// alert and incident lists and the integrity report answer `503 DATABASE_UNAVAILABLE` as problem+json without a hostname, and the manual integrity
// run does too.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { parseEnv } from '../../src/config';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { CONSOLE_ORIGIN } from '../support/staff-console';
import { closeTestDb, resetDb } from '../support/db';

let t: TestApp;
let down: TestApp;
let staff: AdminApi;

/** A request of the console with the signed-in session, sent to the app whose Postgres is unreachable. */
const sendDown = (method: 'GET' | 'POST', url: string) =>
  down.app.inject({
    method,
    url,
    headers: { ...(method === 'GET' ? staff.session.headers : staff.session.mutationHeaders), origin: CONSOLE_ORIGIN },
    remoteAddress: staff.ip,
  });

const READS = [
  '/admin/alert-rules',
  '/admin/alert-rules/1',
  '/admin/alerts',
  '/admin/alerts/1',
  '/admin/incidents',
  '/admin/incidents/1',
  '/admin/system/integrity',
];

beforeAll(async () => {
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['alerts:read', 'incidents:read', 'system:read', 'system:manage']);
  // One answer from the working app warms the session in the cache Redis, which the other app shares: a signed-in console stays signed in during
  // an outage, so the routes themselves are what the test reaches.
  expect((await staff.get('/admin/alerts')).status).toBe(200);
  const url = new URL(parseEnv({ NODE_ENV: 'test' }).database.testUrl);
  url.port = '1'; // nothing listens there
  down = await createTestApp({ env: { DATABASE_URL_TEST: url.toString() } });
});
afterAll(async () => {
  await down.close();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('reads that need rows while Postgres is down', () => {
  for (const url of READS) {
    it(`answers 503 DATABASE_UNAVAILABLE for GET ${url}, without a hostname`, async () => {
      const res = await sendDown('GET', url);
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE', status: 503 });
      expect(res.json().detail).not.toMatch(/localhost|127\.0\.0\.1|postgres:|ECONNREFUSED|:1\b/i);
    });
  }

  it('answers 503 DATABASE_UNAVAILABLE for POST /admin/system/integrity/run', async () => {
    const res = await sendDown('POST', '/admin/system/integrity/run');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  });
});
