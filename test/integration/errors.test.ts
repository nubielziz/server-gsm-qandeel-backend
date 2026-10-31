// Integration tests of the error pipeline (decision 028): problem+json for AppError, unknown errors, unknown routes,
// malformed JSON, 413 and 415, Retry-After, error metrics, production-safe details and the surface formatter seam.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ErrorFormatterRegistry } from '../../src/common/errors';
import { MetricsService } from '../../src/infra/metrics';
import { PRODUCTION_ENV, type TestApp, createTestApp } from '../support/app';
import { logSink } from '../support/log-sink';
import { metricValue } from '../support/metrics';
import { TestController } from '../support/routes';

let dev: TestApp;
let prod: TestApp;
beforeAll(async () => {
  dev = await createTestApp({ controllers: [TestController], env: { BODY_LIMIT_BYTES: '2048' } });
  // PRODUCTION_ENV names hosts that do not exist. Without a database the IP rules cannot be read and the pipeline refuses
  // every request (503, on purpose), so these tests leave the database-backed pipeline stages out.
  prod = await createTestApp({ controllers: [TestController], env: PRODUCTION_ENV, withoutDatabase: true });
});
afterAll(async () => {
  await dev.close();
  await prod.close();
});

const get = (app: TestApp, url: string) => app.app.inject({ method: 'GET', url });

describe('AppError', () => {
  it('becomes problem+json with the catalog title, the detail and errors[]', async () => {
    const res = await get(dev, '/t/app-error');
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      type: 'http://localhost:3000/errors/validation-failed',
      title: 'Some fields are not valid.',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Two fields are not valid.',
      errors: [
        { field: 'email', code: 'invalid_format', message: 'Not an email' },
        { field: 'items.0.imei', code: 'too_small', message: 'Too short' },
      ],
      requestId: res.headers['x-request-id'],
    });
  });

  it('uses the configured errors base URL in type', async () => {
    const res = await get(prod, '/t/db-down');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      type: 'https://errors.gsm.example/database-unavailable',
      code: 'DATABASE_UNAVAILABLE',
      detail: 'The database is not accepting connections.',
    });
  });

  it('answers a domain conflict with its own status and field errors', async () => {
    const res = await dev.app.inject({ method: 'POST', url: '/t/items', payload: { name: 'taken', price: '1.0000' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'EMAIL_TAKEN',
      title: 'This email address is already in use.',
      errors: [{ field: 'name', code: 'taken' }],
    });
  });

  it('always sends Retry-After with a 429', async () => {
    const res = await get(dev, '/t/rate-limited');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json().code).toBe('RATE_LIMITED');
  });

  it('maps a Nest HttpException to the catalog without losing its message', async () => {
    const res = await get(dev, '/t/http-exception');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN', detail: 'You need the staff:read permission.' });
  });
});

describe('unexpected errors', () => {
  it('answers 500 INTERNAL_ERROR without leaking the message or stack in production', async () => {
    logSink.clear();
    const res = await get(prod, '/t/boom');
    expect(res.statusCode).toBe(500);
    const problem = res.json();
    expect(problem).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, title: 'Something went wrong on our side.' });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('at ');
    expect(problem.detail).toContain('request id');
    expect(Object.keys(problem).sort()).toEqual(['code', 'detail', 'requestId', 'status', 'title', 'type']);
  });

  it('logs the full error with the same request id', async () => {
    logSink.clear();
    const res = await get(prod, '/t/boom');
    const requestId = res.headers['x-request-id'] as string;
    const failure = logSink.forRequest(requestId).find((line) => line.msg === 'Request failed with a server error');
    expect(failure).toBeDefined();
    expect(failure?.level).toBe(50);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, method: 'GET', route: '/t/boom' });
    const err = failure?.err as { message: string; stack?: string; cause?: { message: string } };
    expect(JSON.stringify(err)).toContain('ECONNREFUSED');
    expect(JSON.stringify(err)).toContain('hunter2');
    expect(JSON.stringify(err)).toContain('stack');
  });

  it('shows the message (never the stack) outside production', async () => {
    const res = await get(dev, '/t/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toContain('ECONNREFUSED');
    expect(res.body).not.toContain('\\n    at ');
  });
});

describe('framework errors', () => {
  it('answers an unknown route with a problem+json 404 and a request id', async () => {
    const res = await get(dev, '/this/route/does/not/exist?token=abc');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBeTruthy();
    const problem = res.json();
    expect(problem).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      title: 'The requested item was not found.',
      detail: 'No endpoint matches this request.',
      requestId: res.headers['x-request-id'],
    });
    expect(res.body).not.toContain('token=abc');
  });

  it('answers an unknown method on a known path with a 404 problem too', async () => {
    const res = await dev.app.inject({ method: 'PUT', url: '/t/items/1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('answers 400 BAD_REQUEST for malformed JSON', async () => {
    const res = await dev.app.inject({
      method: 'POST',
      url: '/t/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', status: 400, requestId: res.headers['x-request-id'] });
  });

  it('answers 400 BAD_REQUEST for an empty body sent as JSON', async () => {
    const res = await dev.app.inject({
      method: 'POST',
      url: '/t/any-body',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('refuses a body that tries to poison prototypes, as a 400 problem', async () => {
    for (const payload of ['{"__proto__":{"admin":true},"a":1}', '{"constructor":{"prototype":{"x":1}}}']) {
      const res = await dev.app.inject({
        method: 'POST',
        url: '/t/any-body',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
  });

  it('answers 413 PAYLOAD_TOO_LARGE above the body limit', async () => {
    const res = await dev.app.inject({ method: 'POST', url: '/t/any-body', payload: { filler: 'x'.repeat(4096) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413, title: 'The request is too large.' });
  });

  it('answers 415 UNSUPPORTED_MEDIA_TYPE for a body type no parser handles', async () => {
    const res = await dev.app.inject({
      method: 'POST',
      url: '/t/any-body',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
  });

  it('answers a malformed URL as problem+json', async () => {
    const res = await dev.app.inject({ method: 'GET', url: '/t/items/%' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('metrics of failures', () => {
  const errorCount = async (labels: Record<string, string>) =>
    metricValue(await dev.app.get(MetricsService).render(), 'api_errors_total', labels);

  it('counts every problem answer by surface, method, route template, status and code', async () => {
    const rate = { surface: 'system', method: 'GET', route: '/t/rate-limited', status: '429', code: 'RATE_LIMITED' };
    const unknown = { surface: 'system', method: 'GET', route: 'unmatched', status: '404', code: 'NOT_FOUND' };
    const invalid = {
      surface: 'system',
      method: 'GET',
      route: '/t/items/:id',
      status: '422',
      code: 'VALIDATION_FAILED',
    };
    const before = [await errorCount(rate), await errorCount(unknown), await errorCount(invalid)];
    await get(dev, '/t/rate-limited');
    await get(dev, '/t/rate-limited');
    await get(dev, '/nowhere');
    await get(dev, '/t/items/abc');
    expect([await errorCount(rate), await errorCount(unknown), await errorCount(invalid)]).toEqual([
      before[0]! + 2,
      before[1]! + 1,
      before[2]! + 1,
    ]);
  });

  it('counts the admin surface by its prefix', async () => {
    const labels = { surface: 'admin', method: 'GET', route: 'unmatched', status: '404', code: 'NOT_FOUND' };
    const before = await errorCount(labels);
    await get(dev, '/admin/nope');
    expect(await errorCount(labels)).toBe(before + 1);
  });

  it('counts router-level failures too', async () => {
    const labels = { route: 'unmatched', status: '400', code: 'BAD_REQUEST' };
    const before = await errorCount(labels);
    await get(dev, '/t/items/%');
    expect(await errorCount(labels)).toBe(before + 1);
  });

  it('records http_request_duration_seconds by route template, never by raw path', async () => {
    const metrics = dev.app.get(MetricsService);
    await get(dev, '/t/items/123456');
    const text = await metrics.render();
    expect(
      metricValue(text, 'http_request_duration_seconds_count', { method: 'GET', route: '/t/items/:id', status: '200' }),
    ).toBeGreaterThan(0);
    expect(text.includes('123456')).toBe(false);
  });
});

describe('surface formatters (decisions 026, 028)', () => {
  it('answers every error of the Dhru surface in the Dhru envelope, with HTTP 200', async () => {
    // The route is not authenticated yet (the Dhru credentials guard is P2.5c), so the guard dispatcher refuses it.
    const refused = await dev.app.inject({ method: 'POST', url: '/api/index.php', payload: { action: 'accountinfo' } });
    expect(refused.statusCode).toBe(200);
    expect(refused.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(refused.headers['x-powered-by']).toBe('DHRU-FUSION');
    expect(refused.headers['dhru-fusion-api-version']).toBe('6.1');
    expect(refused.headers['x-request-id']).toBeTruthy();
    expect(refused.json()).toEqual({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' });
    // Any other failure on the surface uses the envelope too; the other surfaces keep problem+json.
    const missing = await dev.app.inject({ method: 'GET', url: '/api/index.php' });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().ERROR[0].MESSAGE).toBe('No endpoint matches this request.');
    expect((await get(dev, '/t/app-error')).json().code).toBe('VALIDATION_FAILED');
  });

  it('lets another surface register its own envelope in the seam', async () => {
    dev.app.get(ErrorFormatterRegistry).register({
      name: 'test-hooks',
      matches: ({ surface }) => surface === 'hooks',
      format: ({ error }) => ({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: { rejected: error.detail },
      }),
    });
    const res = await get(dev, '/webhooks/nowhere');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rejected: 'No endpoint matches this request.' });
    expect((await get(dev, '/nowhere')).json().code).toBe('NOT_FOUND');
  });

  it('refuses two formatters with the same name', () => {
    const registry = dev.app.get(ErrorFormatterRegistry);
    expect(() =>
      registry.register({
        name: 'dhru',
        matches: () => false,
        format: () => ({ status: 200, contentType: 'x', body: {} }),
      }),
    ).toThrow(/already registered/);
  });
});
