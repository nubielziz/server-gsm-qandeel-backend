// The `postgres` health indicator (decision 015, map B11): critical, registered by the database module, answers from the
// shared pool, and never stops the app from booting when Postgres is down.
import { afterAll, describe, expect, it } from 'bun:test';
import { HealthRegistry } from '../../src/infra/health';
import { type TestApp, createTestApp } from '../support/app';
import { migrateTestDb } from '../support/db';

const apps: TestApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

describe('GET /health with the database module', () => {
  it('reports postgres ok against the test database', async () => {
    await migrateTestDb();
    const t = await createTestApp();
    apps.push(t);
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
    const indicator = t.app
      .get(HealthRegistry)
      .list()
      .find((candidate) => candidate.name === 'postgres');
    expect(indicator?.critical).toBe(true);
  });

  it('boots with Postgres unreachable, then reports down (200) and 503 for load balancers', async () => {
    const t = await createTestApp({ env: { DATABASE_URL_TEST: 'postgres://gsm:gsm@127.0.0.1:1/gsm_test' } });
    apps.push(t);
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'down', checks: { postgres: 'down' } });
    const strict = await t.app.inject({ method: 'GET', url: '/health?strict=1' });
    expect(strict.statusCode).toBe(503);
    expect(res.body).not.toContain('127.0.0.1');
  });
});
