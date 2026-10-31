// Tests of scripts/gen-openapi.ts (decision 009): it writes the two committed documents without any infrastructure
// (a provider that connects makes it fail), its output is stable, and `--check` fails when a committed file is missing
// or differs. It is a CLI, so it runs as a child process, like the real thing in CI.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '../..');
const COMMITTED = join(ROOT, 'docs', 'contract');
const FILES = ['openapi.json', 'openapi.public.json'] as const;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-openapi-'));
  dirs.push(dir);
  return dir;
}

/** Runs a script from the repo root (Bun reads tsconfig.json from there) with only the given environment. */
async function bun(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--no-env-file', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
const generate = (args: string[] = [], env: Record<string, string> = {}) =>
  bun(['scripts/gen-openapi.ts', ...args], env);

describe('the committed documents', () => {
  it('are up to date with the contracts (docs:openapi:check)', async () => {
    const result = await generate(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('docs/contract/openapi.json is up to date.');
    expect(result.stdout).toContain('docs/contract/openapi.public.json is up to date.');
  });

  it('are valid JSON with a trailing newline, OpenAPI 3.1, and the public one is a subset', async () => {
    const internal = JSON.parse(await readFile(join(COMMITTED, 'openapi.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- walking free-form JSON
    const pub = JSON.parse(await readFile(join(COMMITTED, 'openapi.public.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- walking free-form JSON
    for (const file of FILES) expect((await readFile(join(COMMITTED, file), 'utf8')).endsWith('}\n'), file).toBe(true);
    expect(internal.openapi).toBe('3.1.0');
    expect(pub.openapi).toBe('3.1.0');
    expect(Object.keys(internal.paths)).toEqual(
      expect.arrayContaining(['/health', '/metrics', '/openapi.json', '/docs']),
    );
    for (const path of Object.keys(pub.paths)) expect(internal.paths[path], path).toBeDefined();
    expect(JSON.stringify(internal)).not.toContain('"$schema"');
  });
});

describe('gen-openapi.ts', () => {
  it('writes both documents into --dir, byte for byte what is committed', async () => {
    const dir = join(await scratch(), 'nested', 'contract');
    const result = await generate(['--dir', dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/wrote .*openapi\.json/);
    expect(result.stdout).toMatch(/wrote .*openapi\.public\.json/);
    for (const file of FILES) {
      expect(await readFile(join(dir, file), 'utf8'), file).toBe(await readFile(join(COMMITTED, file), 'utf8'));
    }
  });

  it('--check passes on a folder it just generated', async () => {
    const dir = await scratch();
    expect((await generate(['--dir', dir])).code).toBe(0);
    const result = await generate(['--check', '--dir', dir]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('--check fails, naming the file and the first difference, when a committed file was edited', async () => {
    const dir = await scratch();
    await generate(['--dir', dir]);
    const file = join(dir, 'openapi.public.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"GSM Supplier API"', '"Edited by hand"'));
    const result = await generate(['--check', '--dir', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('openapi.public.json is out of date: first difference at line');
    expect(result.stderr).toContain('Edited by hand');
    expect(result.stderr).toContain('bun run docs:openapi');
    // The other file is still reported as fine.
    expect(result.stdout).toContain('openapi.json is up to date.');
  });

  it('--check fails when a file is missing, and when the text only lacks the trailing newline', async () => {
    const dir = await scratch();
    await generate(['--dir', dir]);
    await rm(join(dir, 'openapi.json'));
    const missing = await generate(['--check', '--dir', dir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('openapi.json is missing.');

    await generate(['--dir', dir]);
    const file = join(dir, 'openapi.public.json');
    await writeFile(file, (await readFile(file, 'utf8')).trimEnd());
    const noNewline = await generate(['--check', '--dir', dir]);
    expect(noNewline.code).toBe(1);
    expect(noNewline.stderr).toContain('openapi.public.json is out of date');
  });

  it('--check writes nothing', async () => {
    const dir = join(await scratch(), 'never-created');
    expect((await generate(['--check', '--dir', dir])).code).toBe(1);
    const state = await readFile(join(dir, 'openapi.json')).then(
      () => 'written',
      () => 'absent',
    );
    expect(state).toBe('absent');
  });

  it('rejects unknown arguments with exit code 2', async () => {
    const result = await generate(['--frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown argument "--frobnicate"');
  });

  it('does not depend on the machine: a production or broken environment gives the same documents', async () => {
    const dir = await scratch();
    const result = await generate(['--dir', dir], {
      NODE_ENV: 'production',
      REFERENCE_DOCS: 'banana',
      PORT: 'not-a-port',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/nowhere',
      REDIS_QUEUE_URL: 'redis://127.0.0.1:1',
      REDIS_CACHE_URL: 'redis://127.0.0.1:1',
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    for (const file of FILES) {
      expect(await readFile(join(dir, file), 'utf8'), file).toBe(await readFile(join(COMMITTED, file), 'utf8'));
    }
  });
});

describe('forbidConnections (what keeps the generator offline)', () => {
  const probe = (body: string) =>
    bun([
      '-e',
      `import net from 'node:net'; import { forbidConnections } from './scripts/lib/forbid-connections.ts';
       const attempts = forbidConnections();
       ${body}
       console.log(JSON.stringify(attempts));`,
    ]);

  it('refuses a connection and records where it was going', async () => {
    const result = await probe(
      `try { net.connect(6380, '127.0.0.1'); console.log('connected'); } catch (error) { console.log(String(error.message)); }`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('opening a network connection is not allowed');
    expect(result.stdout).not.toContain('connected\n');
    expect(result.stdout).toContain('6380');
  });

  it('records the attempt even when the client swallows the error (ioredis reports it as an event)', async () => {
    const result = await probe(
      `const { Redis } = await import('ioredis');
       const redis = new Redis('redis://127.0.0.1:6380', { maxRetriesPerRequest: 0 });
       redis.on('error', () => undefined);
       await new Promise((resolve) => setTimeout(resolve, 200));
       redis.disconnect();`,
    );
    expect(result.code).toBe(0);
    const attempts = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '[]') as string[];
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]).toContain('6380');
  });

  it('records nothing when nothing connects', async () => {
    const result = await probe('');
    expect(result.stdout.trim()).toBe('[]');
  });
});

describe('createOfflineApp (what makes the generator fail when a provider connects)', () => {
  const probe = (...args: string[]) => bun(['test/support/offline-app-probe.ts', ...args]);
  const attemptsOf = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]') as string[];

  it('reports an ioredis client that a provider factory builds without lazyConnect', async () => {
    // ioredis opens its socket on process.nextTick, after the factory returned: a check straight after
    // NestFactory.create sees nothing, so this fails when the helper stops waiting one turn of the event loop.
    const result = await probe();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const attempts = attemptsOf(result.stdout);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]).toContain('6380');
  });

  it('reports nothing for a client built with lazyConnect (it connects later, in onModuleInit)', async () => {
    const result = await probe('--lazy');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(attemptsOf(result.stdout)).toEqual([]);
  });
});
