// Static checks and small runs of the continuous integration and deploy files (decisions 057 and 058): the workflow, the script that
// deploys a commit on the server, the Caddyfile written for a server behind a CDN, and the list of the CDN's addresses. Nothing is
// deployed: `curl` is a stub, and the commits are in a repository made for the test. Why it matters: these files decide what reaches
// production and whose address the API believes, and nothing else runs them before the server does.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { PROBLEM_CONTENT_TYPE } from '@src/common/errors/problem';

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

  it('keeps the import of the edge gate first on every host, and writes no copy of a file that lost it (the closed edge)', async () => {
    const out = (await edge(usual)).stdout;
    expect(out.match(/^\{\$[A-Z_]+\} \{$/gm)).toHaveLength(4);
    expect(out.match(/^\{\$[A-Z_]+\} \{\n\timport edge_gate\n/gm)).toHaveLength(4);
    // The snippet is carried over as it is. Its matcher reads the client address, which this copy takes from the CDN's header.
    expect(out).toContain('(edge_gate) {\n\timport /etc/caddy/edge/closed.caddy*\n}\n');
    expect(out).toMatch(/\tclient_ip_headers CF-Connecting-IP\n/);
    const dir = await tempDir();
    const original = read('deploy/Caddyfile');
    const cases: [string, string][] = [
      ['an import removed from one host', original.replace('{$API_HOST} {\n\timport edge_gate\n', '{$API_HOST} {\n')],
      [
        'an import that is not the first line',
        original.replace(
          '{$SHOP_HOST} {\n\timport edge_gate\n\timport common\n',
          '{$SHOP_HOST} {\n\timport common\n\timport edge_gate\n',
        ),
      ],
      ['the snippet removed', original.replace('(edge_gate) {', '(edge_gate_gone) {')],
    ];
    for (const [name, text] of cases) {
      expect(text, name).not.toBe(original);
      await writeFile(join(dir, 'Caddyfile'), text);
      const result = await edge([...usual, '--input', join(dir, 'Caddyfile')]);
      expect(result.code, name).toBe(1);
      expect(result.stdout, name).toBe('');
      expect(result.stderr, name).toContain("must start with 'import edge_gate'");
      // The input is named: the failure is found before the copy is built.
      expect(result.stderr, name).toContain(join(dir, 'Caddyfile'));
    }
  });
});

describe('deploy/cd shell scripts', () => {
  it('parse', async () => {
    expect((await run(['bash', '-n', 'deploy/cd/auto-deploy.sh'])).code).toBe(0);
    expect((await run(['bash', '-n', 'deploy/cd/edge-gate.sh'])).code).toBe(0);
    expect((await run(['sh', '-n', 'deploy/cd/origin-firewall.sh'])).code).toBe(0);
  });

  it('installs the edge gate from the repository on every server, and refreshes it when it changed (the closed edge)', () => {
    const script = read('deploy/cd/auto-deploy.sh');
    const start = script.indexOf('install_self() {');
    const body = script.slice(start, script.indexOf('\n}\n', start));
    expect(body).toContain('if [ -f "$source/edge-gate.sh" ]; then');
    expect(body).toContain(
      'cmp -s "$source/edge-gate.sh" /usr/local/sbin/gsm-edge-gate || install -m 0750 "$source/edge-gate.sh" /usr/local/sbin/gsm-edge-gate || true',
    );
    // Unlike the backup script, no earlier install is needed: a release that needs the gate finds it there.
    expect(body).not.toContain('[ -e /usr/local/sbin/gsm-edge-gate ]');
    // `install` keeps the mode of the checkout's file, so it must be executable there.
    expect(statSync(join(ROOT, 'deploy/cd/edge-gate.sh')).mode & 0o111).not.toBe(0);
  });

  it('writes the file the Caddyfile reads: the folder the compose file mounts, and a name the Caddyfile glob matches', () => {
    const script = read('deploy/cd/edge-gate.sh');
    expect(script).toContain('SEEN_DIR=/etc/caddy/edge');
    expect(script).toContain('GATE_FILE=$EDGE_DIR/closed.caddy');
    expect(script).toContain('EDGE_DIR=${EDGE_DIR:-$ROOT/edge}');
    expect(read('deploy/compose.prod.yaml')).toContain('- ../../edge:/etc/caddy/edge:ro');
    const glob = /^\s*import (\/etc\/caddy\/edge\/\S+\*)$/m.exec(read('deploy/Caddyfile'))?.[1] ?? '';
    const prefix = glob.slice(0, -1);
    expect('/etc/caddy/edge/closed.caddy'.startsWith(prefix)).toBe(true);
    // The temporary name the script writes first is never read by Caddy.
    expect('/etc/caddy/edge/.closed.caddy.new'.startsWith(prefix)).toBe(false);
    expect(script).toContain('local temporary=$EDGE_DIR/.closed.caddy.new');
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

describe('deploy/cd/edge-gate.sh', () => {
  /**
   * A stand-in for docker: it answers only "docker compose ... exec -T caddy <command>", from files in the test's folder, and writes
   * each command to the file "calls". The folder "edge" of the same test folder is what Caddy's container sees at /etc/caddy/edge.
   */
  const STUB = [
    '#!/usr/bin/bash',
    'dir=${0%/bin/docker}',
    'args=("$@")',
    'for i in "${!args[@]}"; do',
    '  if [ "${args[$i]}" = exec ]; then shift "$i"; shift 3; break; fi',
    'done',
    'echo "$*" >> "$dir/calls"',
    'case "$1 $2" in',
    '  "test -d") [ ! -e "$dir/no-mount" ] ;;',
    '  "test -f" | "test -e") [ -e "$dir/edge/closed.caddy" ] ;;',
    '  "grep -c")',
    '    case "$*" in',
    '      *import*) cat "$dir/gated" 2>/dev/null || echo 4 ;;',
    '      *) cat "$dir/hosts" 2>/dev/null || echo 4 ;;',
    '    esac',
    '    ;;',
    '  "caddy validate") if [ -e "$dir/validate-fails" ]; then echo "Error: invalid"; exit 1; fi ;;',
    '  "caddy reload")',
    '    if [ -e "$dir/reload-fails" ]; then echo "Error: reload"; exit 1; fi',
    '    if [ -e "$dir/reload-ignored" ]; then exit 0; fi',
    '    if [ -e "$dir/edge/closed.caddy" ]; then echo 4 > "$dir/running"; else echo 0 > "$dir/running"; fi',
    '    ;;',
    '  "sh -c")',
    '    if [ -e "$dir/no-admin" ]; then exit 1; fi',
    '    cat "$dir/running" 2>/dev/null || echo 0',
    '    ;;',
    'esac',
    '',
  ].join('\n');

  /** A server of its own: settings file, a folder for the gate, and the stand-in for docker first in the path. */
  async function rig() {
    const dir = await tempDir();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    for (const tool of ['bash', 'python3', 'cat', 'rm', 'cp', 'mv', 'mkdir', 'date', 'sed', 'chmod', 'mktemp']) {
      await symlink(`/usr/bin/${tool}`, join(bin, tool)).catch(() => undefined);
    }
    await writeFile(join(bin, 'docker'), STUB);
    await chmod(join(bin, 'docker'), 0o755);
    await mkdir(join(dir, 'root', 'backend'), { recursive: true });
    const edge = join(dir, 'edge');
    await mkdir(edge);
    await writeFile(join(dir, 'deploy.conf'), `ROOT=${join(dir, 'root')}\nEDGE_DIR=${edge}\n`);
    const env = { PATH: bin, HOME: tmpdir(), GSM_DEPLOY_CONF: join(dir, 'deploy.conf') };
    return {
      dir,
      edge,
      closed: join(edge, 'closed.caddy'),
      gate: (...args: string[]) => run(['/usr/bin/bash', 'deploy/cd/edge-gate.sh', ...args], { env }),
      calls: async () =>
        (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).split('\n').filter((line) => line !== ''),
      set: (name: string, content = '') => writeFile(join(dir, name), content),
      files: () => readdir(edge),
    };
  }

  it('refuses a missing or malformed address, an unknown command and extra words, before it touches the folder or Caddy', async () => {
    const server = await rig();
    const cases: string[][] = [
      [],
      ['fly'],
      ['close'],
      ['close', ''],
      ['close', 'not-an-address'],
      ['close', 'example.com'],
      ['close', '203.0.113'],
      ['close', '203.0.113.7/32'],
      ['close', '10.0.0.0/8'],
      ['close', '203.0.113.7 198.51.100.1'],
      ['close', '203.0.113.7', '198.51.100.1'],
      ['close', '0.0.0.0'],
      ['close', '::'],
      ['close', '224.0.0.1'],
      ['close', 'fe80::1%eth0'],
      ['close', '::ffff:203.0.113.7'],
      ['close', '203.0.113.7\nrespond 200'],
      ['close', '203.0.113.7}'],
      ['open', 'now'],
      ['status', 'now'],
    ];
    for (const args of cases) {
      const result = await server.gate(...args);
      expect(result.code, JSON.stringify(args)).toBe(2);
      expect(result.stdout, JSON.stringify(args)).not.toContain('closed:');
    }
    expect(await server.calls()).toEqual([]);
    expect(await server.files()).toEqual([]);
  });

  it('closes: writes one file that names the operator address and the problem+json answer, has Caddy check it, then load it, then reads what runs', async () => {
    const server = await rig();
    const result = await server.gate('close', '203.0.113.7');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('closed: all 4 public hosts answer 503 to every address but 203.0.113.7');
    const seen = await server.calls();
    const at = (prefix: string): number => seen.findIndex((call) => call.startsWith(prefix));
    const order = ['grep -c', 'test -f /etc/caddy/edge/closed.caddy', 'caddy validate', 'caddy reload', 'sh -c'].map(
      at,
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No temporary file is left in the folder Caddy reads.
    expect(await server.files()).toEqual(['closed.caddy']);

    const text = await readFile(server.closed, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    // The client address (which a CDN copy takes from the CDN's header), never the connection's.
    expect(lines[0]).toBe('@edge_closed not client_ip 203.0.113.7');
    expect(text).not.toContain('remote_ip');
    expect(lines[1]).toBe('handle @edge_closed {');
    expect(lines.at(-1)).toBe('}');
    expect(lines).toContain(`\theader Content-Type "${PROBLEM_CONTENT_TYPE}"`);
    expect(lines).toContain('\theader Cache-Control "no-store"');
    const body = /\trespond `(\{.*\})` 503$/m.exec(text)?.[1] ?? '';
    const problem = JSON.parse(body.replace('{http.request.uuid}', 'a-request-id')) as Record<string, unknown>;
    expect(problem).toMatchObject({ type: 'about:blank', status: 503, code: 'EDGE_CLOSED', requestId: 'a-request-id' });
    expect(typeof problem.title).toBe('string');
    expect(typeof problem.detail).toBe('string');
    // The members of the API's own problem document, and nothing else.
    expect(Object.keys(problem).sort()).toEqual(['code', 'detail', 'requestId', 'status', 'title', 'type']);

    const status = await server.gate('status');
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('the folder: closed to every address but 203.0.113.7');
    expect(status.stdout).toContain('Caddy runs: closed on 4 hosts');
  });

  it('writes an IPv6 address in its short form, and replaces the operator address when closed again', async () => {
    const server = await rig();
    expect((await server.gate('close', '2001:DB8:0:0:0:0:0:1')).code).toBe(0);
    expect(await readFile(server.closed, 'utf8')).toContain('\n@edge_closed not client_ip 2001:db8::1\n');
    expect((await server.gate('close', '203.0.113.7')).code).toBe(0);
    const text = await readFile(server.closed, 'utf8');
    expect(text.match(/not client_ip/g)).toHaveLength(1);
    expect(text).toContain('not client_ip 203.0.113.7\n');
    expect(await server.files()).toEqual(['closed.caddy']);
  });

  it('opens: removes the file and tells Caddy, also when the file was already gone', async () => {
    const server = await rig();
    await server.gate('close', '203.0.113.7');
    const opened = await server.gate('open');
    expect(opened.code, opened.stderr).toBe(0);
    expect(opened.stdout).toContain('open: every address reaches the public hosts');
    expect(await server.files()).toEqual([]);
    expect((await server.gate('status')).stdout).toContain('Caddy runs: open');

    // A file removed by hand leaves Caddy running the closed form: the status shows it, and "open" puts it right.
    await server.gate('close', '203.0.113.7');
    await rm(server.closed);
    const odd = await server.gate('status');
    expect(odd.stdout).toContain('the folder: open');
    expect(odd.stdout).toContain('Caddy runs: closed on 4 hosts');
    const reloads = (await server.calls()).filter((call) => call.startsWith('caddy reload')).length;
    expect((await server.gate('open')).code).toBe(0);
    expect((await server.calls()).filter((call) => call.startsWith('caddy reload')).length).toBe(reloads + 1);
    expect((await server.gate('status')).stdout).toContain('Caddy runs: open');
  });

  it('leaves the folder as it was when Caddy refuses the Caddyfile or the load, closing or opening', async () => {
    // Closing for the first time: no file is left, and a refused check never gets as far as the load.
    let server = await rig();
    await server.set('validate-fails');
    let result = await server.gate('close', '203.0.113.7');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nothing was loaded and the folder is as it was');
    expect(await server.files()).toEqual([]);
    expect((await server.calls()).some((call) => call.startsWith('caddy reload'))).toBe(false);

    server = await rig();
    await server.set('reload-fails');
    result = await server.gate('close', '203.0.113.7');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('it keeps what it ran');
    expect(await server.files()).toEqual([]);

    // Closed for one address, a change refused: the first file stays, byte for byte.
    server = await rig();
    await server.gate('close', '203.0.113.7');
    const before = await readFile(server.closed, 'utf8');
    await server.set('validate-fails');
    result = await server.gate('close', '198.51.100.1');
    expect(result.code).toBe(1);
    expect(await readFile(server.closed, 'utf8')).toBe(before);
    result = await server.gate('open');
    expect(result.code).toBe(1);
    expect(await readFile(server.closed, 'utf8')).toBe(before);
    await rm(join(server.dir, 'validate-fails'));
    await server.set('reload-fails');
    result = await server.gate('open');
    expect(result.code).toBe(1);
    expect(await readFile(server.closed, 'utf8')).toBe(before);
    expect(await server.files()).toEqual(['closed.caddy']);
  });

  it('refuses when Caddy does not mount the folder or runs a Caddyfile that lacks the gate on a host, and says nothing was changed', async () => {
    let server = await rig();
    await server.set('no-mount');
    for (const args of [['close', '203.0.113.7'], ['open']]) {
      const result = await server.gate(...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('does not mount the folder /etc/caddy/edge');
    }
    expect(await server.files()).toEqual([]);

    for (const [hosts, gated] of [
      ['4', '3'],
      ['4', '0'],
      ['0', '0'],
    ] as const) {
      server = await rig();
      await server.set('hosts', hosts);
      await server.set('gated', gated);
      const result = await server.gate('close', '203.0.113.7');
      expect(result.code, `${gated} of ${hosts}`).toBe(1);
      expect(result.stderr).toContain(`does not import the gate on every host (${gated} of ${hosts})`);
      expect(await server.files()).toEqual([]);
      // Neither the check nor the load was asked for.
      expect((await server.calls()).some((call) => call.startsWith('caddy '))).toBe(false);
    }
  });

  it('refuses while the folder holds another file that starts with the name Caddy reads, and never reads a hidden temporary name as one', async () => {
    const server = await rig();
    const stray = join(server.edge, 'closed.caddy.bak');
    await writeFile(stray, '');
    for (const args of [['close', '203.0.113.7'], ['open'], ['status']]) {
      const result = await server.gate(...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('would be read by Caddy as well');
    }
    expect(await server.calls()).toEqual([]);
    await rm(stray);
    // A temporary name left by an interrupted run starts with a dot: Caddy's glob does not match it, and the next run replaces it.
    await writeFile(join(server.edge, '.closed.caddy.new'), 'left over');
    expect((await server.gate('close', '203.0.113.7')).code).toBe(0);
    expect(await server.files()).toEqual(['closed.caddy']);
  });

  it('fails, and says so, when Caddy loads its Caddyfile but does not run the gate on every host, or cannot be asked', async () => {
    let server = await rig();
    await server.set('reload-ignored');
    let result = await server.gate('close', '203.0.113.7');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the gate runs on 0 hosts, not 4');

    server = await rig();
    await server.set('no-admin');
    result = await server.gate('close', '203.0.113.7');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('its running configuration cannot be read');
    const status = await server.gate('status');
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Caddy: its running configuration cannot be read');
  });

  it('status says what the folder holds and what Caddy runs, and refuses a file that names no single address', async () => {
    const server = await rig();
    const open = await server.gate('status');
    expect(open.code, open.stderr).toBe(0);
    expect(open.stdout).toContain('the folder: open');
    expect(open.stdout).toContain('Caddy runs: open');
    await writeFile(server.closed, '# nothing here\n@edge_closed not client_ip 10.0.0.0/8\n');
    const bad = await server.gate('status');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('does not name one address');
    await writeFile(server.closed, 'garbage\n');
    expect((await server.gate('status')).code).toBe(1);
  });

  it('needs its settings file and a ROOT in it', async () => {
    const dir = await tempDir();
    const env = { PATH: '/usr/bin:/bin', HOME: tmpdir() };
    const missing = await run(['bash', 'deploy/cd/edge-gate.sh', 'status'], {
      env: { ...env, GSM_DEPLOY_CONF: join(dir, 'none.conf') },
    });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read');
    await writeFile(join(dir, 'empty.conf'), '# nothing\n');
    const empty = await run(['bash', 'deploy/cd/edge-gate.sh', 'status'], {
      env: { ...env, GSM_DEPLOY_CONF: join(dir, 'empty.conf') },
    });
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('set ROOT');
  });
});
