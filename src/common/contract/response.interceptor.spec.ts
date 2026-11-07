// Unit tests of the redirect answer of shapeResponse (302 routes: the file downloads, MISMATCHES B154).
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineRoute } from './define-route';
import { type HeaderSink, shapeResponse } from './response.interceptor';

/** A reply that only remembers headers, like the part of Fastify's reply the interceptor uses. */
function sink(initial: Record<string, string> = {}): HeaderSink {
  const headers = new Map(Object.entries(initial));
  return {
    header: (name, value) => headers.set(name.toLowerCase(), value),
    getHeader: (name) => headers.get(name.toLowerCase()),
  };
}

const redirect = defineRoute({
  key: 'GET /spec/shape-redirect',
  summary: 'A redirect',
  tags: ['spec'],
  surface: 'system',
  access: 'public',
  success: { status: 302 },
  errors: [],
});

const body = defineRoute({
  key: 'GET /spec/shape-body',
  summary: 'A body',
  tags: ['spec'],
  surface: 'system',
  access: 'public',
  success: { status: 200, schema: z.object({ ok: z.boolean() }) },
  errors: [],
});

describe('shapeResponse for a 302 route', () => {
  it('sends no body when the handler set Location', () => {
    expect(shapeResponse(redirect, undefined, sink({ location: 'https://files.example/x?sig=1' }))).toBeUndefined();
  });

  it('is a server error when the handler forgot Location', () => {
    expect(() => shapeResponse(redirect, undefined, sink())).toThrow(/RESPONSE_CONTRACT_VIOLATION|unexpected response/);
  });

  it('leaves the other routes as they were', () => {
    expect(shapeResponse(body, { ok: true, extra: 1 }, sink())).toEqual({ ok: true });
  });
});
