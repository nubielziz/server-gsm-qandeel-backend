// Integration tests of GET /metrics (decision 015, map "internal network or token"): the access rule, the exposition
// content and what the registry contains after real requests.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { contractRegistry } from '../../src/common/contract';
import { type TestApp, createTestApp } from '../support/app';
import { metricValue } from '../support/metrics';
import { TestController } from '../support/routes';

const TOKEN = 'metrics-token-0123456789';
let open: TestApp; // no METRICS_TOKEN: internal network only
let guarded: TestApp; // METRICS_TOKEN set: the token is required from everyone
beforeAll(async () => {
  open = await createTestApp({ controllers: [TestController] });
  guarded = await createTestApp({ controllers: [TestController], env: { METRICS_TOKEN: TOKEN } });
});
afterAll(async () => {
  await open.close();
  await guarded.close();
});

const scrape = (t: TestApp, options: { from?: string; headers?: Record<string, string> } = {}) =>
  t.app.inject({
    method: 'GET',
    url: '/metrics',
    headers: options.headers ?? {},
    remoteAddress: options.from ?? '127.0.0.1',
  });

describe('access without a token configured', () => {
  it('allows loopback and private addresses', async () => {
    for (const from of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.0.9',
      '169.254.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      const res = await scrape(open, { from });
      expect(res.statusCode, from).toBe(200);
    }
  });

  it('refuses public addresses with a 403 FORBIDDEN problem', async () => {
    for (const from of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '11.0.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      const res = await scrape(open, { from });
      expect(res.statusCode, from).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN', status: 403, requestId: res.headers['x-request-id'] });
      expect(res.body).not.toContain('process_cpu');
    }
  });

  it('refuses a request that went through a proxy, even from a private address', async () => {
    const proxied: Array<Record<string, string>> = [
      { 'x-forwarded-for': '8.8.8.8' },
      { forwarded: 'for=8.8.8.8' },
      { 'x-real-ip': '8.8.8.8' },
    ];
    for (const headers of proxied) {
      const res = await scrape(open, { headers });
      expect(res.statusCode).toBe(403);
    }
  });

  it('ignores a bearer token it was not configured with', async () => {
    const res = await scrape(open, { from: '8.8.8.8', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('access with METRICS_TOKEN configured', () => {
  it('requires the token from everyone, loopback included', async () => {
    expect((await scrape(guarded)).statusCode).toBe(403);
    expect((await scrape(guarded, { from: '10.0.0.1' })).statusCode).toBe(403);
  });

  it('refuses a wrong, partial or differently formed token', async () => {
    for (const authorization of [
      'Bearer wrong',
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      TOKEN,
      `Basic ${TOKEN}`,
      'Bearer',
      `Bearer  `,
    ]) {
      expect((await scrape(guarded, { headers: { authorization } })).statusCode, authorization).toBe(403);
    }
  });

  it('accepts the token from any address, with the scheme in any case', async () => {
    for (const authorization of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER ${TOKEN}`]) {
      const res = await scrape(guarded, { from: '203.0.113.7', headers: { authorization } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('accepts the token even behind a proxy', async () => {
    const res = await scrape(guarded, {
      from: '203.0.113.7',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not reveal the token in the refusal', async () => {
    const res = await scrape(guarded);
    expect(res.body).not.toContain(TOKEN);
    expect(res.json().detail).toContain('Bearer');
  });
});

describe('exposition', () => {
  it('is Prometheus text, uncached, with the request id', async () => {
    const res = await scrape(open);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('holds the default process metrics, request latency and error counters from real traffic', async () => {
    await open.app.inject({ method: 'GET', url: '/t/items/1' });
    await open.app.inject({ method: 'GET', url: '/t/rate-limited' });
    const text = (await scrape(open)).body;
    expect(text).toContain('# TYPE process_cpu_user_seconds_total counter');
    expect(text).toContain('# TYPE nodejs_eventloop_lag_seconds gauge');
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toContain('# TYPE api_errors_total counter');
    expect(
      metricValue(text, 'http_request_duration_seconds_count', { method: 'GET', route: '/t/items/:id', status: '200' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      metricValue(text, 'api_errors_total', { code: 'RATE_LIMITED', route: '/t/rate-limited', surface: 'system' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('labels latency with the route template, the method and the status only', async () => {
    const text = (await scrape(open)).body;
    const line = text.split('\n').find((candidate) => candidate.startsWith('http_request_duration_seconds_count{'));
    expect(line).toMatch(/^http_request_duration_seconds_count\{method="[A-Z]+",route="[^"]+",status="\d{3}"\} \d+$/);
  });

  it('is registered as a contract with a text/plain success', () => {
    const contract = contractRegistry.get('GET /metrics');
    expect(contract).toMatchObject({
      surface: 'system',
      access: 'internal-or-token',
      success: { status: 200, contentType: 'text/plain' },
      errors: ['FORBIDDEN'],
    });
  });

  it('keeps one registry per app, not a shared global one', async () => {
    const first = (await scrape(open)).body;
    const second = (await scrape(guarded, { headers: { authorization: `Bearer ${TOKEN}` } })).body;
    expect(metricValue(first, 'api_errors_total', { code: 'RATE_LIMITED' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(second, 'api_errors_total', { code: 'RATE_LIMITED' })).toBe(0);
  });
});
