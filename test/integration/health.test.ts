// Integration tests of GET /health (decision 015, map B11): always 200 with {status, checks}; ?strict=1 answers 503
// with the same body; critical vs non-critical indicators; bounded time; nothing internal in the body.
import { afterAll, describe, expect, it } from 'bun:test';
import { HealthRegistry, type HealthIndicator } from '../../src/infra/health';
import { type TestApp, createTestApp } from '../support/app';
import { logSink } from '../support/log-sink';

const apps: TestApp[] = [];
/** A fresh app whose health registry has the given indicators. */
async function appWith(...indicators: HealthIndicator[]): Promise<TestApp> {
  const t = await createTestApp();
  apps.push(t);
  const registry = t.app.get(HealthRegistry);
  for (const indicator of indicators) registry.register(indicator);
  return t;
}
afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

const up = (name: string, critical: boolean): HealthIndicator => ({ name, critical, check: async () => undefined });
const down = (name: string, critical: boolean): HealthIndicator => ({
  name,
  critical,
  check: async () => {
    throw new Error(`${name} refused the connection at 10.0.0.5 with password hunter2`);
  },
});

describe('GET /health', () => {
  it('answers ok with no indicators registered', async () => {
    const t = await appWith();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ status: 'ok', checks: {} });
  });

  it('answers ok when every indicator is up', async () => {
    const t = await appWith(up('postgres', true), up('redis', false), up('redis_queue', false));
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok', redis_queue: 'ok' } });
  });

  it('answers degraded (still 200) when only a non-critical indicator is down', async () => {
    const t = await appWith(up('postgres', true), down('redis', false));
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'degraded', checks: { postgres: 'ok', redis: 'down' } });
  });

  it('answers down (still 200) when a critical indicator is down, even if a non-critical one is too', async () => {
    const t = await appWith(down('postgres', true), down('redis', false));
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'down', checks: { postgres: 'down', redis: 'down' } });
  });

  it('never reveals versions, hostnames, addresses or error texts', async () => {
    logSink.clear();
    const t = await appWith(down('postgres', true));
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(Object.keys(res.json()).sort()).toEqual(['checks', 'status']);
    for (const leak of ['10.0.0.5', 'hunter2', 'refused', 'Error', 'version']) expect(res.body).not.toContain(leak);
    // The reason is logged for operators.
    const warning = logSink.lines.find((line) => line.msg === 'Health indicator is down');
    expect(warning).toMatchObject({ indicator: 'postgres', critical: true });
    expect(JSON.stringify(warning)).toContain('refused the connection');
  });

  it('counts a false result and a hung indicator as down, and still answers in about two seconds', async () => {
    const t = await appWith(
      { name: 'flag', critical: false, check: async () => false },
      { name: 'hung', critical: true, check: () => new Promise<void>(() => undefined) },
    );
    const started = performance.now();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    const elapsed = performance.now() - started;
    expect(res.json()).toEqual({ status: 'down', checks: { flag: 'down', hung: 'down' } });
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(4000);
  });

  it('runs the indicators in parallel', async () => {
    const slow = (name: string): HealthIndicator => ({
      name,
      critical: false,
      check: () => new Promise<void>((resolve) => setTimeout(resolve, 300)),
    });
    const t = await appWith(slow('a'), slow('b'), slow('c'));
    const started = performance.now();
    await t.app.inject({ method: 'GET', url: '/health' });
    expect(performance.now() - started).toBeLessThan(800);
  });
});

describe('GET /health?strict=1 (load balancers)', () => {
  it('answers 200 when everything is ok', async () => {
    const t = await appWith(up('postgres', true));
    const res = await t.app.inject({ method: 'GET', url: '/health?strict=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });

  it('answers 503 with the same body when degraded', async () => {
    const t = await appWith(up('postgres', true), down('redis', false));
    const plain = await t.app.inject({ method: 'GET', url: '/health' });
    const strict = await t.app.inject({ method: 'GET', url: '/health?strict=1' });
    expect(strict.statusCode).toBe(503);
    expect(strict.json()).toEqual(plain.json());
    expect(strict.headers['content-type']).toContain('application/json');
    expect(strict.headers['content-type']).not.toContain('problem');
    expect(strict.headers['x-request-id']).toBeTruthy();
  });

  it('answers 503 with the same body when down', async () => {
    const t = await appWith(down('postgres', true));
    const strict = await t.app.inject({ method: 'GET', url: '/health?strict=true' });
    expect(strict.statusCode).toBe(503);
    expect(strict.json()).toEqual({ status: 'down', checks: { postgres: 'down' } });
  });

  it('treats strict=0 and strict=false as the normal check', async () => {
    const t = await appWith(down('postgres', true));
    for (const value of ['0', 'false']) {
      const res = await t.app.inject({ method: 'GET', url: `/health?strict=${value}` });
      expect(res.statusCode).toBe(200);
    }
  });

  it('refuses a value that is not a flag', async () => {
    const t = await appWith();
    const res = await t.app.inject({ method: 'GET', url: '/health?strict=maybe' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('strict');
  });

  it('does not count a strict 503 as an API error', async () => {
    const t = await appWith(down('postgres', true));
    await t.app.inject({ method: 'GET', url: '/health?strict=1' });
    const { MetricsService } = await import('../../src/infra/metrics');
    expect(await t.app.get(MetricsService).render()).not.toContain('api_errors_total{');
  });
});

describe('HealthRegistry', () => {
  it('refuses duplicate and badly named indicators at registration', async () => {
    const t = await appWith(up('postgres', true));
    const registry = t.app.get(HealthRegistry);
    expect(() => registry.register(up('postgres', true))).toThrow(/already registered/);
    for (const name of ['Postgres', 'redis-queue', '1db', '', 'a'.repeat(40)])
      expect(() => registry.register(up(name, false))).toThrow(/must match/);
    expect(registry.list().map((indicator) => indicator.name)).toEqual(['postgres']);
  });
});
