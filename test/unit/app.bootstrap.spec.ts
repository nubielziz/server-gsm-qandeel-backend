// Unit tests of the adapter's time bounds (decision 053, mirrors src/app.bootstrap.ts): the check interval and the options the adapter computes
// from the configuration. Nothing here listens on a port. The proof on real sockets that a response which only writes outlives both bounds is
// test/integration/infra/app-bootstrap.test.ts; the proof that the runtime enforces each bound is test/integration/infra/process.test.ts.
import { describe, expect, it } from 'bun:test';
import { createAppAdapter, timeoutCheckIntervalMs } from '@src/app.bootstrap';
import { parseEnv } from '@src/config';

describe('timeoutCheckIntervalMs', () => {
  it('is a quarter of the headers bound, from 100 ms to 5 s', () => {
    expect(timeoutCheckIntervalMs(300)).toBe(100);
    expect(timeoutCheckIntervalMs(100)).toBe(100);
    expect(timeoutCheckIntervalMs(4000)).toBe(1000);
    expect(timeoutCheckIntervalMs(20_000)).toBe(5000);
    expect(timeoutCheckIntervalMs(120_000)).toBe(5000);
  });
});

describe('createAppAdapter', () => {
  it('hands the bounds to the server', async () => {
    const config = parseEnv({ HTTP_HEADERS_TIMEOUT_MS: '4000', HTTP_REQUEST_TIMEOUT_MS: '45000' });
    const adapter = createAppAdapter(config);
    const fastify = adapter.getInstance();
    try {
      await fastify.ready();
      const server = fastify.server;
      expect(server.requestTimeout).toBe(45_000);
      expect(server.headersTimeout).toBe(4000);
      // No bound on the silence of a connection (`server.timeout`): Bun resets it only on bytes that come in, so it would cut a stream.
      expect(server.timeout).toBe(0);
    } finally {
      await fastify.close();
    }
  });

  it('uses the defaults when nothing is set', async () => {
    const adapter = createAppAdapter(parseEnv({}));
    const fastify = adapter.getInstance();
    try {
      await fastify.ready();
      expect(fastify.server.requestTimeout).toBe(600_000);
      expect(fastify.server.headersTimeout).toBe(20_000);
      expect(fastify.server.timeout).toBe(0);
    } finally {
      await fastify.close();
    }
  });
});
