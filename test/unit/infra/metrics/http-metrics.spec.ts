// Unit tests of the request-duration hook (decision 015): what it records, and that a live event stream (decision 037) is skipped.
import { describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { isEventStream, registerHttpMetrics } from '@src/infra/metrics/http-metrics';
import { MetricsService } from '@src/infra/metrics/metrics.service';

type Hook = (request: unknown, reply: unknown, done: () => void) => void;

/** A Fastify stand-in that keeps the onResponse hook, and a request/reply pair to call it with. */
function harness() {
  let hook: Hook | undefined;
  const fastify = { addHook: (_name: string, fn: Hook) => (hook = fn) } as unknown as FastifyInstance;
  const metrics = new MetricsService();
  registerHttpMetrics(fastify, metrics);
  const finish = (route: string, contentType: string, status = 200) =>
    new Promise<void>((resolve) =>
      hook!(
        { routeOptions: { url: route }, url: route, method: 'GET' },
        { statusCode: status, elapsedTime: 900_000, getHeader: () => contentType },
        resolve,
      ),
    );
  return { metrics, finish };
}

describe('isEventStream', () => {
  it('knows text/event-stream with or without parameters, and nothing else', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(isEventStream('application/json')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
    expect(isEventStream(['text/event-stream'])).toBe(false);
  });
});

describe('registerHttpMetrics', () => {
  it('observes an ordinary request and a refused stream, but never a stream that ran', async () => {
    const { metrics, finish } = harness();
    await finish('/admin/orders', 'application/json');
    await finish('/store/v1/me/stream', 'text/event-stream; charset=utf-8');
    await finish('/store/v1/me/stream', 'application/problem+json', 429);
    const text = await metrics.render();
    expect(text).toContain(
      'http_request_duration_seconds_count{surface="admin",method="GET",route="/admin/orders",status="200"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{surface="store",method="GET",route="/store/v1/me/stream",status="429"} 1',
    );
    expect(text).not.toContain('route="/store/v1/me/stream",status="200"');
    metrics.onApplicationShutdown();
  });
});
