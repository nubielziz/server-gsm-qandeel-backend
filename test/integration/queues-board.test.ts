// Integration test of the Bull Board page `GET /admin/queues` (feature 9, P2.4b notes: test it under Bun): the staff gate, the HTML page,
// its read API over the real queue Redis, and the refusal of every write.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { QUEUE_NAMES } from '../../src/infra/queues';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb } from '../support/db';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { RedisService } from '../../src/infra/redis';

const prefix = testBullPrefix();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { BULL_PREFIX: prefix } });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('GET /admin/queues', () => {
  it('answers 401 without a session and 403 without queues:read, as problem+json', async () => {
    const none = await t.app.inject({ method: 'GET', url: '/admin/queues' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(none.body).code).toBe('UNAUTHORIZED');

    const api = await adminWith(t, ['system:read']);
    const refused = await t.app.inject({ method: 'GET', url: '/admin/queues', headers: api.session.headers });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe('FORBIDDEN');
    // The same gate covers the board's own read API and assets.
    const sub = await t.app.inject({ method: 'GET', url: '/admin/queues/api/queues', headers: api.session.headers });
    expect(sub.statusCode).toBe(403);
  });

  it('serves the board page to staff with queues:read', async () => {
    const api = await adminWith(t, ['queues:read']);
    const page = await t.app.inject({ method: 'GET', url: '/admin/queues', headers: api.session.headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('GSM queues');
  });

  it('lists every queue through the board API, read-only', async () => {
    const api = await adminWith(t, ['queues:read']);
    const list = await t.app.inject({ method: 'GET', url: '/admin/queues/api/queues', headers: api.session.headers });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body) as { queues: Array<{ name: string; readOnlyMode: boolean }> };
    expect(body.queues.map((queue) => queue.name).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(body.queues.every((queue) => queue.readOnlyMode)).toBe(true);
  });

  it('refuses writes, even with the permission and a CSRF token', async () => {
    const api = await adminWith(t, ['queues:read', 'system:manage']);
    const write = await t.app.inject({
      method: 'PUT',
      url: '/admin/queues/api/queues/outbox-relay/clean/completed',
      headers: api.session.mutationHeaders,
    });
    expect(write.statusCode).toBe(403);
    expect(JSON.parse(write.body).code).toBe('FORBIDDEN');
  });
});
