// Unit test of the raw-body tap on a bare Fastify instance: the bytes of a webhook request are kept as sent, other requests are
// untouched, and parsing and the body limit work as without the tap.
import { afterEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { rawBodyOf, registerRawBodyCapture } from './raw-body';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(bodyLimit = 1_000): Promise<FastifyInstance> {
  const fastify = Fastify({ bodyLimit });
  registerRawBodyCapture(fastify);
  const answer = (request: FastifyRequest) => ({
    parsed: request.body,
    raw: rawBodyOf(request)?.toString('utf8') ?? null,
  });
  fastify.post('/webhooks/payments/:gateway', answer);
  fastify.post('/admin/staff', answer);
  fastify.get('/webhooks/ping', (request) => ({ raw: rawBodyOf(request)?.toString('utf8') ?? null }));
  await fastify.ready();
  app = fastify;
  return fastify;
}

describe('registerRawBodyCapture', () => {
  it('keeps the exact bytes of a JSON webhook body, odd spacing included, and still parses it', async () => {
    const fastify = await build();
    const payload = '{ "id" : "evt_1",\n "amount":10.50 }';
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/payments/stripe',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parsed: { id: 'evt_1', amount: 10.5 }, raw: payload });
  });

  it('keeps the bytes of a body of any content type the app can parse, not only JSON', async () => {
    const fastify = await build();
    const payload = 'event=paid&id=abc%20def';
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/payments/wise',
      headers: { 'content-type': 'text/plain' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parsed: payload, raw: payload });
  });

  it('does not tap requests outside the webhook surface', async () => {
    const fastify = await build();
    const res = await fastify.inject({ method: 'POST', url: '/admin/staff', payload: { name: 'Rami' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parsed: { name: 'Rami' }, raw: null });
  });

  it('keeps nothing for a request without a body, and answers it as usual', async () => {
    const fastify = await build();
    const res = await fastify.inject({ method: 'GET', url: '/webhooks/ping' });
    expect(res.json()).toEqual({ raw: null });
  });

  it('keeps the body limit: an oversize webhook body is refused with 413', async () => {
    const fastify = await build(100);
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/payments/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filler: 'x'.repeat(500) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('keeps the usual answer to a malformed JSON body', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/payments/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('knows nothing about a request it never saw', () => {
    expect(rawBodyOf({})).toBeUndefined();
  });
});
