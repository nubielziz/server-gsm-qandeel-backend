// Integration tests of the API traffic routes of System health (feature 9) against a fake Prometheus: the measures and series per
// surface, the slowest endpoints, the error groups, and 503 MONITORING_UNAVAILABLE without Prometheus (decision 015, B90, B91, B114).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb } from '../support/db';

const clock = new TestClock();
const queries: string[] = [];
let failing = false;

/** A Prometheus that answers what the routes ask for: one series per surface for `by (surface)`, one without labels otherwise. */
const prometheus = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    queries.push(query);
    if (failing) return new Response('down', { status: 500 });
    const surfaces = query.includes('surface=') ? [/surface="(\w+)"/.exec(query)![1]!] : ['v1', 'admin'];
    const grouped = query.includes('surface)') || query.includes(', surface') || query.includes('surface,');
    const number =
      (query.includes('rate5xx') ? 0 : 0) +
      (query.includes('histogram_quantile(0.95') ? 850 : query.includes('status=~"5..') ? 1 : 40);
    if (url.pathname === '/api/v1/query_range') {
      const start = Number(url.searchParams.get('start'));
      const step = Number(url.searchParams.get('step'));
      if (query.includes('api_errors_total')) {
        const metric = { code: 'RATE_LIMITED', method: 'POST', route: '/v1/orders', status: '429', surface: 'v1' };
        return Response.json({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric,
                values: [
                  [start + step * 2, '3'],
                  [start + step * 5, '4'],
                ],
              },
            ],
          },
        });
      }
      const result = (grouped ? surfaces : [undefined]).map((surface) => ({
        metric: surface ? { surface } : {},
        values: [
          [start, String(number)],
          [start + step, 'NaN'],
        ],
      }));
      return Response.json({ status: 'success', data: { resultType: 'matrix', result } });
    }
    if (query.startsWith('topk(10')) {
      return Response.json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { method: 'GET', route: '/admin/orders', surface: 'admin' }, value: [0, '412.4'] },
            { metric: { method: 'POST', route: '/v1/orders', surface: 'v1' }, value: [0, '990'] },
            { metric: { method: 'GET', route: '/v1/x', surface: 'v1' }, value: [0, 'NaN'] },
          ],
        },
      });
    }
    if (query.includes('sum by (method, route, surface) (rate(')) {
      return Response.json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { method: 'POST', route: '/v1/orders', surface: 'v1' }, value: [0, '12.345'] }],
        },
      });
    }
    if (query.includes('sum by (code, method, route, status, surface) (increase(api_errors_total')) {
      return Response.json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { code: 'RATE_LIMITED', method: 'POST', route: '/v1/orders', status: '429', surface: 'v1' },
              value: [0, '7.2'],
            },
            {
              metric: {
                code: 'MAINTENANCE',
                method: 'POST',
                route: '/store/v1/checkout-sessions',
                status: '503',
                surface: 'store',
              },
              value: [0, '40'],
            },
          ],
        },
      });
    }
    if (query.startsWith('sum (increase(api_errors_total'))
      return Response.json({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: {}, value: [0, '51'] }] },
      });
    if (query.startsWith('max(timestamp(up'))
      return Response.json({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: {}, value: [0, '1793000000'] }] },
      });
    const result = (grouped ? surfaces : [undefined]).map((surface) => ({
      metric: surface ? { surface } : {},
      value: [0, String(number)],
    }));
    return Response.json({ status: 'success', data: { resultType: 'vector', result } });
  },
});

let t: TestApp;
let bare: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { PROMETHEUS_URL: `http://user:secret@127.0.0.1:${prometheus.port}` } });
  bare = await createTestApp({ clock });
});
beforeEach(async () => {
  failing = false;
  queries.length = 0;
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await prometheus.stop(true);
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await bare.close();
  await closeTestDb();
});

describe('GET /admin/system/metrics', () => {
  it('needs system:read and validates range and surface', async () => {
    expect((await (await adminWith(t, ['dashboard:read'])).get('/admin/system/metrics')).status).toBe(403);
    const api = await adminWith(t, ['system:read']);
    const range = await api.get('/admin/system/metrics?range=30d');
    expect(range.status).toBe(422);
    expect(range.body.errors[0].field).toBe('range');
    const surface = await api.get('/admin/system/metrics?surface=nope');
    expect(surface.status).toBe(422);
    expect(surface.body.errors[0].field).toBe('surface');
  });

  it('answers measures with the server verdict and series with gaps for every listed surface', async () => {
    const api = await adminWith(t, ['system:read']);
    const { body, status } = await api.get('/admin/system/metrics?range=1h');
    expect(status).toBe(200);
    expect(body).toMatchObject({ range: '1h', bucketSeconds: 60 });
    expect(body.surfaces.map((row: { surface: string }) => row.surface)).toEqual([
      'v1',
      'dhru',
      'client',
      'store',
      'admin',
      'hooks',
    ]);
    expect(body.total).toMatchObject({ surface: 'total', label: 'All surfaces' });
    expect(body.total.p95).toMatchObject({
      value: 850,
      state: 'warn',
      unit: 'ms',
      warn: 800,
      crit: 1500,
      direction: 'above',
    });
    expect(body.total.requestsPerMin).toMatchObject({ value: 40, unit: 'per_min', state: 'ok' });
    const v1 = body.surfaces[0];
    expect(v1.label).toBe('REST v1');
    expect(v1.p95.value).toBe(850);
    expect(body.surfaces[1].p95).toMatchObject({ value: null, state: 'unknown' });
    expect(v1.series.p95).toHaveLength(60);
    expect(v1.series.p95[0].value).toBe(850);
    expect(v1.series.p95[1].value).toBeNull();
    expect(body.slowest.map((row: { path: string }) => row.path)).toEqual(['/v1/orders', '/admin/orders']);
    expect(body.slowest[0]).toMatchObject({ method: 'POST', surface: 'v1', requestsPerMin: 12.35 });
    expect(body.slowest[0].p95).toMatchObject({ value: 990, state: 'warn' });
    // Planned 503 MAINTENANCE answers are taken out of the 5xx rate.
    expect(queries.some((q) => q.includes('api_errors_total{code="MAINTENANCE"}'))).toBe(true);
  });

  it('scopes the whole answer to one surface', async () => {
    const api = await adminWith(t, ['system:read']);
    const { body } = await api.get('/admin/system/metrics?range=24h&surface=admin');
    expect(body.bucketSeconds).toBe(900);
    expect(body.surfaces).toHaveLength(1);
    expect(body.surfaces[0].surface).toBe('admin');
    expect(body.total.surface).toBe('admin');
    expect(body.total.series.requestsPerMin).toHaveLength(96);
    expect(queries.every((q) => !q.includes('http_request_duration_seconds') || q.includes('surface="admin"'))).toBe(
      true,
    );
  });

  it('answers 503 MONITORING_UNAVAILABLE when Prometheus fails or is not configured', async () => {
    const api = await adminWith(t, ['system:read']);
    failing = true;
    const down = await api.get('/admin/system/metrics');
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('MONITORING_UNAVAILABLE');
    const none = await (await adminWith(bare, ['system:read'])).get('/admin/system/metrics');
    expect(none.status).toBe(503);
    expect(none.body.detail).toContain('PROMETHEUS_URL');
  });
});

describe('GET /admin/system/errors', () => {
  it('lists the top groups by count with first and last seen, and the total', async () => {
    const api = await adminWith(t, ['system:read']);
    const { body, status } = await api.get('/admin/system/errors?range=1h');
    expect(status).toBe(200);
    expect(body.range).toBe('1h');
    expect(body.total).toBe(51);
    expect(body.groups.map((group: { code: string }) => group.code)).toEqual(['MAINTENANCE', 'RATE_LIMITED']);
    expect(body.groups[1]).toMatchObject({
      status: 429,
      method: 'POST',
      endpoint: '/v1/orders',
      surface: 'v1',
      count: 7,
      lastRequestId: null,
      sentryUrl: null,
    });
    expect(new Date(body.groups[1].firstSeenAt).getTime()).toBeLessThan(new Date(body.groups[1].lastSeenAt).getTime());
    expect((await api.get('/admin/system/errors?range=1h&surface=nope')).status).toBe(422);
    failing = true;
    expect((await api.get('/admin/system/errors')).status).toBe(503);
  });
});

describe('monitoring in GET /admin/system/health', () => {
  it('is available when Prometheus answers, with the last scrape time of the API target', async () => {
    const api = await adminWith(t, ['system:read']);
    const { body } = await api.get('/admin/system/health');
    expect(body.monitoring).toEqual({
      status: 'available',
      detail: null,
      lastScrapeAt: new Date(1_793_000_000_000).toISOString(),
    });
  });
});
