// Process-level tests: the real entry points run as child processes (decision 013 boot failure, decision 001 clean
// shutdown, decision 015 worker metrics). Bun reads tsconfig.json from the working directory, so they run from the repo
// root, and --no-env-file keeps a local .env file out of the child's environment.
// Child-process tests keep real time (decision 031): the processes under test have their own clocks, and the `Bun.sleep`
// races below are only the deadline that turns a hung child into a failure.
import { afterAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_ENV, createTestApp } from '../../support/app';
import { openSession } from '../../support/auth';
import { TEST_DATABASE_URL, testDb } from '../../support/db';
import { MetricsModule } from '@src/infra/metrics';
import { RedisModule, RedisService } from '@src/infra/redis';
import { createInfra } from '../../support/infra';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { testInstanceEnv } from '../../support/env';
import { makeCustomer } from '../../support/store';
import { SAME_ORIGIN, openStream } from '../../support/stream';

const ROOT = join(import.meta.dir, '../../..');
type Child = ReturnType<typeof Bun.spawn>;
const children: Child[] = [];
/** The worker children keep their BullMQ keys (the relay's tick scheduler) under this prefix, deleted at the end. */
const workerPrefix = testBullPrefix();
// A failed assertion must not leave a server running.
afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, workerPrefix);
  await cleaner.close();
}, 20_000);

/** What a worker child needs on the test instances: its own database and BullMQ prefix, and a free metrics port. */
const workerEnv = (port: number): Record<string, string> => ({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  WORKER_METRICS_PORT: String(port),
  DATABASE_URL_TEST: TEST_DATABASE_URL,
  BULL_PREFIX: workerPrefix,
});

function start(script: 'src/main.ts' | 'src/worker.ts', env: Record<string, string>): Child {
  const child = Bun.spawn([process.execPath, '--no-env-file', script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...testInstanceEnv(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

/** True when nothing answers at the URL any more (the connection is refused). */
async function refuses(url: string): Promise<boolean> {
  return fetch(url).then(
    () => false,
    () => true,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Waits for a child process to come up (decision 031: real waits, because the processes keep their own time).
 * The deadline is on the monotonic clock, so a stepped system clock cannot change it.
 */
async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // not up yet
    }
    if (performance.now() > deadline) throw new Error('timed out waiting for the process');
    await Bun.sleep(100);
  }
}

async function stop(child: Child, signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') {
  const started = performance.now();
  child.kill(signal);
  const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'timeout' as const)]);
  return { code, ms: performance.now() - started };
}

const text = (stream: ReadableStream<Uint8Array> | number | undefined | null) =>
  stream && typeof stream !== 'number' ? new Response(stream).text() : Promise.resolve('');

describe('configuration failure', () => {
  it('stops the API in production with the full list of missing settings and exit code 1', async () => {
    const child = start('src/main.ts', { NODE_ENV: 'production' });
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
    expect(code).toBe(1);
    const stderr = await text(child.stderr);
    expect(stderr).toContain('Invalid environment configuration');
    for (const name of [
      'DATABASE_URL',
      'REDIS_QUEUE_URL',
      'REDIS_CACHE_URL',
      'CSRF_SECRET',
      'TOKEN_PEPPER',
      'LOOKUP_HASH_KEY',
      'ENCRYPTION_KEYS',
      'ERRORS_BASE_URL',
      'PORTAL_BASE_URL',
      'CONSOLE_BASE_URL',
      'STORE_BASE_URL',
      'TURNSTILE_SECRET_KEY',
      'TRUST_PROXY',
      // Decision 049: openexchangerates is the production default and needs its key.
      'FX_API_KEY',
    ]) {
      expect(stderr).toContain(`${name}: is required in production`);
    }
    expect(await text(child.stdout)).not.toContain('API listening');
  });

  it('refuses CORS_ORIGINS in production and names the two settings that replace it (decision 045)', async () => {
    const child = start('src/main.ts', { ...PRODUCTION_ENV, CORS_ORIGINS: 'https://admin.gsm.example' });
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
    expect(code).toBe(1);
    const stderr = await text(child.stderr);
    expect(stderr).toContain('CORS_ORIGINS: is not read in production');
    expect(stderr).toContain('CONSOLE_ORIGINS');
    expect(stderr).toContain('SHOP_ORIGINS');
    expect(await text(child.stdout)).not.toContain('API listening');
  });

  it('stops the worker the same way', async () => {
    const child = start('src/worker.ts', { NODE_ENV: 'production' });
    expect(await child.exited).toBe(1);
    expect(await text(child.stderr)).toContain('DATABASE_URL: is required in production');
  });

  it('names a malformed setting in development', async () => {
    const child = start('src/main.ts', { NODE_ENV: 'development', PORT: 'abc', TRUST_PROXY: 'everyone' });
    expect(await child.exited).toBe(1);
    const stderr = await text(child.stderr);
    expect(stderr).toContain('PORT:');
    expect(stderr).toContain('TRUST_PROXY:');
  });

  it('does not print secrets when it refuses to start', async () => {
    const child = start('src/main.ts', {
      ...PRODUCTION_ENV,
      CSRF_SECRET: 'too-short-but-secret',
      ENCRYPTION_KEYS: 'k1:bm90LWEta2V5',
    });
    expect(await child.exited).toBe(1);
    const stderr = await text(child.stderr);
    expect(stderr).toContain('CSRF_SECRET');
    expect(stderr).not.toContain('too-short-but-secret');
    expect(stderr).not.toContain('bm90LWEta2V5');
  });
});

describe('API process', () => {
  it('boots, answers /health and an unknown route with problem+json, and stops cleanly on SIGTERM', async () => {
    const port = await freePort();
    const child = start('src/main.ts', {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL_TEST: TEST_DATABASE_URL,
    });
    const health = await eventually(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok ? res : undefined;
    });
    expect(health.status).toBe(200);
    // NODE_ENV=test points every dependency at its test instance (docker compose up -d): Postgres gsm_test, Redis
    // database 1 on both roles and the gsm-files-test bucket.
    expect(await health.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', redis_queue: 'ok', storage: 'ok' },
    });
    expect(health.headers.get('x-request-id')).toBeTruthy();

    const unknown = await fetch(`http://127.0.0.1:${port}/nope`, { headers: { 'x-request-id': 'boot-check' } });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');
    expect(unknown.headers.get('x-request-id')).toBe('boot-check');
    expect(await unknown.json()).toMatchObject({ code: 'NOT_FOUND', requestId: 'boot-check' });

    const { code, ms } = await stop(child);
    // Nest re-raises the signal after cleanup (decision 001): 143 = SIGTERM, 0 also counts as clean.
    expect([0, 143]).toContain(code as number);
    expect(ms).toBeLessThan(5000);
    expect(await refuses(`http://127.0.0.1:${port}/health`)).toBe(true);
  });

  it('logs a configuration warning for the deprecated CORS_ORIGINS at boot (decision 045)', async () => {
    const port = await freePort();
    const child = start('src/main.ts', {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL_TEST: TEST_DATABASE_URL,
      CORS_ORIGINS: 'http://localhost:5173',
    });
    await eventually(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok ? res : undefined;
    });
    expect([0, 143]).toContain((await stop(child)).code as number);
    const stdout = await text(child.stdout);
    expect(stdout).toContain('Configuration warning');
    expect(stdout).toContain('CORS_ORIGINS');
    expect(stdout).toContain('is deprecated and refused in production');
  });

  it('refuses to start when the port is taken, with a non-zero exit code', async () => {
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => blocker.once('listening', resolve));
    try {
      const child = start('src/main.ts', { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port) });
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
      expect(code).not.toBe(0);
      expect(code).not.toBe('timeout');
    } finally {
      blocker.close();
    }
  });
});

describe('worker process', () => {
  it('boots, serves its own /metrics and stops cleanly on SIGTERM', async () => {
    const port = await freePort();
    const child = start('src/worker.ts', workerEnv(port));
    const metrics = await eventually(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      return res.ok ? res : undefined;
    });
    expect(metrics.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = await metrics.text();
    expect(body).toContain('process_cpu_seconds_total');

    const other = await fetch(`http://127.0.0.1:${port}/health`);
    expect(other.status).toBe(404);
    expect(other.headers.get('content-type')).toContain('application/problem+json');
    expect(await other.json()).toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const { code, ms } = await stop(child);
    expect([0, 143]).toContain(code as number);
    expect(ms).toBeLessThan(5000);
    expect(await refuses(`http://127.0.0.1:${port}/metrics`)).toBe(true);
  });

  it('applies the same access rule as the API: the token when one is set', async () => {
    const port = await freePort();
    const child = start('src/worker.ts', { ...workerEnv(port), METRICS_TOKEN: 'worker-metrics-token-123' });
    const url = `http://127.0.0.1:${port}/metrics`;
    const refused = await eventually(async () => fetch(url));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'FORBIDDEN' });
    const allowed = await fetch(url, { headers: { authorization: 'Bearer worker-metrics-token-123' } });
    expect(allowed.status).toBe(200);
    expect((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status).toBe(403);
    expect((await stop(child, 'SIGINT')).code).not.toBe('timeout');
  });

  it('fails to start when its metrics port is taken', async () => {
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => blocker.once('listening', resolve));
    try {
      const child = start('src/worker.ts', workerEnv(port));
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
      expect(code).not.toBe(0);
      expect(code).not.toBe('timeout');
    } finally {
      blocker.close();
    }
  });
});

describe('request timeouts (decision 053)', () => {
  /** One API child with short bounds: headers 300 ms, the whole request 1 s (the stream heartbeat is 5 s, five times the request bound). */
  let booted: Promise<number> | undefined;
  const api = (): Promise<number> => {
    booted ??= (async () => {
      const port = await freePort();
      start('src/main.ts', {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL_TEST: TEST_DATABASE_URL,
        HTTP_HEADERS_TIMEOUT_MS: '300',
        HTTP_REQUEST_TIMEOUT_MS: '1000',
        REALTIME_HEARTBEAT_SECONDS: '5',
      });
      await eventually(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.ok ? port : undefined;
      });
      return port;
    })();
    return booted;
  };

  /** How a raw connection ended: closed by the server (with what it had said), or still open at the deadline. */
  interface Ending {
    readonly closed: boolean;
    readonly said: string;
    readonly ms: number;
  }

  /** Opens a raw socket, writes the parts (none: stays silent), and waits for the server to close it, at most `deadlineMs`. */
  async function connection(port: number, parts: readonly string[], deadlineMs: number): Promise<Ending> {
    const started = performance.now();
    return new Promise<Ending>((resolve) => {
      let said = '';
      const socket = net.connect(port, '127.0.0.1', () => {
        for (const part of parts) socket.write(part);
      });
      const done = (closed: boolean) => {
        clearTimeout(deadline);
        socket.destroy();
        resolve({ closed, said, ms: performance.now() - started });
      };
      const deadline = setTimeout(() => done(false), deadlineMs);
      socket.on('data', (chunk) => {
        said += chunk.toString('latin1');
      });
      socket.on('close', () => done(true));
      socket.on('error', () => done(true));
    });
  }

  it('closes a connection whose headers do not arrive in time', async () => {
    const port = await api();
    // Half a request line, then nothing.
    const ending = await connection(port, ['GET /hea'], 3000);
    expect(ending.closed, `still open after ${ending.ms} ms`).toBe(true);
    // Closed, or answered 408 before it was closed.
    if (ending.said !== '') expect(ending.said).toContain(' 408 ');
  }, 20_000);

  it('closes a request whose body stalls', async () => {
    const port = await api();
    const head =
      'POST /health HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n';
    // The headers arrive in time; 10 of the 100 body bytes follow and then nothing.
    const ending = await connection(port, [head, '{"abc":"de'], 3000);
    expect(ending.closed, `still open after ${ending.ms} ms`).toBe(true);
    if (ending.said !== '') expect(ending.said).toContain(' 408 ');
  }, 20_000);

  it('closes a connection that stays silent', async () => {
    const port = await api();
    const ending = await connection(port, [], 15_000);
    // Nothing was sent, so the headers bound (300 ms) closes it, well inside the deadline.
    expect(ending.closed, `still open after ${ending.ms} ms`).toBe(true);
    if (ending.said !== '') expect(ending.said).toContain(' 408 ');
  }, 30_000);

  it('a request in time still answers', async () => {
    const port = await api();
    const request = 'GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n';
    const ending = await connection(port, [request], 5000);
    expect(ending.said).toContain(' 200 ');
    expect(ending.said).toContain('"status"');
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  }, 20_000);

  it('keeps a live stream open past both bounds: its request ends with the headers and it only writes', async () => {
    const port = await api();
    // The child reads the same test database: a customer and a session made here are the child's too.
    await testDb();
    const issuer = await createTestApp();
    let viewer: Awaited<ReturnType<typeof openStream>> | undefined;
    try {
      const customer = await makeCustomer(issuer);
      const session = await openSession(issuer, { type: 'customer', id: customer.id });
      viewer = await openStream(`http://127.0.0.1:${port}/store/v1/me/stream`, { ...SAME_ORIGIN, ...session.headers });
      expect(viewer.status).toBe(200);
      expect((await viewer.next('ready')).event).toBe('ready');
      // A heartbeat comes every 5 s, so the second one proves the stream lived at least 5 s after the first: five times the request
      // bound (1 s) and sixteen times the headers bound (0.3 s). The browser sends nothing after its request, so a bound on the silence
      // of the connection (Bun resets it only on bytes that come in) would have closed the stream before it.
      const first = await viewer.next('hb', 12_000);
      const started = performance.now();
      const second = await viewer.next('hb', 12_000);
      expect([first.event, second.event]).toEqual(['hb', 'hb']);
      expect(performance.now() - started).toBeGreaterThan(3000);
      expect(viewer.isEnded).toBe(false);
    } finally {
      viewer?.close();
      await issuer.close();
    }
  }, 40_000);
});
