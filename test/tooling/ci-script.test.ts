// Tests of scripts/ci.sh: install, services, `bun run check`, and a clear failure. Docker and Bun are replaced by
// stubs that log their calls, so nothing is installed, started or recreated. Why it matters: `docker compose up` from
// a second checkout (a git worktree) recreates running containers, so the script must start only missing services.
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '../..');
const ALL_SERVICES = ['postgres', 'redis-queue', 'redis-cache', 'minio'];
// Real tools the script needs besides the two stubs.
const REAL_TOOLS = ['bash', 'dirname', 'grep', 'seq', 'sleep', 'cat'];

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Options {
  /** Services `docker compose ps --status running` reports; `null` means Docker is not installed. */
  readonly running?: readonly string[] | null;
  readonly env?: Record<string, string>;
  /** Make the stub `bun` fail for this command line (for example `run check`). */
  readonly bunFails?: string;
  /** Health the stub `docker inspect` reports. */
  readonly health?: string;
}

/** Runs scripts/ci.sh with stub `docker` and `bun`; returns the outcome and the calls the stubs saw. */
async function runCi(options: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-ci-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  await mkdir(bin);
  await writeFile(log, '');
  for (const tool of REAL_TOOLS) await symlink(`/usr/bin/${tool}`, join(bin, tool));
  await writeFile(
    join(bin, 'bun'),
    `#!/usr/bin/env bash\necho "bun $*" >> "$CALLS_LOG"\n[ -n "$BUN_FAILS" ] && [ "$*" = "$BUN_FAILS" ] && exit 1\nexit 0\n`,
  );
  if (options.running !== null) {
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
if [ "$1 $2" = "compose ps" ]; then
  case "$*" in
    *--services*) for s in $RUNNING; do echo "$s"; done ;;
    *-q*) echo "container-\${@: -1}" ;;
  esac
fi
if [ "$1" = "inspect" ]; then echo "$HEALTH"; fi
exit 0
`,
    );
    await chmod(join(bin, 'docker'), 0o755);
  }
  await chmod(join(bin, 'bun'), 0o755);

  const child = Bun.spawn(['/usr/bin/bash', 'scripts/ci.sh'], {
    cwd: ROOT,
    env: {
      PATH: bin,
      HOME: tmpdir(),
      CALLS_LOG: log,
      RUNNING: (options.running ?? ALL_SERVICES).join(' '),
      HEALTH: options.health ?? 'healthy',
      BUN_FAILS: options.bunFails ?? '',
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  return { stdout, stderr, code, calls, ups: calls.filter((call) => call.startsWith('docker compose up')) };
}

describe('scripts/ci.sh', () => {
  it('installs with the frozen lockfile, then runs bun run check, and says it passed', async () => {
    const result = await runCi();
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('bun'))).toEqual([
      'bun install --frozen-lockfile',
      'bun run check',
    ]);
    expect(result.stdout).toContain('CI passed.');
  });

  it('leaves running services alone: no docker compose up when all four run', async () => {
    const result = await runCi({ running: ALL_SERVICES });
    expect(result.code).toBe(0);
    expect(result.ups).toEqual([]);
    expect(result.stdout).toContain('already running');
  });

  it('starts only the service that is missing, and waits for it', async () => {
    const result = await runCi({ running: ['postgres', 'redis-queue', 'minio'] });
    expect(result.code).toBe(0);
    expect(result.ups).toEqual(['docker compose up -d --wait redis-cache']);
  });

  it('starts MinIO and then creates the buckets when MinIO is missing', async () => {
    const result = await runCi({ running: ['postgres', 'redis-queue', 'redis-cache'] });
    expect(result.ups).toEqual(['docker compose up -d --wait minio', 'docker compose up -d minio-init']);
  });

  it('starts everything on a machine where nothing runs', async () => {
    const result = await runCi({ running: [] });
    expect(result.ups[0]).toBe('docker compose up -d --wait postgres redis-queue redis-cache minio');
    expect(result.ups[1]).toBe('docker compose up -d minio-init');
  });

  it('fails when a running service never becomes healthy', async () => {
    const result = await runCi({ health: 'starting', env: { CI_HEALTH_WAIT_SECONDS: '2' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('postgres is not healthy after 2 s');
    expect(result.stderr).toContain('CI FAILED during: Start the local services');
    expect(result.calls).not.toContain('bun run check');
  });

  it('does not touch Docker with CI_SKIP_SERVICES=1', async () => {
    const result = await runCi({ env: { CI_SKIP_SERVICES: '1' } });
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('docker'))).toEqual([]);
    expect(result.stdout).toContain('Skip the local services');
  });

  it('fails with advice when Docker is not installed', async () => {
    const result = await runCi({ running: null });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Docker is not installed');
    expect(result.stderr).toContain('CI_SKIP_SERVICES=1');
  });

  it('exits non-zero and names the step when bun run check fails', async () => {
    const result = await runCi({ bunFails: 'run check' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CI FAILED during: bun run check');
    expect(result.stdout).not.toContain('CI passed.');
  });

  it('stops before the checks when the frozen install fails', async () => {
    const result = await runCi({ bunFails: 'install --frozen-lockfile' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CI FAILED during: bun install --frozen-lockfile');
    expect(result.calls).not.toContain('bun run check');
  });

  it('fails early, naming the problem, when the frontend checkout is missing', async () => {
    const result = await runCi({ env: { FRONTEND_DIR: '/nonexistent/frontend' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The frontend checkout was not found at '/nonexistent/frontend'");
    expect(result.calls).toEqual([]);
  });
});
