// Tests of scripts/test-batches.sh: the batches of a whole run, the shards a CI spreads over several machines, and the second
// run of a batch that failed. `bun` is replaced by a stub that logs the files it was given, and the files are an empty fixture
// folder, so no test runs. Why it matters: a shard that skipped a batch, or two shards that ran the same one, would make a green
// pipeline say less than it claims (decision 057).
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '../..');
// Real tools the script needs besides the stub.
const REAL_TOOLS = ['bash', 'dirname', 'find', 'sort', 'mktemp', 'tee', 'grep', 'tail', 'awk', 'rm'];
const FILES = 30;
const BATCH = 4;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Options {
  readonly shard?: string;
  readonly rerun?: boolean;
  /** The stub fails this many times for the batch that holds this file name. */
  readonly failFile?: string;
  readonly failTimes?: number;
  /** Run as a job on GitHub does. */
  readonly github?: boolean;
}

/** Runs the script over a folder of 30 empty test files in batches of 4, with a stub `bun`; returns the outcome and the batches the stub saw. */
async function runBatches(options: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-batches-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const tests = join(dir, 'tests');
  const log = join(dir, 'calls.log');
  await mkdir(bin);
  await mkdir(tests);
  await writeFile(log, '');
  await writeFile(join(dir, 'failures'), '');
  for (let i = 1; i <= FILES; i++) await writeFile(join(tests, `f${String(i).padStart(2, '0')}.test.ts`), '');
  for (const tool of REAL_TOOLS) await symlink(`/usr/bin/${tool}`, join(bin, tool));
  await writeFile(
    join(bin, 'bun'),
    `#!/usr/bin/bash
# The files of this call, one line; the first three arguments are "test --timeout 15000".
echo "${'$'}{@:4}" >> "$CALLS_LOG"
if [ -n "$FAIL_FILE" ] && [[ "$*" == *"$FAIL_FILE"* ]]; then
  read -r seen < <(grep -c . "$FAILURES")
  if [ "${'$'}{seen:-0}" -lt "$FAIL_TIMES" ]; then
    echo x >> "$FAILURES"
    printf ' 2 pass\\n 0 skip\\n 1 fail\\n'
    exit 1
  fi
fi
printf ' 3 pass\\n 1 skip\\n 0 fail\\n'
`,
  );
  await chmod(join(bin, 'bun'), 0o755);
  const child = Bun.spawn(['/usr/bin/bash', 'scripts/test-batches.sh', tests], {
    cwd: ROOT,
    env: {
      PATH: bin,
      HOME: tmpdir(),
      CALLS_LOG: log,
      FAILURES: join(dir, 'failures'),
      FAIL_FILE: options.failFile ?? '',
      FAIL_TIMES: String(options.failTimes ?? 0),
      GSM_TEST_BATCH: String(BATCH),
      ...(options.shard === undefined ? {} : { GSM_TEST_SHARD: options.shard }),
      ...(options.rerun ? { GSM_TEST_RERUN: '1' } : {}),
      ...(options.github ? { GITHUB_ACTIONS: 'true' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const calls = (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ').map((path) => path.slice(path.lastIndexOf('/') + 1)));
  const numbers = [...stdout.matchAll(/^== batch (\d+): /gm)].map((match) => Number(match[1]));
  return { stdout, stderr, code, calls, numbers };
}

const name = (i: number) => `f${String(i).padStart(2, '0')}.test.ts`;
const allFiles = Array.from({ length: FILES }, (_, i) => name(i + 1));

describe('scripts/test-batches.sh', () => {
  it('runs every file once, in batches in path order, and adds up the counts', async () => {
    const result = await runBatches();
    expect(result.code).toBe(0);
    expect(result.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.calls.flat()).toEqual(allFiles);
    expect(result.calls.map((call) => call.length)).toEqual([4, 4, 4, 4, 4, 4, 4, 2]);
    expect(result.stdout).toContain('All 30 test files in batches of 4:\n 24 pass\n 8 skip\n 0 fail\n');
  });

  it('gives each shard every third batch under its number in the whole run; together the shards run every file once', async () => {
    const shards = await Promise.all(['0/3', '1/3', '2/3'].map((shard) => runBatches({ shard })));
    expect(shards.map((shard) => shard.code)).toEqual([0, 0, 0]);
    expect(shards.map((shard) => shard.numbers)).toEqual([
      [1, 4, 7],
      [2, 5, 8],
      [3, 6],
    ]);
    expect(shards[0]?.calls[1]).toEqual([name(13), name(14), name(15), name(16)]);
    expect(shards.flatMap((shard) => shard.calls.flat()).sort()).toEqual(allFiles);
    expect(shards[1]?.stdout).toContain(
      'Shard 1 of 3: 10 of 30 test files in batches of 4:\n 9 pass\n 3 skip\n 0 fail\n',
    );
  });

  it('refuses a shard it cannot read, before any test runs', async () => {
    for (const shard of ['3/3', '1', 'a/b', '1/0', '-1/2']) {
      const result = await runBatches({ shard });
      expect(result.code, shard).toBe(2);
      expect(result.stderr, shard).toContain('GSM_TEST_SHARD must be k/n');
      expect(result.calls, shard).toEqual([]);
    }
  });

  it('fails, and names the batch, when a batch fails and no second run is asked for', async () => {
    const result = await runBatches({ failFile: name(6), failTimes: 1 });
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(8);
    expect(result.stdout).toContain(' 23 pass\n 7 skip\n 1 fail\nfailed batches: 2\n');
  });

  it('runs a failed batch once more on its own; a batch that then passes does not fail the run, and its second counts are the ones added', async () => {
    const result = await runBatches({ failFile: name(6), failTimes: 1, rerun: true });
    expect(result.code).toBe(0);
    expect(result.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 2]);
    expect(result.calls[8]).toEqual([name(5), name(6), name(7), name(8)]);
    expect(result.stdout).toContain('== batch 2 failed: running it once more on its own');
    expect(result.stdout).toContain(' 24 pass\n 8 skip\n 0 fail\nfailed, then passed on a second run: 2\n');
    expect(result.stdout).not.toContain('failed batches:');
  });

  it('says so in a notice on GitHub, where the run stays green, and nowhere else', async () => {
    const hosted = await runBatches({ failFile: name(6), failTimes: 1, rerun: true, github: true });
    expect(hosted.code).toBe(0);
    expect(hosted.stdout).toContain('::warning::test batches 2 failed once and passed on a second run');
    const local = await runBatches({ failFile: name(6), failTimes: 1, rerun: true });
    expect(local.stdout).not.toContain('::warning::');
    const clean = await runBatches({ github: true });
    expect(clean.stdout).not.toContain('::warning::');
  });

  it('still fails when the batch fails the second time too', async () => {
    const result = await runBatches({ failFile: name(6), failTimes: 2, rerun: true });
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(9);
    expect(result.stdout).toContain(' 23 pass\n 7 skip\n 1 fail\nfailed batches: 2\n');
    expect(result.stdout).not.toContain('passed on a second run');
  });
});
