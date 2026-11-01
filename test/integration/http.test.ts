// Integration tests of the outbound HTTP helper and OutboundHttp (decision 023) against a local server: the required
// timeout, no retries, no redirects, bounded responses, the public-host guard, the duration metric and the redacted log line.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { runWithRequestId } from '../../src/common/request-id';
import {
  HttpRequestError,
  type HttpRequestOptions,
  MAX_TIMEOUT_MS,
  OutboundHttp,
  OutboundHttpModule,
} from '../../src/infra/http';
// The bare helper is internal to src/infra/http (callers use OutboundHttp); the tests exercise it directly.
import { httpRequest } from '../../src/infra/http/http-request';
import { MetricsModule, MetricsService } from '../../src/infra/metrics';
import { PRODUCTION_ENV } from '../support/app';
import { type InfraHarness, createInfra, eventually, freePort } from '../support/infra';
import { metricValue } from '../support/metrics';
import { expectRejection, rejectionOf } from '../support/rejection';

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}
const seen: Seen[] = [];
/** Handlers of `/slow` and `/slow-body` wait here until the file ends (no timer): the clients under test give up first. */
let releaseSlow: () => void = () => undefined;
const release = new Promise<void>((resolve) => (releaseSlow = resolve));
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname, headers: request.headers, body: await request.text() });
      switch (url.pathname) {
        case '/ok':
          return Response.json({ hello: 'world' }, { headers: { 'x-custom': 'yes' } });
        case '/echo':
          return Response.json({
            method: request.method,
            contentType: request.headers.get('content-type'),
            requestId: request.headers.get('x-request-id'),
            body: seen.at(-1)?.body,
          });
        case '/slow':
          await release;
          return new Response('late');
        case '/slow-body':
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode('first part'));
                await release;
                controller.enqueue(new TextEncoder().encode('second part'));
                controller.close();
              },
            }),
          );
        case '/redirect':
          return new Response(null, { status: 302, headers: { location: '/ok' } });
        case '/redirect-metadata':
          return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
        case '/big':
          return new Response(new Uint8Array(3 * 1024 * 1024));
        case '/big-chunked':
          return new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 30; i++) controller.enqueue(new Uint8Array(100_000));
                controller.close();
              },
            }),
          );
        case '/binary':
          return new Response(Uint8Array.from([0, 255, 128, 10, 13]), {
            headers: { 'content-type': 'application/octet-stream' },
          });
        case '/not-json':
          return new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } });
        default: {
          const status = Number(/^\/status\/(\d{3})$/.exec(url.pathname)?.[1] ?? 404);
          return new Response(`status ${status}`, { status });
        }
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  releaseSlow();
  return server.stop(true);
});

const local = (extra: Partial<HttpRequestOptions> & { path?: string } = {}): HttpRequestOptions => ({
  url: `${base}${extra.path ?? '/ok'}`,
  timeoutMs: 3_000,
  allowPrivateNetwork: true,
  ...extra,
});
const requestsTo = (path: string) => seen.filter((entry) => entry.path === path);

describe('httpRequest', () => {
  it('returns status, headers and body; text() and json() read it', async () => {
    const result = await httpRequest(local());
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.headers.get('x-custom')).toBe('yes');
    expect(result.json()).toEqual({ hello: 'world' });
    expect(result.text()).toBe('{"hello":"world"}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the method, headers and body it was given', async () => {
    const result = await httpRequest(
      local({
        path: '/echo',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 'مرحبا' }),
      }),
    );
    expect(result.json()).toMatchObject({ method: 'POST', contentType: 'application/json', body: '{"n":"مرحبا"}' });
  });

  it('returns 4xx and 5xx answers instead of throwing: the caller decides what they mean', async () => {
    for (const status of [400, 404, 429, 500, 503]) {
      const result = await httpRequest(local({ path: `/status/${status}` }));
      expect(result.status).toBe(status);
      expect(result.ok).toBe(false);
      expect(result.text()).toBe(`status ${status}`);
    }
  });

  it('returns binary bodies byte for byte, and json() throws SyntaxError on a body that is not JSON', async () => {
    expect(Array.from((await httpRequest(local({ path: '/binary' }))).body)).toEqual([0, 255, 128, 10, 13]);
    await expectRejection(
      httpRequest(local({ path: '/not-json' })).then((result) => result.json()),
      SyntaxError,
    );
  });

  describe('timeout', () => {
    it('is required: a missing, zero, negative, fractional or oversize timeout is a programming error', async () => {
      for (const timeoutMs of [undefined, 0, -1, 1.5, Number.NaN, MAX_TIMEOUT_MS + 1]) {
        await expectRejection(
          httpRequest({ ...local(), timeoutMs: timeoutMs as never }),
          RangeError,
          String(timeoutMs),
        );
      }
    });

    // Real waits of 100-200 ms below (decision 031): the deadline of a request is a real timer, and that is the behaviour
    // under test; the elapsed time is measured on the monotonic clock.
    it('aborts a slow answer after timeoutMs with kind "timeout"', async () => {
      const started = performance.now();
      const error = await httpRequest(local({ path: '/slow', timeoutMs: 150 })).catch((e: unknown) => e);
      const elapsed = performance.now() - started;
      expect(error).toBeInstanceOf(HttpRequestError);
      expect((error as HttpRequestError).kind).toBe('timeout');
      expect(elapsed).toBeGreaterThanOrEqual(130);
      expect(elapsed).toBeLessThan(1_200);
    });

    it('covers reading the body too: headers that arrive in time but a body that does not', async () => {
      const started = performance.now();
      const error = await httpRequest(local({ path: '/slow-body', timeoutMs: 200 })).catch((e: unknown) => e);
      expect((error as HttpRequestError).kind).toBe('timeout');
      expect(performance.now() - started).toBeLessThan(1_200);
    });

    it('lets a fast answer through under a generous timeout', async () => {
      expect((await httpRequest(local({ timeoutMs: 120_000 }))).status).toBe(200);
    });
  });

  describe('no retries', () => {
    it('sends exactly one request when the server answers 500', async () => {
      const before = requestsTo('/status/500').length;
      await httpRequest(local({ path: '/status/500' }));
      expect(requestsTo('/status/500').length - before).toBe(1);
    });

    it('sends exactly one request when the connection is cut, and reports a network failure', async () => {
      let connections = 0;
      const cutter = net.createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => cutter.listen(0, '127.0.0.1', resolve));
      try {
        const port = (cutter.address() as net.AddressInfo).port;
        const error = await httpRequest({
          url: `http://127.0.0.1:${port}/x`,
          timeoutMs: 2_000,
          allowPrivateNetwork: true,
          method: 'POST',
          body: 'x',
        }).catch((e: unknown) => e);
        expect((error as HttpRequestError).kind).toBe('network');
        // A retry would come before a connection that is opened now: wait for this one to arrive, then count.
        const barrier = net.connect(port, '127.0.0.1');
        barrier.on('error', () => undefined);
        await eventually(() => (connections >= 2 ? true : undefined));
        barrier.destroy();
        expect(
          connections,
          'the request and the barrier only: no automatic retry of a possibly delivered request',
        ).toBe(2);
      } finally {
        await new Promise((resolve) => cutter.close(resolve));
      }
    });

    it('reports a refused connection as a network failure', async () => {
      const port = await freePort();
      const error = await httpRequest({
        url: `http://127.0.0.1:${port}/`,
        timeoutMs: 2_000,
        allowPrivateNetwork: true,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpRequestError);
      expect((error as HttpRequestError).kind).toBe('network');
      expect((error as HttpRequestError).message).not.toContain(String(port));
    });
  });

  describe('redirects', () => {
    it('are not followed: the 3xx answer is returned with its Location', async () => {
      const before = requestsTo('/ok').length;
      const result = await httpRequest(local({ path: '/redirect' }));
      expect(result.status).toBe(302);
      expect(result.ok).toBe(false);
      expect(result.headers.get('location')).toBe('/ok');
      expect(requestsTo('/ok').length, 'the target of the redirect was never requested').toBe(before);
    });

    it('cannot be used to reach the cloud metadata address', async () => {
      const result = await httpRequest(local({ path: '/redirect-metadata' }));
      expect(result.status).toBe(301);
      expect(result.headers.get('location')).toContain('169.254.169.254');
    });
  });

  describe('response size', () => {
    it('refuses a body over maxResponseBytes using Content-Length, without reading it', async () => {
      const error = await httpRequest(local({ path: '/big', maxResponseBytes: 1024 * 1024 })).catch((e: unknown) => e);
      expect((error as HttpRequestError).kind).toBe('too_large');
    });

    it('stops reading a streamed body that grows past the limit', async () => {
      const error = await httpRequest(local({ path: '/big-chunked', maxResponseBytes: 1024 * 1024 })).catch(
        (e: unknown) => e,
      );
      expect((error as HttpRequestError).kind).toBe('too_large');
    });

    it('does not count the Content-Length of an answer to HEAD, which has no body', async () => {
      const result = await httpRequest(local({ path: '/big', method: 'HEAD', maxResponseBytes: 1024 }));
      expect(result.status).toBe(200);
      expect(result.body.byteLength).toBe(0);
    });

    it('accepts a large body when the limit allows it', async () => {
      expect((await httpRequest(local({ path: '/big', maxResponseBytes: 4 * 1024 * 1024 }))).body.byteLength).toBe(
        3 * 1024 * 1024,
      );
    });
  });

  describe('public hosts only', () => {
    it('refuses a private host by default and never sends the request', async () => {
      const before = seen.length;
      for (const url of [
        `${base}/ok`,
        'http://127.0.0.1:1/',
        'http://localhost/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
      ]) {
        const error = await httpRequest({ url, timeoutMs: 1_000 }).catch((e: unknown) => e);
        expect(error, url).toBeInstanceOf(HttpRequestError);
        expect((error as HttpRequestError).kind, url).toBe('blocked');
      }
      expect(seen.length, 'the local server saw nothing').toBe(before);
    });

    it('reports a name that does not resolve as a network failure, not as a blocked address', async () => {
      const error = await rejectionOf(
        httpRequest({
          url: 'https://no-such-host.example/',
          timeoutMs: 1_000,
          lookup: () => Promise.reject(new Error('ENOTFOUND')),
        }),
      );
      expect((error as HttpRequestError).kind).toBe('network');
    });

    it('refuses a name that resolves to a private address (checked with the given resolver)', async () => {
      const error = await httpRequest({
        url: 'https://evil.example/hook',
        timeoutMs: 1_000,
        lookup: () => Promise.resolve(['10.0.0.5']),
      }).catch((e: unknown) => e);
      expect((error as HttpRequestError).kind).toBe('blocked');
    });

    it('lets the caller opt in for its own infrastructure and for tests', async () => {
      expect((await httpRequest(local())).status).toBe(200);
    });

    it('refuses plain http when httpsOnly is set, even for an opted-in host, and bad URLs', async () => {
      expect(((await httpRequest(local({ httpsOnly: true })).catch((e: unknown) => e)) as HttpRequestError).kind).toBe(
        'blocked',
      );
      for (const url of ['', 'not a url', 'ftp://example.com/', 'file:///etc/passwd']) {
        const error = await httpRequest({ url, timeoutMs: 1_000, allowPrivateNetwork: true }).catch((e: unknown) => e);
        expect((error as HttpRequestError).kind, url).toBe('blocked');
      }
    });

    it('does not put the URL, its query or credentials in the error', async () => {
      const error = (await httpRequest({
        url: 'https://user:topsecret@evil.example/bot1:TOKEN?key=abc',
        timeoutMs: 1_000,
        lookup: () => Promise.resolve(['10.0.0.5']),
      }).catch((e: unknown) => e)) as HttpRequestError;
      for (const leak of ['topsecret', 'TOKEN', 'key=abc']) expect(error.message).not.toContain(leak);
    });
  });

  it('can be cancelled by the caller (shutdown)', async () => {
    const controller = new AbortController();
    const request = httpRequest(local({ path: '/slow', timeoutMs: 5_000, signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    // Abort once the server has the request, not after a guessed delay.
    await eventually(() => (requestsTo('/slow').length > 0 ? true : undefined));
    controller.abort();
    const error = await request;
    expect((error as HttpRequestError).kind).toBe('aborted');
  });
});

describe('OutboundHttp', () => {
  let harness: InfraHarness;
  let http: OutboundHttp;
  beforeAll(async () => {
    harness = await createInfra({ modules: [MetricsModule, OutboundHttpModule] });
    http = harness.get(OutboundHttp);
  });
  afterAll(() => harness.close());

  const call = (extra: Partial<Parameters<OutboundHttp['request']>[0]> = {}) =>
    http.request({ url: `${base}/ok`, timeoutMs: 3_000, allowPrivateNetwork: true, target: 'supplier', ...extra });
  const scrape = async () => harness.get(MetricsService).render();

  it('records the duration by target, method and outcome', async () => {
    const before = metricValue(await scrape(), 'outbound_http_request_duration_seconds_count', {
      target: 'supplier',
      method: 'GET',
      outcome: '2xx',
    });
    await call();
    await call();
    const text = await scrape();
    expect(
      metricValue(text, 'outbound_http_request_duration_seconds_count', {
        target: 'supplier',
        method: 'GET',
        outcome: '2xx',
      }),
    ).toBe(before + 2);
    expect(
      metricValue(text, 'outbound_http_request_duration_seconds_sum', {
        target: 'supplier',
        method: 'GET',
        outcome: '2xx',
      }),
    ).toBeGreaterThan(0);
  });

  it('labels 4xx, 5xx, timeouts, network failures and blocked calls differently', async () => {
    await call({ url: `${base}/status/404` });
    await call({ url: `${base}/status/503`, target: 'gateway' });
    await call({ url: `${base}/slow`, timeoutMs: 100, target: 'merchant_webhook' }).catch(() => undefined);
    await call({ url: 'http://127.0.0.1:1/', timeoutMs: 500, target: 'merchant_webhook' }).catch(() => undefined);
    await call({ url: `${base}/ok`, allowPrivateNetwork: false, target: 'merchant_webhook' }).catch(() => undefined);
    const text = await scrape();
    const count = (labels: Record<string, string>) =>
      metricValue(text, 'outbound_http_request_duration_seconds_count', labels);
    expect(count({ target: 'supplier', outcome: '4xx' })).toBeGreaterThanOrEqual(1);
    expect(count({ target: 'gateway', outcome: '5xx' })).toBe(1);
    expect(count({ target: 'merchant_webhook', outcome: 'timeout' })).toBe(1);
    expect(count({ target: 'merchant_webhook', outcome: 'network' })).toBe(1);
    expect(count({ target: 'merchant_webhook', outcome: 'blocked' })).toBe(1);
  });

  it('forwards the request id so one id joins API, worker and supplier logs', async () => {
    const result = await runWithRequestId('req-7f3a', () => call({ url: `${base}/echo` }));
    expect(result.json<{ requestId: string }>().requestId).toBe('req-7f3a');
    // A header the caller sets wins; outside a request nothing is added.
    const explicit = await runWithRequestId('req-7f3a', () =>
      call({ url: `${base}/echo`, headers: { 'X-Request-Id': 'chosen' } }),
    );
    expect(explicit.json<{ requestId: string }>().requestId).toBe('chosen');
    expect((await call({ url: `${base}/echo` })).json<{ requestId: string | null }>().requestId).toBeNull();
  });

  it('logs one line per call with the host, status, duration and request id, and nothing secret', async () => {
    harness.logger.lines.length = 0;
    await runWithRequestId('req-log-1', () =>
      call({
        url: `${base}/status/404?apikey=SECRET-IN-QUERY`,
        headers: { authorization: 'Bearer SECRET-TOKEN' },
        method: 'POST',
        body: 'SECRET-BODY',
        operation: 'dhru.accountinfo',
      }),
    );
    const line = harness.logger.lines.find((entry) => entry.includes('Outbound HTTP'));
    expect(line).toBeDefined();
    const text = harness.logger.lines.join('\n');
    expect(line).toContain('"target":"supplier"');
    expect(line).toContain('"operation":"dhru.accountinfo"');
    expect(line).toContain(`"host":"127.0.0.1:${server.port}"`);
    expect(line).toContain('"status":404');
    expect(line).toContain('"outcome":"4xx"');
    expect(line).toContain('"requestId":"req-log-1"');
    expect(line).toMatch(/"durationMs":\d+/);
    for (const leak of ['SECRET-IN-QUERY', 'SECRET-TOKEN', 'SECRET-BODY', '/status/404', 'apikey'])
      expect(text).not.toContain(leak);
  });

  it('logs failures too, without the URL', async () => {
    harness.logger.lines.length = 0;
    await call({ url: `${base}/slow?token=SECRET-IN-QUERY`, timeoutMs: 100 }).catch(() => undefined);
    const text = harness.logger.lines.join('\n');
    expect(text).toContain('"outcome":"timeout"');
    expect(text).toContain('warn');
    expect(text).not.toContain('SECRET-IN-QUERY');
  });

  it('allows only https in production, unless the call targets the private network or opts out', async () => {
    const production = await createInfra({ modules: [MetricsModule, OutboundHttpModule], env: PRODUCTION_ENV });
    try {
      const outbound = production.get(OutboundHttp);
      const before = seen.length;
      // A public target (merchant webhook, supplier) over http is refused before any connection (decision 023).
      const publicHttp = await outbound
        .request({
          url: 'http://hooks.merchant.example/gsm',
          timeoutMs: 1_000,
          lookup: () => Promise.resolve(['93.184.216.34']),
          target: 'merchant_webhook',
        })
        .catch((e: unknown) => e);
      expect((publicHttp as HttpRequestError).kind).toBe('blocked');
      // An explicit httpsOnly wins even for a private-network call.
      const forced = await outbound
        .request({
          url: `${base}/ok`,
          timeoutMs: 1_000,
          allowPrivateNetwork: true,
          httpsOnly: true,
          target: 'supplier',
        })
        .catch((e: unknown) => e);
      expect((forced as HttpRequestError).kind).toBe('blocked');
      expect(seen.length).toBe(before);
      // An internal call on the private network (Prometheus) may use http.
      const internal = await outbound.request({
        url: `${base}/ok`,
        timeoutMs: 1_000,
        allowPrivateNetwork: true,
        target: 'prometheus',
      });
      expect(internal.status).toBe(200);
    } finally {
      await production.close();
    }
  });

  it('requires a timeout like the plain helper', async () => {
    await expectRejection(
      http.request({ url: `${base}/ok`, allowPrivateNetwork: true, target: 'supplier' } as never),
      RangeError,
    );
  });
});
