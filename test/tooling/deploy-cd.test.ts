// Static checks and small runs of the continuous integration and deploy files (decisions 057 and 058): the workflow, the script that
// deploys a commit on the server, the Caddyfile written for a server behind a CDN, and the list of the CDN's addresses. Nothing is
// deployed: `curl` is a stub, and the commits are in a repository made for the test. Why it matters: these files decide what reaches
// production and whose address the API believes, and nothing else runs them before the server does.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-cd-'));
  dirs.push(dir);
  return dir;
};

/** Runs a command and returns its exit code and output. */
async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? { PATH: '/usr/bin:/bin', HOME: tmpdir() },
    stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
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

describe('.github/workflows/ci.yml', () => {
  const text = read('.github/workflows/ci.yml');
  const workflow = Bun.YAML.parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        steps: { uses?: string; run?: string; env?: Record<string, string> }[];
        strategy?: { matrix: { shard: number[] } };
      }
    >;
  };

  it('runs on pushes to main and on pull requests, never with the rights of the target branch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
    expect(text).not.toContain('pull_request_target');
  });

  it('may only read the repository, and reads no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
  });

  it('pins every action to a commit', () => {
    const uses = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('runs every check of `bun run check` except the tests in the static job', () => {
    const check = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.check ?? '';
    const steps = (workflow.jobs.static?.steps ?? []).map((step) => step.run ?? '').join('\n');
    for (const part of check.split(' && ')) {
      const script = part.replace('bun run ', '');
      if (script === 'test') continue;
      // Lint runs without the machine-wide slot of scripts/with-slot.sh: a runner runs one job.
      expect(steps, script).toContain(script === 'lint' ? 'bun --bun eslint .' : `bun run ${script}`);
    }
  });

  it("installs the console's packages before the contract check reads its TypeScript, in the test shards too", () => {
    for (const job of ['static', 'tests']) {
      const runs = (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? '');
      const install = runs.findIndex((line) => line.startsWith('npm ci --ignore-scripts'));
      expect(install, job).toBeGreaterThan(-1);
      const check = runs.findIndex(
        (line) => line === 'bun run contract:check' || line === 'bash scripts/test-batches.sh',
      );
      expect(install, job).toBeLessThan(check);
    }
  });

  it('waits until the buckets exist before a test runs', () => {
    const start = (workflow.jobs.tests?.steps ?? []).find((step) =>
      (step.run ?? '').includes('docker compose up -d minio-init'),
    );
    expect(start?.run).toContain('[ "$state" = "exited 0" ] && exit 0');
  });

  it('spreads the tests over shards that together are the whole suite, with a second run for a failed batch', () => {
    const tests = workflow.jobs.tests;
    const shards = tests?.strategy?.matrix.shard ?? [];
    expect(shards).toEqual(shards.map((_, index) => index));
    const step = tests?.steps.find((candidate) => candidate.run === 'bash scripts/test-batches.sh');
    expect(step?.env).toEqual({ GSM_TEST_SHARD: `\${{ matrix.shard }}/${shards.length}`, GSM_TEST_RERUN: '1' });
  });
});

describe('deploy/cd/cloudflare-ips.txt', () => {
  const ranges = read('deploy/cd/cloudflare-ips.txt')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('holds address ranges only, of both families', () => {
    for (const range of ranges) expect(range).toMatch(/^([0-9.]+\/\d{1,2}|[0-9a-f:]+\/\d{1,3})$/);
    expect(ranges.some((range) => range.includes('.'))).toBe(true);
    expect(ranges.some((range) => range.includes(':'))).toBe(true);
  });
});

describe('deploy/cd/edge-cdn.py', () => {
  const edge = (args: string[]) => run(['python3', 'deploy/cd/edge-cdn.py', ...args]);
  const usual = ['--ranges', 'deploy/cd/cloudflare-ips.txt', '--header', 'CF-Connecting-IP'];

  it('trusts only the given ranges, reads the visitor from the one header and writes the forwarded headers of the API and the site itself', async () => {
    const result = await edge(usual);
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(
      /\n\t\ttrusted_proxies static 173\.245\.48\.0\/20 [^\n]* 2c0f:f248::\/32\n\t\tclient_ip_headers CF-Connecting-IP\n/,
    );
    const own =
      '\\{\\n\\t+header_up X-Forwarded-For \\{client_ip\\}\\n\\t+header_up X-Forwarded-Host \\{host\\}\\n\\t+header_up X-Forwarded-Proto \\{scheme\\}\\n\\t+\\}';
    expect(out.match(new RegExp(`reverse_proxy api:3000 ${own}`, 'g'))).toHaveLength(3);
    expect(out.match(new RegExp(`reverse_proxy site:3000 ${own}`, 'g'))).toHaveLength(1);
    expect(out).not.toMatch(/reverse_proxy (api|site):3000\n/);
    // The console's static pages and the files host are passed on as before.
    expect(out).toContain('reverse_proxy console:80\n');
    expect(out).toMatch(/reverse_proxy minio:9000 \{\s*header_up Host \{hostport\}\s*\}/);
  });

  it('keeps the visitor-country header only from the given ranges on the shop host, and removes it on the other hosts as before', async () => {
    const out = (await edge(usual)).stdout;
    const block = (host: string) =>
      out.slice(out.indexOf(`{$${host}} {`), out.indexOf('\n}\n', out.indexOf(`{$${host}} {`)));
    expect(block('SHOP_HOST')).toMatch(
      /\t@not_cdn not remote_ip 173\.245\.48\.0\/20 [^\n]*\n\trequest_header @not_cdn -\{\$GEOIP_COUNTRY_HEADER:X-Visitor-Country\}\n/,
    );
    expect(block('SHOP_HOST')).not.toContain('\trequest_header -{$GEOIP_COUNTRY_HEADER');
    for (const host of ['ADMIN_HOST', 'API_HOST'])
      expect(block(host), host).toContain('\trequest_header -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}\n');
  });

  it('changes nothing else: every other line of the Caddyfile is carried over in order', async () => {
    const before = read('deploy/Caddyfile').split('\n');
    const after = (await edge(usual)).stdout.split('\n');
    const rewritten = (line: string) => /^\t+reverse_proxy (api|site):3000$/.test(line);
    // The shop host's own visitor-country line is the one line that is replaced, not wrapped: it is the first of the three.
    const country = '\trequest_header -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}';
    const first = before.indexOf(country);
    const kept = before.filter((line, index) => !rewritten(line) && index !== first);
    let at = 0;
    for (const line of after) if (line === kept[at]) at += 1;
    expect(at).toBe(kept.length);
    // Five lines in the global options, four more for each of the four proxies, one more on the shop host.
    expect(after.length - before.length).toBe(5 + 4 * 4 + 1);
  });

  it('prints nothing and fails for a header or a range it cannot read, and for a file that already trusts a proxy', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'bad.txt'), '10.0.0.0/8\nnot-a-range\n');
    await writeFile(join(dir, 'empty.txt'), '# nothing\n');
    await writeFile(join(dir, 'Caddyfile'), (await edge(usual)).stdout);
    const cases: string[][] = [
      ['--ranges', join(dir, 'bad.txt'), '--header', 'CF-Connecting-IP'],
      ['--ranges', join(dir, 'empty.txt'), '--header', 'CF-Connecting-IP'],
      ['--ranges', 'deploy/cd/cloudflare-ips.txt', '--header', 'X Forwarded'],
      [...usual, '--input', join(dir, 'Caddyfile')],
    ];
    for (const args of cases) {
      const result = await edge(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.stderr, args.join(' ')).toContain('edge-cdn.py: ');
    }
  });

  it('fails when the Caddyfile lost a line it rewrites, so the two cannot drift apart unnoticed', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'Caddyfile'),
      read('deploy/Caddyfile').replace('\t\treverse_proxy site:3000\n', '\t\treverse_proxy site:3001\n'),
    );
    const result = await edge([...usual, '--input', join(dir, 'Caddyfile')]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("expected 1 plain 'reverse_proxy site:3000' lines");
  });
});

describe('deploy/cd shell scripts', () => {
  it('parse', async () => {
    expect((await run(['bash', '-n', 'deploy/cd/auto-deploy.sh'])).code).toBe(0);
    expect((await run(['sh', '-n', 'deploy/cd/origin-firewall.sh'])).code).toBe(0);
  });

  it('the origin firewall names the web ports and nothing else, and matches only packets that open a connection from outside', () => {
    const script = read('deploy/cd/origin-firewall.sh');
    expect(script).toContain('for spec in "tcp 80" "tcp 443" "udp 443"; do');
    expect(script).toContain('-m conntrack --ctorigdstport "$2" --ctdir ORIGINAL -j GSM-ORIGIN');
    expect(script).not.toMatch(/--dport 22|ctorigdstport 22/);
  });

  it('refreshes the backup script from the repository only where it was installed, and leaves its units alone (decision 059)', () => {
    const script = read('deploy/cd/auto-deploy.sh');
    const start = script.indexOf('install_self() {');
    const body = script.slice(start, script.indexOf('\n}\n', start));
    expect(body).toContain('backup=$ROOT/backend/deploy/backup/gsm-backup.sh');
    expect(body).toContain('if [ -e /usr/local/sbin/gsm-backup ] && [ -f "$backup" ]; then');
    expect(body).toContain(
      'cmp -s "$backup" /usr/local/sbin/gsm-backup || install -m 0750 "$backup" /usr/local/sbin/gsm-backup || true',
    );
    expect(body).not.toMatch(/gsm-backup[\w-]*\.(service|timer)/);
  });

  it('the origin firewall never empties a chain that is in use, replaces its list in one step and closes the web ports over IPv6', () => {
    const script = read('deploy/cd/origin-firewall.sh');
    expect(script).not.toMatch(/iptables -F|iptables --flush/);
    expect(script).toContain('ipset swap gsm-cdn4-next gsm-cdn4');
    expect(script).toContain('ip6tables -I INPUT 1 ! -i lo -p "$1" --dport "$2" -j DROP');
    // The unit runs before Docker publishes a port.
    const unit = read('deploy/cd/gsm-origin-firewall.service');
    expect(unit).toContain('Before=docker.service');
    // A list that cannot be read must not keep Docker, and so the site, from starting.
    expect(unit).toContain('StartLimitBurst=3');
    expect(script).toContain('[ -e /proc/net/if_inet6 ]');
  });
});

describe('deploy/cd/auto-deploy.sh', () => {
  /** Runs one function of the script against a stub `curl` and a settings file of its own. */
  async function sourced(call: string, options: { curl?: string; state?: string; root?: string } = {}) {
    const dir = await tempDir();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    for (const tool of [
      'bash',
      'python3',
      'git',
      'grep',
      'date',
      'cat',
      'rm',
      'sed',
      'cut',
      'head',
      'printf',
      'mkdir',
    ]) {
      await symlink(`/usr/bin/${tool}`, join(bin, tool)).catch(() => undefined);
    }
    await writeFile(
      join(bin, 'curl'),
      `#!/usr/bin/bash\necho call >> "${dir}/curl-calls"\n${options.curl ?? 'exit 22'}\n`,
    );
    await chmod(join(bin, 'curl'), 0o755);
    const state = options.state ?? join(dir, 'state');
    await mkdir(state, { recursive: true });
    await writeFile(
      join(dir, 'deploy.conf'),
      `ROOT=${options.root ?? dir}\nGITHUB_OWNER=owner\nREPO_BACKEND=be\nREPO_CONSOLE=co\nREPO_SHOP=sh\nSTATE=${state}\n`,
    );
    const result = await run(['/usr/bin/bash', '-c', `GSM_DEPLOY_SOURCED=1; . deploy/cd/auto-deploy.sh; ${call}`], {
      env: { PATH: bin, HOME: tmpdir(), GSM_DEPLOY_CONF: join(dir, 'deploy.conf') },
    });
    const calls = await Bun.file(join(dir, 'curl-calls'))
      .text()
      .then((text) => text.split('\n').filter(Boolean).length)
      .catch(() => 0);
    return { ...result, calls, state };
  }
  const answer = (runs: Record<string, string>[]) => `cat <<'JSON'\n${JSON.stringify({ workflow_runs: runs })}\nJSON`;
  const done = {
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
  };

  it('deploys only a commit whose every run on the branch has finished and succeeded', async () => {
    const cases: [string, Record<string, string>[]][] = [
      ['success', [done, done]],
      ['pending', [done, { ...done, status: 'in_progress', conclusion: '' }]],
      ['pending', [{ ...done, status: 'queued', conclusion: '' }]],
      ['failure', [done, { ...done, conclusion: 'failure' }]],
      ['failure', [{ ...done, conclusion: 'cancelled' }]],
      ['none', []],
      // Another workflow's success says nothing while the repository's own checks are not among the runs; its failure counts.
      ['none', [{ ...done, path: '.github/workflows/other.yml' }]],
      ['failure', [done, { ...done, path: '.github/workflows/other.yml', conclusion: 'failure' }]],
      // A run of the same commit for a pull request or another branch says nothing about the branch that is deployed.
      [
        'none',
        [
          { ...done, event: 'pull_request' },
          { ...done, head_branch: 'feature' },
        ],
      ],
    ];
    for (const [expected, runs] of cases) {
      const result = await sourced('ci_state be 0123abc', { curl: answer(runs) });
      expect(result.stdout.trim(), JSON.stringify(runs)).toBe(expected);
    }
  });

  it('takes an answer it cannot get or cannot read as unknown, never as success', async () => {
    expect((await sourced('ci_state be 0123abc', { curl: 'exit 22' })).stdout.trim()).toBe('unknown');
    expect((await sourced('ci_state be 0123abc', { curl: 'echo "<html>rate limited</html>"' })).stdout.trim()).toBe(
      'unknown',
    );
    expect((await sourced('ci_state be 0123abc', { curl: 'echo "{}"' })).stdout.trim()).toBe('unknown');
  });

  it('asks GitHub about a failed commit once per waiting time, and never remembers a success', async () => {
    const failed = await sourced(
      'ci_state_spaced backend be 0123abc; ci_state_spaced backend be 0123abc; ci_state_spaced backend be 4567def',
      {
        curl: answer([{ ...done, conclusion: 'failure' }]),
      },
    );
    expect(failed.stdout.trim().split('\n')).toEqual(['failure', 'failure', 'failure']);
    expect(failed.calls).toBe(2);
    const passed = await sourced('ci_state_spaced backend be 0123abc; ci_state_spaced backend be 0123abc', {
      curl: answer([done]),
    });
    expect(passed.stdout.trim().split('\n')).toEqual(['success', 'success']);
    expect(passed.calls).toBe(2);
  });

  it('builds a new image only for a change that runs: not for documents, tests or the workflows', async () => {
    const root = await tempDir();
    const git = (dir: string, ...args: string[]) =>
      run([
        'git',
        '-C',
        dir,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ]);
    const commit = async (dir: string, path: string): Promise<string> => {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), String(Math.random()));
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '-q', '-m', path);
      return (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
    };
    const expectations: [string, string, string, boolean][] = [
      ['backend', 'backend', 'docs/OPERATIONS.md', false],
      ['backend', 'backend', 'test/unit/x.spec.ts', false],
      ['backend', 'backend', '.github/workflows/ci.yml', false],
      ['backend', 'backend', 'PROGRESS.md', false],
      ['backend', 'backend', 'src/main.ts', true],
      ['backend', 'backend', 'drizzle/0063_x.sql', true],
      ['backend', 'backend', 'deploy/Caddyfile', true],
      ['backend', 'backend', 'bun.lock', true],
      ['console', 'frontend-admin', '.github/workflows/ci.yml', false],
      ['console', 'frontend-admin', 'src/App.test.tsx', false],
      ['console', 'frontend-admin', 'README.md', false],
      ['console', 'frontend-admin', 'src/App.tsx', true],
      ['shop', 'storefront', 'e2e/store.spec.ts', false],
      ['shop', 'storefront', 'app/page.tsx', true],
      ['shop', 'storefront', 'package-lock.json', true],
    ];
    for (const folder of ['backend', 'frontend-admin', 'storefront']) {
      await mkdir(join(root, folder));
      await git(join(root, folder), 'init', '-q');
      await commit(join(root, folder), 'first.txt');
    }
    for (const [part, folder, path, expected] of expectations) {
      const dir = join(root, folder);
      const from = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
      const to = await commit(dir, path);
      const result = await sourced(`if relevant ${part} ${from} ${to}; then echo yes; else echo no; fi`, { root });
      expect(result.stdout.trim(), `${part} ${path}`).toBe(expected ? 'yes' : 'no');
    }
  });

  it('sees a change that runs among thousands of files that do not', async () => {
    const root = await tempDir();
    const dir = join(root, 'frontend-admin');
    const git = (...args: string[]) =>
      run([
        'git',
        '-C',
        dir,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ]);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await mkdir(join(dir, 'src'));
    await git('init', '-q');
    await writeFile(join(dir, 'first.txt'), '');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'first');
    const from = (await git('rev-parse', 'HEAD')).stdout.trim();
    for (let i = 0; i < 6000; i++) await writeFile(join(dir, 'docs', `page-${i}.md`), '');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'documents');
    const documents = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(dir, 'src', 'App.tsx'), '');
    for (let i = 0; i < 6000; i++) await writeFile(join(dir, 'docs', `more-${i}.md`), '');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'one file that runs');
    const to = (await git('rev-parse', 'HEAD')).stdout.trim();
    const ask = (a: string, b: string) =>
      sourced(`if relevant console ${a} ${b}; then echo yes; else echo no; fi`, { root });
    expect((await ask(from, documents)).stdout.trim()).toBe('no');
    // Asked several times: the answer must not depend on how fast a reader stops.
    for (let i = 0; i < 5; i++) expect((await ask(from, to)).stdout.trim()).toBe('yes');
  }, 60_000);

  it('refuses to run with a CDN header and no Caddyfile of the server to go with it', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'deploy.conf'),
      `ROOT=${dir}\nGITHUB_OWNER=o\nREPO_BACKEND=b\nREPO_CONSOLE=c\nREPO_SHOP=s\nSTATE=${join(dir, 'state')}\nCDN_HEADER=CF-Connecting-IP\nCDN_RANGES=${join(dir, 'ranges')}\nEDGE_CADDYFILE=${join(dir, 'Caddyfile')}\n`,
    );
    const result = await run(['bash', 'deploy/cd/auto-deploy.sh', 'run'], {
      env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), GSM_DEPLOY_CONF: join(dir, 'deploy.conf') },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('COMPOSE_OVERRIDE must be set too');
  });

  it('refuses an unknown command and a part it does not know', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'deploy.conf'),
      `ROOT=${dir}\nGITHUB_OWNER=o\nREPO_BACKEND=b\nREPO_CONSOLE=c\nREPO_SHOP=s\nSTATE=${join(dir, 'state')}\n`,
    );
    const env = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GSM_DEPLOY_CONF: join(dir, 'deploy.conf') };
    const unknown = await run(['bash', 'deploy/cd/auto-deploy.sh', 'ship-it'], { env });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('usage: auto-deploy.sh');
    const part = await run(['bash', 'deploy/cd/auto-deploy.sh', 'force', 'database'], { env });
    expect(part.code).toBe(2);
    expect(part.stderr).toContain('name the part');
    const missing = await run(['bash', 'deploy/cd/auto-deploy.sh', 'status'], {
      env: { ...env, GSM_DEPLOY_CONF: join(dir, 'none.conf') },
    });
    expect(missing.code).toBe(2);
  });

  it('holds and resumes', async () => {
    const dir = await tempDir();
    const state = join(dir, 'state');
    await writeFile(
      join(dir, 'deploy.conf'),
      `ROOT=${dir}\nGITHUB_OWNER=o\nREPO_BACKEND=b\nREPO_CONSOLE=c\nREPO_SHOP=s\nSTATE=${state}\n`,
    );
    const env = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GSM_DEPLOY_CONF: join(dir, 'deploy.conf') };
    expect((await run(['bash', 'deploy/cd/auto-deploy.sh', 'hold', 'a', 'release', 'by', 'hand'], { env })).code).toBe(
      0,
    );
    expect(await Bun.file(join(state, 'hold')).text()).toContain('a release by hand');
    const held = await run(['bash', 'deploy/cd/auto-deploy.sh', 'run'], { env });
    expect(held.code).toBe(0);
    expect(held.stdout).toContain('on hold: ');
    expect((await run(['bash', 'deploy/cd/auto-deploy.sh', 'resume'], { env })).code).toBe(0);
    expect(await Bun.file(join(state, 'hold')).exists()).toBe(false);
  });
});
