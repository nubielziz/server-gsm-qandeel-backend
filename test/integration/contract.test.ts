// Integration tests of the contract layer over real HTTP (decision 008): validation 422 shape, parsed inputs, response
// stripping and violations, 204 and file answers, headers, list parsing with x-total-count.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { logSink } from '../support/log-sink';
import { type TestApp, createTestApp } from '../support/app';
import { TestController } from '../support/routes';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ controllers: [TestController] });
});
afterAll(async () => {
  await t.close();
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('success path', () => {
  it('parses path ids to numbers and strips fields the contract does not list', async () => {
    const res = await get('/t/items/42');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ id: 42, name: 'Item 42', price: '12.4900', createdAt: '2026-03-01T09:30:00.000Z' });
    expect(res.body).not.toContain('must-not-leak');
  });

  it('creates with the contract status (201) and returns the parsed body', async () => {
    const res = await post('/t/items', { name: 'Phone', price: '99.0000', ignored: 'extra' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 7, name: 'Phone', price: '99.0000' });
  });

  it('answers 204 with no body and no content type', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/t/items/5' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('keeps the declared media type of a file answer', async () => {
    const res = await get('/t/report');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toBe('id,name\n1,Item 1\n');
  });

  it('gives the handler parsed headers', async () => {
    const res = await post('/t/headers', undefined, { 'idempotency-key': 'abcdefgh-1' });
    expect(res.json()).toEqual({ key: 'abcdefgh-1' });
  });
});

describe('validation errors (422 VALIDATION_FAILED)', () => {
  it('answers problem+json with one errors[] item per issue and dotted field paths', async () => {
    const res = await post('/t/items', { name: '', price: '1.5', lines: [{ imei: '123' }, {}] });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const problem = res.json();
    expect(problem).toMatchObject({
      type: 'http://localhost:3000/errors/validation-failed',
      title: 'Some fields are not valid.',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: '4 fields are not valid.',
      requestId: res.headers['x-request-id'],
    });
    const fields = problem.errors.map((error: { field: string }) => error.field).sort();
    expect(fields).toEqual(['lines.0.imei', 'lines.1.imei', 'name', 'price']);
    for (const error of problem.errors) {
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
    }
    expect(problem.errors.find((e: { field: string }) => e.field === 'lines.0.imei').code).toBe('too_small');
    expect(problem.errors.find((e: { field: string }) => e.field === 'price').code).toBe('invalid_format');
  });

  it('names the body when the whole input is wrong', async () => {
    const res = await post('/t/items');
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual([expect.objectContaining({ field: 'body', code: 'invalid_type' })]);
  });

  it('validates path parameters', async () => {
    for (const id of ['abc', '0', '-5', '1.5', '99999999999999999999']) {
      const res = await get(`/t/items/${id}`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toEqual([expect.objectContaining({ field: 'id' })]);
    }
  });

  it('validates declared headers', async () => {
    const missing = await post('/t/headers');
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors).toEqual([expect.objectContaining({ field: 'idempotency-key' })]);
    const short = await post('/t/headers', undefined, { 'idempotency-key': 'short' });
    expect(short.statusCode).toBe(422);
  });

  it('answers 400 BAD_REQUEST, not 422, for malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/t/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });

  it('rejects a body that is not a JSON object', async () => {
    const res = await post('/t/any-body', [1, 2, 3]);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatchObject({ field: 'body' });
    const ok = await post('/t/any-body', { a: 1, b: { c: [null, 'x'] } });
    expect(ok.json()).toEqual({ keys: 2 });
  });
});

describe('response contract', () => {
  it('answers 500 RESPONSE_CONTRACT_VIOLATION and logs it with the request id when a handler breaks its contract', async () => {
    logSink.clear();
    const res = await get('/t/broken');
    expect(res.statusCode).toBe(500);
    const problem = res.json();
    expect(problem).toMatchObject({
      code: 'RESPONSE_CONTRACT_VIOLATION',
      status: 500,
      title: 'The server produced an unexpected response.',
    });
    expect(res.body).not.toContain('not-a-number');
    const errors = logSink.forRequest(res.headers['x-request-id'] as string).filter((line) => line.level >= 50);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors[0])).toContain('RESPONSE_CONTRACT_VIOLATION');
  });

  it('answers 500 when a list handler forgets { rows, total }', async () => {
    const res = await get('/t/broken-list');
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('RESPONSE_CONTRACT_VIOLATION');
  });
});

describe('list endpoints (simple-rest dialect)', () => {
  const echoed = async (url: string) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    return { res, parsed: JSON.parse(res.json()[0].name) };
  };

  it('answers an array and x-total-count, with the default page and sort', async () => {
    const { res, parsed } = await echoed('/t/items');
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.headers['x-total-count']).toBe('123');
    expect(parsed.range).toEqual({ start: 0, end: 25, limit: 25 });
    expect(parsed.sort).toEqual([{ field: 'createdAt', order: 'desc' }]);
  });

  it('parses range, sort, search, operators and repeated keys from a real query string', async () => {
    const { parsed } = await echoed(
      '/t/items?_start=10&_end=30&_sort=name,createdAt&_order=asc,desc&q=john+doe&status=active&status=suspended&name_ne=Bob&createdAt_gte=2026-03-01T00:00:00.000Z&role.id=3&open=true',
    );
    expect(parsed.range).toEqual({ start: 10, end: 30, limit: 20 });
    expect(parsed.sort).toEqual([
      { field: 'name', order: 'asc' },
      { field: 'createdAt', order: 'desc' },
    ]);
    expect(parsed.search).toEqual({ text: 'john doe', fields: ['name'] });
    expect(parsed.filters).toEqual([
      { field: 'status', op: 'eq', values: ['active', 'suspended'] },
      { field: 'name', op: 'ne', values: ['Bob'] },
      { field: 'createdAt', op: 'gte', values: ['2026-03-01T00:00:00.000Z'] },
      { field: 'role.id', op: 'eq', values: [3] },
    ]);
    expect(parsed.extra).toEqual({ open: true });
  });

  it('serves count-only calls cheaply (_start=0&_end=1)', async () => {
    const { res, parsed } = await echoed('/t/items?_start=0&_end=1&status=active');
    expect(res.headers['x-total-count']).toBe('123');
    expect(parsed.range.limit).toBe(1);
  });

  it('answers 422 naming the parameter for an unknown sort, filter, operator or value', async () => {
    const cases: Array<[string, string]> = [
      ['/t/items?_sort=passwordHash', '_sort'],
      ['/t/items?passwordHash=x', 'passwordHash'],
      ['/t/items?status_gte=active', 'status_gte'],
      ['/t/items?status=deleted', 'status'],
      ['/t/items?_start=0&_end=1001', '_end'],
      ['/t/items?_start=abc', '_start'],
      ['/t/items?open=maybe', 'open'],
    ];
    for (const [url, field] of cases) {
      const res = await get(url);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(res.json().errors.map((e: { field: string }) => e.field)).toContain(field);
    }
  });

  it('allows a page of exactly 1000 rows', async () => {
    const { parsed } = await echoed('/t/items?_start=0&_end=1000');
    expect(parsed.range.limit).toBe(1000);
  });
});
