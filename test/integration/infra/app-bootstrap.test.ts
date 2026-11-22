// Integration test of the adapter's time bounds on real sockets (decision 053, src/app.bootstrap.ts): a response that only writes (a
// hijacked live stream, a streamed reply) runs to its end past both the headers bound and the request bound. It listens on a port and
// takes seconds, so it is not a unit test; the options the adapter computes are test/unit/app.bootstrap.spec.ts, and the proof that the
// runtime enforces each bound on a spawned server is process.test.ts.
import { describe, expect, it } from 'bun:test';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { createAppAdapter } from '@src/app.bootstrap';
import { parseEnv } from '@src/config';

describe('createAppAdapter on a real socket: the bounds do not cut a response that only writes', () => {
  const FRAMES = 15;
  const EVERY_MS = 200;

  /** Writes `FRAMES` frames, one every `EVERY_MS`, then `end`: the pattern of a live stream (nothing comes in after the request). */
  function framesEvery(write: (text: string) => void, finish: () => void): void {
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      write(`event: hb\ndata: {}\n\n`);
      if (sent === FRAMES) {
        clearInterval(timer);
        write('event: end\ndata: {}\n\n');
        finish();
      }
    }, EVERY_MS);
  }

  /** Sends one request on a raw socket (nothing else follows it) and reads until the server ends the response. */
  function read(port: number, path: string): Promise<{ text: string; ms: number }> {
    const started = performance.now();
    return new Promise((resolve) => {
      let text = '';
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`GET ${path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`);
      });
      const done = () => resolve({ text, ms: performance.now() - started });
      socket.on('data', (chunk) => (text += chunk.toString('latin1')));
      socket.on('close', done);
      socket.on('error', done);
    });
  }

  async function listening(): Promise<{ fastify: FastifyInstance; port: number }> {
    // The headers bound is 0.3 s and the request bound 1 s: both are over long before the 3 s the responses below last.
    const adapter = createAppAdapter(parseEnv({ HTTP_HEADERS_TIMEOUT_MS: '300', HTTP_REQUEST_TIMEOUT_MS: '1000' }));
    const fastify = adapter.getInstance();
    fastify.get('/hijacked', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      reply.raw.flushHeaders();
      framesEvery(
        (text) => reply.raw.write(text),
        () => reply.raw.end(),
      );
    });
    fastify.get('/streamed', (_request, reply) => {
      const stream = new Readable({ read() {} });
      void reply.header('content-type', 'text/event-stream').send(stream);
      framesEvery(
        (text) => stream.push(text),
        () => stream.push(null),
      );
    });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    return { fastify, port: (fastify.server.address() as net.AddressInfo).port };
  }

  it('lets a hijacked stream (the live streams) and a streamed reply run to their end, past both bounds', async () => {
    const { fastify, port } = await listening();
    try {
      const [hijacked, streamed] = await Promise.all([read(port, '/hijacked'), read(port, '/streamed')]);
      for (const [name, result] of [
        ['hijacked', hijacked],
        ['streamed', streamed],
      ] as const) {
        expect(result.text.split('event: hb').length - 1, name).toBe(FRAMES);
        expect(result.text, name).toContain('event: end');
        // The whole response took far longer than the request bound (1 s) and the headers bound (0.3 s).
        expect(result.ms, name).toBeGreaterThan(FRAMES * EVERY_MS * 0.8);
      }
    } finally {
      await fastify.close();
    }
  }, 20_000);
});
