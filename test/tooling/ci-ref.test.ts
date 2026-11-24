// Static checks and small runs of the console ref of the continuous integration (.github/workflows/ci.yml, ci/console-ref): the console is
// checked out at the ref the first line of ci/console-ref names, and a push to main must name `main`. Nothing is installed or checked out:
// the two shell steps of the workflow run in a folder made for the test. Why it matters: a pair of pull requests is proved against each
// other's branches through this file, and a push to main that still named a branch would be proved against the wrong console.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: Step[] }> };
/** The two jobs that check the console out. */
const CONSOLE_JOBS = ['static', 'tests'] as const;
const stepsOf = (job: string): Step[] => workflow.jobs[job]?.steps ?? [];
const indexOfStep = (job: string, predicate: (step: Step) => boolean): number => stepsOf(job).findIndex(predicate);
const isBackendCheckout = (step: Step): boolean =>
  step.uses?.startsWith('actions/checkout@') === true && step.with?.path === 'backend';
const isConsoleCheckout = (step: Step): boolean =>
  step.uses?.startsWith('actions/checkout@') === true && step.with?.path === 'frontend-admin';
const isGuard = (step: Step): boolean => (step.run ?? '').includes('refs/heads/main');
const isReader = (step: Step): boolean => step.id === 'console_ref';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Runs a step the way the runner does (`bash -e`) in a folder holding the given ci/console-ref (`null`: no such file). */
async function runStep(
  step: Step | undefined,
  consoleRef: string | null,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-ci-ref-'));
  dirs.push(dir);
  if (consoleRef !== null) {
    await mkdir(join(dir, 'ci'));
    await writeFile(join(dir, 'ci', 'console-ref'), consoleRef);
  }
  const outputFile = join(dir, 'github-output');
  await writeFile(outputFile, '');
  const child = Bun.spawn(['bash', '-e', '-c', step?.run ?? 'exit 99'], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin', HOME: dir, GITHUB_OUTPUT: outputFile, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr: stdout + stderr, output: await readFile(outputFile, 'utf8') };
}

describe('ci/console-ref', () => {
  it('is one line that names a ref of the console, and `main` is the default', () => {
    const text = read('ci/console-ref');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    // The pattern the workflow accepts; a pull request that spans both repositories names the console's branch here, a push to main `main`.
    expect(lines[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/);
  });
});

describe('the console ref in .github/workflows/ci.yml', () => {
  it('checks the console out at the ref the file names, in both jobs that need it', () => {
    for (const job of CONSOLE_JOBS) {
      const checkout = stepsOf(job).find(isConsoleCheckout);
      expect(checkout, job).toBeDefined();
      expect(checkout?.with?.repository, job).toBe('nubielziz/server-gsm-qandeel-frontend-admin');
      expect(checkout?.with?.ref, job).toBe('${{ steps.console_ref.outputs.ref }}');
    }
  });

  it('reads the file of the backend checkout, which comes first, then checks the console out', () => {
    for (const job of CONSOLE_JOBS) {
      const backend = indexOfStep(job, isBackendCheckout);
      const reader = indexOfStep(job, isReader);
      const consoleCheckout = indexOfStep(job, isConsoleCheckout);
      expect(backend, job).toBeGreaterThan(-1);
      expect(reader, job).toBeGreaterThan(backend);
      expect(consoleCheckout, job).toBeGreaterThan(reader);
      expect(stepsOf(job)[reader]?.run, job).toContain('ci/console-ref');
      expect(stepsOf(job)[reader]?.run, job).toContain('"$GITHUB_OUTPUT"');
    }
  });

  it('has a guard step that comes right after the backend checkout, before anything is read or installed', () => {
    for (const job of CONSOLE_JOBS) {
      const guard = indexOfStep(job, isGuard);
      expect(guard, job).toBe(indexOfStep(job, isBackendCheckout) + 1);
      const run = stepsOf(job)[guard]?.run ?? '';
      expect(run, job).toContain('ci/console-ref');
      expect(run, job).toContain('GITHUB_EVENT_NAME');
      expect(run, job).toContain('exit 1');
      expect(guard, job).toBeLessThan(indexOfStep(job, isReader));
    }
  });

  it('keeps the production image job free of the console', () => {
    expect(stepsOf('image').some(isConsoleCheckout)).toBe(false);
    expect(stepsOf('image').some((step) => (step.run ?? '').includes('console-ref'))).toBe(false);
  });
});

describe('the guard step', () => {
  for (const job of CONSOLE_JOBS) {
    const guard = stepsOf(job).find(isGuard);
    const push = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
    const pullRequest = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };

    it(`(${job}) lets a push to main that names main through`, async () => {
      for (const text of ['main\n', 'main']) expect((await runStep(guard, text, push)).code).toBe(0);
    });

    it(`(${job}) fails a push to main that names another ref, and says what to do`, async () => {
      for (const text of ['feat/accounts\n', 'main2\n', 'main \n', '\n', '']) {
        const result = await runStep(guard, text, push);
        expect(result.code, JSON.stringify(text)).not.toBe(0);
        expect(result.stderr, JSON.stringify(text)).toContain('Put main back in ci/console-ref');
      }
    });

    it(`(${job}) lets a pull request name another ref`, async () => {
      expect((await runStep(guard, 'feat/accounts\n', pullRequest)).code).toBe(0);
    });

    it(`(${job}) fails when the file is missing`, async () => {
      const result = await runStep(guard, null, pullRequest);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('ci/console-ref is missing');
    });
  }
});

describe('the step that reads the ref', () => {
  for (const job of CONSOLE_JOBS) {
    const reader = stepsOf(job).find(isReader);

    it(`(${job}) writes the first line as the output ref`, async () => {
      for (const [text, ref] of [
        ['main\n', 'main'],
        ['feat/accounts\nsecond line\n', 'feat/accounts'],
        ['release-1.2_x\r\n', 'release-1.2_x'],
        ['0123456789abcdef0123456789abcdef01234567\n', '0123456789abcdef0123456789abcdef01234567'],
      ] as const) {
        const result = await runStep(reader, text);
        expect(result.code, JSON.stringify(text)).toBe(0);
        expect(result.output, JSON.stringify(text)).toBe(`ref=${ref}\n`);
      }
    });

    it(`(${job}) refuses a first line that is not a plain ref, so nothing else reaches the step output`, async () => {
      const bad = [
        '',
        '\n',
        'a b\n',
        ' main\n',
        'main \n',
        '-x\n',
        '../x\n',
        '$(id)\n',
        'a;b\n',
        'x${{y}}\n',
        'a'.repeat(101) + '\n',
      ];
      for (const text of bad) {
        const result = await runStep(reader, text);
        expect(result.code, JSON.stringify(text)).not.toBe(0);
        expect(result.output, JSON.stringify(text)).toBe('');
      }
    });
  }
});
