// Process-level tests: the real entry points run as child processes (decision 013 boot failure, decision 001 clean
// shutdown, decision 015 worker metrics). Bun reads tsconfig.json from the working directory, so they run from the repo
// root, and --no-env-file keeps a local .env file out of the child's environment.
import { afterAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_ENV } from '../support/app';
import { TEST_DATABASE_URL } from '../support/db';

const ROOT = join(import.meta.dir, '../..');
type Child = ReturnType<typeof Bun.spawn>;
const children: Child[] = [];
// A failed assertion must not leave a server running.
afterAll(() => {
  for (const child of children) child.kill();
});

function start(script: 'src/main.ts' | 'src/worker.ts', env: Record<string, string>): Child {
  const child = Bun.spawn([process.execPath, '--no-env-file', script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...env },
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

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the process');
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
      'ENCRYPTION_KEYS',
      'ERRORS_BASE_URL',
    ]) {
      expect(stderr).toContain(`${name}: is required in production`);
    }
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
    // NODE_ENV=test points the database module at gsm_test (docker compose up -d): its indicator is the only check.
    expect(await health.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
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
    const child = start('src/worker.ts', { NODE_ENV: 'test', HOST: '127.0.0.1', WORKER_METRICS_PORT: String(port) });
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
    const child = start('src/worker.ts', {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      WORKER_METRICS_PORT: String(port),
      METRICS_TOKEN: 'worker-metrics-token-123',
    });
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
      const child = start('src/worker.ts', { NODE_ENV: 'test', HOST: '127.0.0.1', WORKER_METRICS_PORT: String(port) });
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
      expect(code).not.toBe(0);
      expect(code).not.toBe('timeout');
    } finally {
      blocker.close();
    }
  });
});
