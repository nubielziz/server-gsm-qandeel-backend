// The Prometheus client goes through the outbound HTTP helper (decision 051): it still reads a normal answer with its basic-auth header,
// follows no redirect and reads no more than 4 MiB. A local Bun server plays Prometheus.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PrometheusClient } from '@src/modules/health/application/prometheus.client';
import { type TestApp, createTestApp } from '../../support/app';
import { rejectionOf } from '../../support/rejection';

const hits: Array<{ path: string; authorization: string | null }> = [];
let mode: 'ok' | 'redirect' | 'large' = 'ok';

const vector = (extra = '') =>
  JSON.stringify({
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: { job: 'api', ...(extra ? { pad: extra } : {}) }, value: [0, '42'] }],
    },
  });

/** A Prometheus that answers a vector, redirects to the real address, or answers a body of 5 MiB. */
const prometheus = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    hits.push({ path: url.pathname, authorization: request.headers.get('authorization') });
    if (url.pathname.startsWith('/real'))
      return new Response(vector(), { headers: { 'content-type': 'application/json' } });
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: '/real/api/v1/query' } });
    if (mode === 'large') {
      return new Response(vector('x'.repeat(5 * 1024 * 1024)), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(vector(), { headers: { 'content-type': 'application/json' } });
  },
});

let t: TestApp;
let client: PrometheusClient;

beforeAll(async () => {
  t = await createTestApp({ env: { PROMETHEUS_URL: `http://user:secret@127.0.0.1:${prometheus.port}` } });
  client = t.app.get(PrometheusClient, { strict: false });
});
beforeEach(() => {
  mode = 'ok';
  hits.length = 0;
});
afterAll(async () => {
  await prometheus.stop(true);
  await t.close();
});

describe('PrometheusClient', () => {
  it('reads a normal answer and sends the basic-auth header from the configured address', async () => {
    const rows = await client.query('up', new Date(0));
    expect(rows).toEqual([{ metric: { job: 'api' }, value: 42 }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
  });

  it('does not follow a redirect of Prometheus', async () => {
    mode = 'redirect';
    expect(await rejectionOf(client.query('up', new Date(0)))).toMatchObject({ code: 'MONITORING_UNAVAILABLE' });
    expect(hits.map((hit) => hit.path)).toEqual(['/api/v1/query']);
  });

  it('refuses an answer over 4 MiB', async () => {
    mode = 'large';
    expect(await rejectionOf(client.query('up', new Date(0)))).toMatchObject({ code: 'MONITORING_UNAVAILABLE' });
  });
});
