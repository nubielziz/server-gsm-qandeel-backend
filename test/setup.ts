// Preloaded by bunfig.toml before every test file (decision 014): fixes the environment and loads reflect-metadata.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import 'reflect-metadata';

process.env.NODE_ENV = 'test';

/**
 * Refuses one `bun test` process for a large part of the suite.
 *
 * Why: one process keeps every Nest app its files boot until it ends; a run over the whole suite grew past 11 GB and the
 * out-of-memory killer stopped the machine, where several worktrees run their tests at once. `bun run test`,
 * `test:unit` and `test:integration` run the files in batches (`scripts/test-batches.sh` sets GSM_TEST_BATCHED); a direct
 * run of a few files or a small folder is fine.
 */
function guardLargeRuns(): void {
  if (process.env.GSM_TEST_BATCHED === '1') return;
  const isTestFile = (name: string) => /\.(test|spec)\.tsx?$/.test(name);
  const count = (path: string): number => {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return 0;
    if (info.isFile()) return isTestFile(path) ? 1 : 0;
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .reduce((sum, entry) => sum + count(`${path}/${entry.name}`), 0);
  };
  // The preload runs once per process and sees only the current file in Bun.argv; the command line itself is in /proc.
  let args: string[];
  try {
    args = readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
  } catch {
    return;
  }
  const afterTest = args.slice(args.indexOf('test') + 1);
  const targets = afterTest.filter(
    (arg, i) =>
      !arg.startsWith('-') &&
      !afterTest[i - 1]?.match(
        /^--?(timeout|t|bail|rerun-each|test-name-pattern|preload|coverage-dir|reporter|reporter-outfile|max-concurrency)$/,
      ),
  );
  const files = targets.length === 0 ? count('./src') + count('./test') : targets.reduce((sum, t) => sum + count(t), 0);
  if (files > 40) {
    console.error(
      `Refused: this would run ${files} test files in one process, which can run the machine out of memory. ` +
        'Use `bun run test`, `bun run test:unit` or `bun run test:integration` (batched), or name fewer files.',
    );
    process.exit(1);
  }
}

guardLargeRuns();

/**
 * Stops a test process whose memory runs away.
 *
 * Why: a failing assertion that printed a whole database transaction grew one process to 13 GB in under a minute, and the
 * out-of-memory killer stopped the machine with every other worktree's work. The printing blocks the event loop, so a timer in
 * this process could never react: a small watcher process checks this process's memory instead, and past GSM_TEST_MAX_RSS_MB
 * (default 4000; a batch of a dozen integration files stays well under it) it ends it with a message. The watcher ends with the process.
 */
function guardMemory(): void {
  const limitMb = Number(process.env.GSM_TEST_MAX_RSS_MB ?? 4000);
  const pid = process.pid;
  const script =
    `while kill -0 ${pid} 2>/dev/null; do ` +
    `r=$(awk '/VmRSS/ {print $2}' /proc/${pid}/status 2>/dev/null); ` +
    `if [ "\${r:-0}" -gt ${limitMb * 1024} ]; then ` +
    `echo "Stopped: this test process used $((r / 1024)) MB, over the ${limitMb} MB limit (GSM_TEST_MAX_RSS_MB). ` +
    `A test in the files it ran loops or prints a huge object; run them one by one to find it." >&2; ` +
    `kill -9 ${pid}; exit 0; fi; sleep 0.3; done`;
  const watcher = Bun.spawn(['bash', '-c', script], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  watcher.unref();
}

guardMemory();
