// Runs of the host side of the backups (decision 059): deploy/backup/gsm-backup.sh with stub docker, curl, age, systemctl, shred,
// install and hostname on PATH (test/tooling/fixtures/backup-host), deploy/backup/r2-bucket-rules.sh with a stub curl, and static
// checks of the systemd units. Nothing reaches a bucket, a mail server or Cloudflare. Why it matters: these files decide whether a night
// without a backup is noticed and whether a stolen server key can destroy the past copies, and nothing else runs them before the server.
import { afterAll, describe, expect, it } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'deploy/backup/gsm-backup.sh');
const RULES = join(ROOT, 'deploy/backup/r2-bucket-rules.sh');
const FIXTURES = join(import.meta.dir, 'fixtures/backup-host');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const which = (tool: string): string | null => Bun.which(tool, { PATH: '/usr/bin:/bin' });
const BASH = which('bash') ?? '/bin/bash';
const FLOCK = which('flock') ?? '/usr/bin/flock';
const text = (path: string): Promise<string> => Bun.file(path).text();

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-backup-host-'));
  dirs.push(dir);
  return dir;
};

/** Runs a command and returns its exit code and output. */
async function run(command: string[], options: { env?: Record<string, string> } = {}) {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: options.env ?? { PATH: '/usr/bin:/bin', HOME: tmpdir() },
    stdin: 'ignore',
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

/** The real tools the scripts and the stubs use. They are linked into a folder that is the whole PATH, so no real docker, age or curl is found. */
const TOOLS = [
  'bash',
  'base64',
  'cat',
  'chmod',
  'cp',
  'cut',
  'date',
  'env',
  'find',
  'flock',
  'grep',
  'gzip',
  'head',
  'mkdir',
  'mktemp',
  'mv',
  'python3',
  'rm',
  'sed',
  'sleep',
  'sort',
  'stat',
  'tail',
  'tar',
  'tee',
  'tr',
];

/** Makes the PATH folder of a run: the real tools above and the named stubs of test/tooling/fixtures/backup-host. */
async function toolFolder(dir: string, stubs: Record<string, string>): Promise<string> {
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const tool of TOOLS) {
    const real = which(tool);
    if (real) await symlink(real, join(bin, tool));
  }
  for (const [name, fixture] of Object.entries(stubs)) {
    // A stub may take the place of a linked tool: remove the link first, or the copy would write through it.
    await rm(join(bin, name), { force: true });
    await copyFile(join(FIXTURES, fixture), join(bin, name));
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

const HOST_STUBS: Record<string, string> = {
  docker: 'docker.sh',
  age: 'age.sh',
  curl: 'curl.sh',
  install: 'install.sh',
  shred: 'shred.sh',
  systemctl: 'systemctl.sh',
  hostname: 'hostname.sh',
};
const NOW = '2026-11-10T01:15:00Z';
const MORNING = '2026-11-10T07:30:00Z';
const DUMP = 'gsm-20261110T011500Z.dump.age';
const CONFIG_NAME = 'gsm-config-20261110T011500Z.tar.gz.age';
const RECIPIENT = 'age1examplerecipientforthetestsonly0000000000000000000000000';
const SMTP_PASSWORD = 's3cret-smtp-pass';
const MARKER = 'plaintext-marker-of-the-configuration';

interface Host {
  dir: string;
  root: string;
  state: string;
  conf: string;
  env: Record<string, string>;
}

/** A server made for one test: a backend checkout with its two env files, the settings file, the stubs, and no state yet. */
async function makeHost(
  options: {
    conf?: (host: { dir: string; root: string; state: string }) => string;
    env?: string;
    production?: string;
    stubs?: Record<string, string>;
  } = {},
): Promise<Host> {
  const dir = await tempDir();
  const root = join(dir, 'opt');
  const state = join(dir, 'state');
  await mkdir(join(root, 'backend/deploy'), { recursive: true });
  await mkdir(join(root, 'server'), { recursive: true });
  await writeFile(join(root, 'backend/deploy/compose.prod.yaml'), 'services: {}\n');
  await writeFile(
    join(root, 'backend/deploy/.env'),
    options.env ??
      `POSTGRES_PASSWORD=${MARKER}\nBACKUP_S3_BUCKET=gsm-backups\nBACKUP_AGE_RECIPIENT=${RECIPIENT}   # "age1..." from age-keygen\n`,
  );
  await writeFile(
    join(root, 'backend/.env.production'),
    options.production ??
      `ENCRYPTION_KEYS=k1:${MARKER}\nMAIL_SMTP_URL=smtps://mailer:${SMTP_PASSWORD}@smtp.example.com:465   # a secret\nMAIL_FROM=GSM <noreply@example.com>\n`,
  );
  await writeFile(join(root, 'server/Caddyfile'), `# ${MARKER}\n`);
  await writeFile(join(dir, 'gsm-deploy.conf'), `ROOT=${root}\n`);
  const conf = join(dir, 'gsm-backup.conf');
  await writeFile(
    conf,
    options.conf?.({ dir, root, state }) ??
      `ROOT=${root}\nSTATE=${state}\nALERT_EMAIL=ops@example.com\nHEARTBEAT_URL=https://hc.example.com/ping/abc-123\n`,
  );
  const bin = await toolFolder(dir, options.stubs ?? HOST_STUBS);
  const env = {
    PATH: bin,
    HOME: dir,
    STUB_DIR: dir,
    GSM_BACKUP_CONF: conf,
    GSM_DEPLOY_CONF: join(dir, 'gsm-deploy.conf'),
    GSM_BACKUP_NOW: NOW,
    // A busy lock is reported at once (the script waits five seconds by default).
    GSM_BACKUP_LOCK_WAIT: '0',
  };
  return { dir, root, state, conf, env };
}

/** What the stubs recorded of the last run: every call, and each curl call with its arguments, its config and the mail it sent. */
async function recorded(host: Host) {
  const prefix = `docker compose -f ${host.root}/backend/deploy/compose.prod.yaml --env-file ${host.root}/backend/deploy/.env `;
  const calls = (await text(join(host.dir, 'calls.log')).catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((call) => (call.startsWith(prefix) ? `compose ${call.slice(prefix.length)}` : call));
  const count = Number((await text(join(host.dir, 'curl-count')).catch(() => '0')).trim());
  const curls: { args: string[]; config: string; mail: string | null }[] = [];
  for (let n = 1; n <= count; n++) {
    curls.push({
      args: (await text(join(host.dir, `curl-${n}.args`))).split('\n').filter(Boolean),
      config: await text(join(host.dir, `curl-${n}.config`)),
      mail: await text(join(host.dir, `curl-${n}.mail`)).catch(() => null),
    });
  }
  return { calls, curls };
}

/** Runs gsm-backup.sh on a host, after clearing what the stubs recorded before. */
async function backup(host: Host, args: string[], env: Record<string, string> = {}) {
  for (const name of await readdir(host.dir)) {
    if (/^(calls\.log|curl-|config-received|key-|docker\.pid)/.test(name))
      await rm(join(host.dir, name), { force: true });
  }
  const result = await run([BASH, SCRIPT, ...args], { env: { ...host.env, ...env } });
  return { ...result, ...(await recorded(host)) };
}

const stateFile = (host: Host, name: string): Promise<string> => text(join(host.state, name));

/** Holds a lock file from another process until it is killed; resolves once the lock is taken. */
async function holdLock(lock: string) {
  // The holder becomes the sleep itself, so killing it frees the lock and leaves no process behind.
  const holder = Bun.spawn(
    [BASH, '-c', 'exec 9>"$1"; "$2" 9; exec "$3" 20', 'holder', lock, FLOCK, which('sleep') ?? '/bin/sleep'],
    {
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  for (let i = 0; i < 100 && (await run([FLOCK, '-n', lock, 'true'])).code === 0; i++) await Bun.sleep(50);
  return holder;
}

/** Starts gsm-backup with a step that waits (a STUB_*_SLEEP variable) and returns once that step runs, with both process ids. */
async function startWaiting(
  host: Host,
  args: string[],
  env: Record<string, string>,
  output: 'pipe' | 'ignore' = 'pipe',
) {
  for (const name of await readdir(host.dir)) {
    if (/^(calls\.log|curl-|config-received|key-|docker\.pid)/.test(name))
      await rm(join(host.dir, name), { force: true });
  }
  const child = Bun.spawn([BASH, SCRIPT, ...args], { env: { ...host.env, ...env }, stdout: output, stderr: output });
  const pidFile = join(host.dir, 'docker.pid');
  let stepPid = 0;
  for (let i = 0; i < 400 && !stepPid; i++) {
    await Bun.sleep(25);
    stepPid = Number((await text(pidFile).catch(() => '')).trim());
  }
  return { child, stepPid };
}

/** The archive the container received, opened from the age stub's base64. */
async function receivedArchive(host: Host): Promise<string> {
  const encoded = (await text(join(host.dir, 'config-received'))).split('\n')[1] ?? '';
  const archive = join(host.dir, 'config.tar.gz');
  await writeFile(archive, Buffer.from(encoded, 'base64'));
  return archive;
}

describe('gsm-backup run', () => {
  it("runs the four steps in order, records the run, keeps its log and calls the heartbeat with the address in curl's config only", async () => {
    const host = await makeHost();
    const result = await backup(host, ['run']);
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => /^(compose |age -r )/.test(call))).toEqual([
      'compose build backup',
      'compose run --rm -T backup pg-backup.sh',
      'compose run --rm -T backup files-mirror.sh',
      `age -r ${RECIPIENT}`,
      `compose run --rm -T backup config-copy.sh ${CONFIG_NAME}`,
    ]);
    for (const step of ['image', 'database', 'files', 'config']) expect(result.stdout).toContain(`${step}: ok`);
    const lastRun = await stateFile(host, 'last-run');
    expect(lastRun).toMatch(
      /^at=2026-11-10T01:15:00Z\nresult=ok\nfailed_steps=\ndump=gsm-20261110T011500Z\.dump\.age\nseconds=\d+\n$/,
    );
    expect(await stateFile(host, 'last-success')).toBe(lastRun);
    const log = await stateFile(host, 'log/run-20261110T011500Z.log');
    for (const step of ['image', 'database', 'files', 'config'])
      expect(log).toMatch(new RegExp(`^== \\S+ ${step}$`, 'm'));
    expect(log).toContain(`"msg":"backup ${DUMP} complete"`);
    // One curl call, the heartbeat: its address is in the config on standard input, never in the arguments.
    expect(result.curls).toHaveLength(1);
    expect(result.curls[0]?.config).toBe('url = "https://hc.example.com/ping/abc-123"\n');
    expect(result.curls[0]?.args.join(' ')).not.toContain('hc.example.com');
    expect(result.curls[0]?.mail).toBeNull();
    expect(result.stderr).not.toContain('ALERT');
    // umask 077: the state and its files are root's alone.
    expect((await stat(host.state)).mode & 0o777).toBe(0o700);
    expect((await stat(join(host.state, 'last-run'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(host.state, 'log/run-20261110T011500Z.log'))).mode & 0o777).toBe(0o600);
  });

  it('encrypts the configuration on the host before the container starts, and the container gets an age file only', async () => {
    const host = await makeHost();
    const result = await backup(host, ['run']);
    expect(result.code).toBe(0);
    // age has finished before the container that stores the copy is started.
    expect(result.calls.indexOf('age finished')).toBeGreaterThan(-1);
    expect(result.calls.indexOf('age finished')).toBeLessThan(
      result.calls.indexOf(`compose run --rm -T backup config-copy.sh ${CONFIG_NAME}`),
    );
    const received = await text(join(host.dir, 'config-received'));
    const [first, encoded] = received.split('\n');
    expect(first).toBe('age-encryption.org/v1');
    expect(received).not.toContain(MARKER);
    // The stub's "encryption" is base64: open it and read the archive's members.
    const archive = join(host.dir, 'config.tar.gz');
    await writeFile(archive, Buffer.from(encoded ?? '', 'base64'));
    const members = (await run(['tar', '-tzf', archive])).stdout.split('\n').filter(Boolean);
    const member = (path: string) => path.replace(/^\//, '');
    expect(members).toEqual(
      expect.arrayContaining([
        member(join(host.root, 'backend/deploy/.env')),
        member(join(host.root, 'backend/.env.production')),
        member(host.conf),
        member(join(host.dir, 'gsm-deploy.conf')),
        member(join(host.root, 'server/Caddyfile')),
      ]),
    );
  });

  it("keeps going after a failed step, records it and sends exactly one alert mail through the SMTP account, its credentials only in curl's config", async () => {
    const host = await makeHost();
    const result = await backup(host, ['run'], { STUB_DB_EXIT: '1' });
    expect(result.code).toBe(1);
    expect(result.calls).toContain('compose run --rm -T backup files-mirror.sh');
    expect(result.calls).toContain(`compose run --rm -T backup config-copy.sh ${CONFIG_NAME}`);
    expect(result.stdout).toContain('database: FAILED');
    expect(await stateFile(host, 'last-run')).toMatch(/\nresult=failed\nfailed_steps=database\ndump=\n/);
    expect(existsSync(join(host.state, 'last-success'))).toBe(false);
    // No heartbeat; one mail.
    expect(result.curls).toHaveLength(1);
    const mail = result.curls[0];
    expect(mail?.args[(mail?.args.indexOf('--mail-rcpt') ?? -2) + 1]).toBe('ops@example.com');
    expect(mail?.args[(mail?.args.indexOf('--mail-from') ?? -2) + 1]).toBe('noreply@example.com');
    expect(mail?.args).toEqual(expect.arrayContaining(['-m', '30', '-K', '-']));
    expect(mail?.args).not.toContain('--ssl-reqd');
    for (const secret of [SMTP_PASSWORD, 'mailer', 'smtp.example.com'])
      expect(mail?.args.join(' ')).not.toContain(secret);
    expect(mail?.config).toBe(`url = "smtps://mailer:${SMTP_PASSWORD}@smtp.example.com:465"\n`);
    expect(mail?.mail).toContain('From: GSM <noreply@example.com>\n');
    expect(mail?.mail).toContain('To: ops@example.com\n');
    expect(mail?.mail).toContain('Subject: [backup] backup-host: the nightly backup failed (database)\n');
    expect(mail?.mail).toContain(join(host.state, 'log/run-20261110T011500Z.log'));
    expect(mail?.mail).not.toContain(SMTP_PASSWORD);
    // One line in the journal, and no secret anywhere in the output.
    const alerts = result.stderr.split('\n').filter((line) => line.includes('ALERT'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('gsm-backup: ALERT [backup] backup-host: the nightly backup failed (database)');
    expect(result.stdout + result.stderr).not.toContain(SMTP_PASSWORD);
  });

  it('requires TLS on an smtp:// account and leaves out the mailer options after "?"', async () => {
    const host = await makeHost({
      production: `MAIL_SMTP_URL="smtp://mailer:${SMTP_PASSWORD}@smtp.example.com:587?pool=true"\nMAIL_FROM=noreply@example.com\n`,
    });
    const result = await backup(host, ['run'], { STUB_FILES_EXIT: '1' });
    expect(result.code).toBe(1);
    expect(result.curls).toHaveLength(1);
    expect(result.curls[0]?.args).toContain('--ssl-reqd');
    expect(result.curls[0]?.config).toBe(`url = "smtp://mailer:${SMTP_PASSWORD}@smtp.example.com:587"\n`);
    expect(result.curls[0]?.args[(result.curls[0]?.args.indexOf('--mail-from') ?? -2) + 1]).toBe('noreply@example.com');
  });

  it('writes a mail that cannot be sent as a line in the log, and keeps the exit code', async () => {
    const host = await makeHost();
    const result = await backup(host, ['run'], { STUB_DB_EXIT: '1', STUB_CURL_EXIT: '67' });
    expect(result.code).toBe(1);
    expect(result.curls).toHaveLength(1);
    expect(await stateFile(host, 'log/run-20261110T011500Z.log')).toContain(
      'the alert mail could not be sent: curl: (67) Login denied',
    );
  });

  it('fails the configuration step, and sends the container nothing, without a recipient, without age, or when age fails', async () => {
    const cases: [string, Parameters<typeof makeHost>[0], Record<string, string>, string][] = [
      ['no recipient', { env: 'BACKUP_S3_BUCKET=gsm-backups\n' }, {}, 'BACKUP_AGE_RECIPIENT is not set'],
      [
        'a placeholder',
        { env: 'BACKUP_AGE_RECIPIENT=CHANGE_ME_AGE_PUBLIC_KEY\n' },
        {},
        'BACKUP_AGE_RECIPIENT is not set',
      ],
      [
        'no age',
        { stubs: Object.fromEntries(Object.entries(HOST_STUBS).filter(([name]) => name !== 'age')) },
        {},
        'age is not installed on this server',
      ],
      ['age fails', {}, { STUB_AGE_EXIT: '1' }, 'packing or encrypting the configuration failed: nothing was copied'],
    ];
    for (const [label, options, env, message] of cases) {
      const host = await makeHost(options);
      const result = await backup(host, ['run'], env);
      expect(result.code, label).toBe(1);
      expect(await stateFile(host, 'last-run'), label).toContain('\nfailed_steps=config\n');
      expect(await stateFile(host, 'log/run-20261110T011500Z.log'), label).toContain(message);
      expect(
        result.calls.some((call) => call.includes('config-copy.sh')),
        label,
      ).toBe(false);
      expect(existsSync(join(host.dir, 'config-received')), label).toBe(false);
      // The other steps ran.
      expect(result.calls, label).toContain('compose run --rm -T backup pg-backup.sh');
      expect(
        result.curls.filter((call) => call.mail !== null),
        label,
      ).toHaveLength(1);
    }
  });

  it('takes a failed image build as a warning while an image exists, and as a failed step when none does', async () => {
    const host = await makeHost();
    const warned = await backup(host, ['run'], { STUB_BUILD_EXIT: '1' });
    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain('warning: the backup image was not rebuilt');
    expect(warned.calls).toContain('docker image inspect gsm-backup:local');
    const failed = await backup(host, ['run'], { STUB_BUILD_EXIT: '1', STUB_IMAGE_EXISTS: '0' });
    expect(failed.code).toBe(1);
    expect(await stateFile(host, 'last-run')).toContain('\nfailed_steps=image\n');
    expect(failed.calls).toContain('compose run --rm -T backup pg-backup.sh');
  });

  it('copies CONFIG_PATHS instead of the default list and skips a path that does not exist; passes COMPOSE_OVERRIDE to compose', async () => {
    const host = await makeHost({
      conf: ({ dir, root, state }) =>
        `ROOT=${root}\nSTATE=${state}\nCOMPOSE_OVERRIDE=${root}/server/override.yaml\nCONFIG_PATHS="${root}/server ${dir}/missing"\n`,
    });
    await writeFile(join(host.root, 'server/override.yaml'), 'services: {}\n');
    const result = await backup(host, ['run']);
    expect(result.code).toBe(0);
    expect(await stateFile(host, 'log/run-20261110T011500Z.log')).toContain(
      `not in the copy (it does not exist): ${host.dir}/missing`,
    );
    const encoded = (await text(join(host.dir, 'config-received'))).split('\n')[1] ?? '';
    const archive = join(host.dir, 'config.tar.gz');
    await writeFile(archive, Buffer.from(encoded, 'base64'));
    const members = (await run(['tar', '-tzf', archive])).stdout.split('\n').filter(Boolean);
    expect(members.filter((name) => !name.endsWith('/')).sort()).toEqual([
      join(host.root, 'server/Caddyfile').slice(1),
      join(host.root, 'server/override.yaml').slice(1),
    ]);
    const override = `-f ${host.root}/backend/deploy/compose.prod.yaml -f ${host.root}/server/override.yaml --env-file`;
    expect(
      result.calls.filter((call) => call.startsWith('docker compose ')).every((call) => call.includes(override)),
    ).toBe(true);
    // No ALERT_EMAIL and no HEARTBEAT_URL: no curl at all.
    expect(result.curls).toEqual([]);
  });

  it('waits a moment for a lock that is only held for an instant (the morning check looks whether a run is going on)', async () => {
    const host = await makeHost();
    await mkdir(host.state, { recursive: true });
    const holder = await holdLock(join(host.state, 'lock'));
    setTimeout(() => holder.kill(), 400);
    const result = await backup(host, ['run'], { GSM_BACKUP_LOCK_WAIT: '5' });
    await holder.exited;
    expect(result.code).toBe(0);
    expect(result.calls).toContain('compose run --rm -T backup pg-backup.sh');
    expect(await stateFile(host, 'last-run')).toContain('result=ok');
  });

  it('exits 75 without an alert while another run holds the lock', async () => {
    const host = await makeHost();
    await mkdir(host.state, { recursive: true });
    const holder = await holdLock(join(host.state, 'lock'));
    const result = await backup(host, ['run'], { STUB_DB_EXIT: '1' });
    holder.kill();
    await holder.exited;
    expect(result.code).toBe(75);
    expect(result.stdout).toContain('another backup run is still going on');
    expect(result.calls).toEqual([]);
    expect(result.curls).toEqual([]);
    expect(result.stderr).not.toContain('ALERT');
  });

  it('records a run stopped by a signal as interrupted and sends one alert naming the step and the log, then exits 1', async () => {
    for (const [step, env] of [
      ['database', { STUB_DB_SLEEP: '30' }],
      ['config', { STUB_CONFIG_SLEEP: '30' }],
    ] as const) {
      const host = await makeHost();
      const { child, stepPid } = await startWaiting(host, ['run'], env);
      expect(stepPid, step).toBeGreaterThan(0);
      // Like systemctl stop: the script and the command of the step both get the signal.
      process.kill(child.pid, 'SIGTERM');
      process.kill(stepPid, 'SIGTERM');
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const { calls, curls } = await recorded(host);
      expect(code, step).toBe(1);
      expect(stdout, step).toContain(`THE BACKUP RUN WAS INTERRUPTED during the step ${step}`);
      expect(await stateFile(host, 'last-run'), step).toMatch(
        /^at=2026-11-10T01:15:00Z\nresult=failed\nfailed_steps=interrupted\ndump=\nseconds=\d+\n$/,
      );
      expect(existsSync(join(host.state, 'last-success')), step).toBe(false);
      expect(curls, step).toHaveLength(1);
      expect(curls[0]?.mail, step).toContain('Subject: [backup] backup-host: the nightly backup was interrupted\n');
      expect(curls[0]?.mail, step).toContain(`during the step ${step}`);
      expect(curls[0]?.mail, step).toContain(join(host.state, 'log/run-20261110T011500Z.log'));
      expect(
        stderr.split('\n').filter((line) => line.includes('ALERT')),
        step,
      ).toHaveLength(1);
      expect(await stateFile(host, 'log/run-20261110T011500Z.log'), step).toContain(
        `interrupted during the step ${step}`,
      );
      // No step runs after the signal, and the configuration's work folder is gone.
      if (step === 'database') expect(calls, step).not.toContain('compose run --rm -T backup files-mirror.sh');
      expect(
        (await readdir(host.state)).filter((name) => name.startsWith('config.')),
        step,
      ).toEqual([]);
    }
  });

  it('exits 75 only for a busy lock: a lock file that cannot be opened or a flock that fails is an error', async () => {
    const directory = await makeHost();
    await mkdir(join(directory.state, 'lock'), { recursive: true });
    const unopened = await backup(directory, ['run']);
    expect(unopened.code).toBe(1);
    expect(unopened.stderr).toContain(`gsm-backup: cannot open the lock file ${directory.state}/lock`);
    const broken = await makeHost({ stubs: { ...HOST_STUBS, flock: 'flock-broken.sh' } });
    const untaken = await backup(broken, ['run']);
    expect(untaken.code).toBe(1);
    expect(untaken.stderr).toContain('could not be taken (flock exit code 64)');
    for (const result of [unopened, untaken]) {
      expect(result.calls).toEqual([]);
      expect(result.curls).toEqual([]);
    }
    expect(existsSync(join(broken.state, 'last-run'))).toBe(false);
  });

  it('packs the content of a settings file that is a symbolic link, not the link', async () => {
    const host = await makeHost({
      conf: ({ dir, root, state }) => `ROOT=${root}\nSTATE=${state}\nCONFIG_PATHS="${dir}/linked.conf"\n`,
    });
    await mkdir(join(host.dir, 'real'));
    await writeFile(join(host.dir, 'real/settings.conf'), `SECRET=${MARKER}\n`);
    await symlink(join(host.dir, 'real/settings.conf'), join(host.dir, 'linked.conf'));
    expect((await backup(host, ['run'])).code).toBe(0);
    const archive = await receivedArchive(host);
    const member = join(host.dir, 'linked.conf').slice(1);
    const listing = (await run(['tar', '-tvzf', archive])).stdout.split('\n').filter(Boolean);
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatch(/^-/);
    expect(listing[0]).toContain(member);
    expect((await run(['tar', '-xzOf', archive, member])).stdout).toBe(`SECRET=${MARKER}\n`);
  });

  it('keeps the 60 newest run logs', async () => {
    const host = await makeHost();
    await mkdir(join(host.state, 'log'), { recursive: true });
    const day = 86_400_000;
    const old = Array.from({ length: 65 }, (_, i) => {
      const stamp = new Date(Date.parse(NOW) - (i + 1) * day).toISOString().replace(/[-:]/g, '').replace('.000', '');
      return `run-${stamp}.log`;
    });
    for (const name of old) await writeFile(join(host.state, 'log', name), 'old\n');
    expect((await backup(host, ['run'])).code).toBe(0);
    const left = (await readdir(join(host.state, 'log'))).filter((name) => name.startsWith('run-'));
    expect(left).toHaveLength(60);
    expect(left).toContain('run-20261110T011500Z.log');
    expect(left).toContain(old[58] ?? '');
    for (const gone of old.slice(59)) expect(left).not.toContain(gone);
  });
});

/** What offsite-status.sh prints for a bucket with a fresh dump. */
const FRESH: Record<string, string> = {
  daily_count: '3',
  daily_newest: DUMP,
  daily_newest_bytes: '1234',
  monthly_count: '1',
  monthly_newest: 'gsm-20261101T011500Z.dump.age',
  monthly_newest_bytes: '1200',
  config_count: '3',
  config_newest: CONFIG_NAME,
  config_newest_bytes: '900',
  files_count: '42',
};

/** A host whose bucket answers FRESH with the given changes, and whose last drill is recent unless told otherwise. */
async function checkedHost(
  changes: Record<string, string> = {},
  options: { drill?: string | null; lastRun?: string } = {},
) {
  const host = await makeHost();
  await mkdir(host.state, { recursive: true });
  const status = { ...FRESH, ...changes };
  await writeFile(
    join(host.dir, 'status'),
    Object.entries(status)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  const drill =
    options.drill === undefined ? 'at=2026-11-01T09:00:00Z\ndump=gsm-20261031T011500Z.dump.age\n' : options.drill;
  if (drill !== null) await writeFile(join(host.state, 'last-drill'), drill);
  if (options.lastRun) await writeFile(join(host.state, 'last-run'), options.lastRun);
  return host;
}

describe('gsm-backup check', () => {
  it('leaves a failed or interrupted last run alone while a run holds the lock, and reports an interruption once none does', async () => {
    const interrupted = 'at=2026-11-10T01:15:00Z\nresult=failed\nfailed_steps=interrupted\ndump=\nseconds=0\n';
    const host = await checkedHost({}, { lastRun: interrupted });
    const holder = await holdLock(join(host.state, 'lock'));
    const during = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    holder.kill();
    await holder.exited;
    expect(during.code).toBe(0);
    expect(during.stdout).toContain('a backup run is going on now');
    expect(during.curls).toEqual([]);
    const after = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(after.code).toBe(1);
    expect(after.curls).toHaveLength(1);
    expect(after.curls[0]?.mail).toContain('the last run, 2026-11-10T01:15:00Z, was interrupted before it finished');
  });

  it('finds the run that was killed without a chance to say so (SIGKILL): its last run says interrupted, and the check alerts', async () => {
    const host = await checkedHost();
    const { child, stepPid } = await startWaiting(host, ['run'], { STUB_DB_SLEEP: '30' }, 'ignore');
    expect(stepPid).toBeGreaterThan(0);
    process.kill(child.pid, 'SIGKILL');
    await child.exited;
    // The step's command still holds the lock it inherited; once it ends, no run is going on.
    process.kill(stepPid, 'SIGTERM');
    const lock = join(host.state, 'lock');
    for (let i = 0; i < 100 && (await run([FLOCK, '-n', lock, 'true'])).code !== 0; i++) await Bun.sleep(50);
    expect(await stateFile(host, 'last-run')).toBe(
      'at=2026-11-10T01:15:00Z\nresult=failed\nfailed_steps=interrupted\ndump=\nseconds=0\n',
    );
    expect((await recorded(host)).curls).toEqual([]);
    const check = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(check.code).toBe(1);
    expect(check.curls).toHaveLength(1);
    expect(check.curls[0]?.mail).toContain('the last run, 2026-11-10T01:15:00Z, was interrupted before it finished');
  });

  it('fails on a newest dump dated more than an hour in the future, which would never look old', async () => {
    const ahead = await backup(await checkedHost({ daily_newest: 'gsm-20261110T100000Z.dump.age' }), ['check'], {
      GSM_BACKUP_NOW: MORNING,
    });
    expect(ahead.code).toBe(1);
    expect(ahead.curls).toHaveLength(1);
    expect(ahead.curls[0]?.mail).toContain(
      "the newest daily dump, gsm-20261110T100000Z.dump.age, is dated in the future: check the server's clock",
    );
    const near = await backup(await checkedHost({ daily_newest: 'gsm-20261110T080000Z.dump.age' }), ['check'], {
      GSM_BACKUP_NOW: MORNING,
    });
    expect(near.code).toBe(0);
  });

  it('removes a copy of the private key left outside a drill and reports it, and leaves it alone while a drill holds its lock', async () => {
    for (const env of [{}, { STUB_SHRED_EXIT: '1' }] as Record<string, string>[]) {
      const host = await checkedHost();
      const copy = join(host.state, 'age.key.restore');
      await writeFile(copy, 'AGE-SECRET-KEY-1LEFTOVERFORTHETESTSONLY\n', { mode: 0o400 });
      const result = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING, ...env });
      expect(result.code).toBe(1);
      expect(result.calls).toContain(`shred -u ${copy}`);
      expect(existsSync(copy)).toBe(false);
      expect(result.curls).toHaveLength(1);
      expect(result.curls[0]?.mail).toContain('a copy of the private key was left on the server and has been removed');
    }
    const drilling = await checkedHost();
    const copy = join(drilling.state, 'age.key.restore');
    await writeFile(copy, 'AGE-SECRET-KEY-1INUSEFORTHETESTSONLY\n', { mode: 0o400 });
    const holder = await holdLock(join(drilling.state, 'drill.lock'));
    const during = await backup(drilling, ['check'], { GSM_BACKUP_NOW: MORNING });
    holder.kill();
    await holder.exited;
    expect(during.code).toBe(0);
    expect(existsSync(copy)).toBe(true);
    expect(during.curls).toEqual([]);
  });

  it('passes on a fresh dump and says what it found in one line, listing the bucket without starting the database', async () => {
    const host = await checkedHost();
    const result = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain(
      `check: ok: newest daily dump ${DUMP}, 1234 bytes, 6 hours old; 3 daily, 1 monthly, 3 configuration copies, 42 files`,
    );
    expect(result.calls).toContain('compose run --rm --no-deps -T backup offsite-status.sh');
    expect(result.curls).toEqual([]);
  });

  it('fails with exactly one alert when the newest dump is too old, missing, empty or undated, or the last run failed', async () => {
    const failedRun = 'at=2026-11-10T01:15:00Z\nresult=failed\nfailed_steps=files\ndump=\nseconds=40\n';
    const cases: [string, Record<string, string>, string | undefined, string][] = [
      ['stale', { daily_newest: 'gsm-20261108T011500Z.dump.age' }, undefined, 'is 54 hours old (more than 26)'],
      [
        'none',
        { daily_count: '0', daily_newest: '', daily_newest_bytes: '' },
        undefined,
        'there is no daily dump in the bucket',
      ],
      ['empty', { daily_newest_bytes: '0' }, undefined, `the newest daily dump, ${DUMP}, is empty`],
      ['undated', { daily_newest: 'gsm-latest.dump.age' }, undefined, 'carries no date'],
      ['last run', {}, failedRun, 'the last run, 2026-11-10T01:15:00Z, failed in: files'],
    ];
    for (const [label, changes, lastRun, reason] of cases) {
      const host = await checkedHost(changes, { lastRun });
      const result = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
      expect(result.code, label).toBe(1);
      expect(result.stdout, label).toContain('check: FAILED: ');
      expect(result.stdout, label).toContain(reason);
      expect(result.curls, label).toHaveLength(1);
      expect(result.curls[0]?.mail, label).toContain('Subject: [backup] backup-host: the backup check failed\n');
      expect(result.curls[0]?.mail, label).toContain(reason);
    }
  });

  it('sends one alert, not two, when the check fails while the drill is due too', async () => {
    const host = await checkedHost({ daily_newest: 'gsm-20261108T011500Z.dump.age' }, { drill: null });
    const result = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(result.code).toBe(1);
    expect(result.curls).toHaveLength(1);
    expect(result.curls[0]?.mail).toContain(
      'The restore drill is due too: no restore drill is recorded on this server.',
    );
  });

  it('fails with one alert when the bucket cannot be listed, or its answer cannot be read: never taken for an empty bucket', async () => {
    const failed = await checkedHost();
    const result = await backup(failed, ['check'], { GSM_BACKUP_NOW: MORNING, STUB_STATUS_EXIT: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ERROR : listing failed (stub)');
    expect(result.curls).toHaveLength(1);
    expect(result.curls[0]?.mail).toContain('Subject: [backup] backup-host: the offsite bucket could not be listed\n');
    const garbled = await checkedHost();
    await writeFile(join(garbled.dir, 'status'), 'hello\n');
    const unread = await backup(garbled, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(unread.code).toBe(1);
    expect(unread.curls).toHaveLength(1);
  });

  it('reminds of the restore drill when none is recorded or the last one is too old, and still succeeds', async () => {
    const never = await backup(await checkedHost({}, { drill: null }), ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(never.code).toBe(0);
    expect(never.curls).toHaveLength(1);
    expect(never.curls[0]?.mail).toContain('Subject: [backup] backup-host: restore drill due\n');
    expect(never.curls[0]?.mail).toContain('no restore drill is recorded on this server');
    const old = await checkedHost({}, { drill: 'at=2026-10-01T09:00:00Z\ndump=gsm-20260930T011500Z.dump.age\n' });
    const late = await backup(old, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(late.code).toBe(0);
    expect(late.curls[0]?.mail).toContain('the last restore drill was 39 days ago (2026-10-01T09:00:00Z)');
    // A mail that cannot be sent changes nothing.
    const unsent = await backup(old, ['check'], { GSM_BACKUP_NOW: MORNING, STUB_CURL_EXIT: '67' });
    expect(unsent.code).toBe(0);
    expect(unsent.stderr).toContain('the alert mail could not be sent');
  });

  it('waits DRILL_EVERY_DAYS before the reminder', async () => {
    const host = await checkedHost({}, { drill: 'at=2026-10-01T09:00:00Z\ndump=gsm-20260930T011500Z.dump.age\n' });
    await writeFile(
      host.conf,
      `ROOT=${host.root}\nSTATE=${host.state}\nALERT_EMAIL=ops@example.com\nDRILL_EVERY_DAYS=60\n`,
    );
    const result = await backup(host, ['check'], { GSM_BACKUP_NOW: MORNING });
    expect(result.code).toBe(0);
    expect(result.curls).toEqual([]);
  });
});

describe('gsm-backup status', () => {
  it("prints the last run, success and drill, the counts, the newest dump with its size and age, and the timers' next times", async () => {
    const lastRun = `at=2026-11-10T01:15:00Z\nresult=ok\nfailed_steps=\ndump=${DUMP}\nseconds=42\n`;
    const host = await checkedHost({}, { lastRun });
    await writeFile(join(host.state, 'last-success'), lastRun);
    const result = await backup(host, ['status'], { GSM_BACKUP_NOW: MORNING });
    expect(result.code).toBe(0);
    for (const line of [
      `last run:      2026-11-10T01:15:00Z, ok, 42 s, dump ${DUMP}`,
      `last success:  2026-11-10T01:15:00Z, ok, 42 s, dump ${DUMP}`,
      'last drill:    2026-11-01T09:00:00Z with gsm-20261031T011500Z.dump.age',
      'offsite:       3 daily, 1 monthly, 3 configuration copies, 42 files',
      `newest dump:   ${DUMP}, 1234 bytes, 6 hours old`,
      'gsm-backup:    next Wed 2026-11-11 01:21:33 UTC',
      'gsm-backup-check: next Wed 2026-11-11 07:30:00 UTC',
    ]) {
      expect(result.stdout).toContain(line);
    }
    expect(result.curls).toEqual([]);
  });

  it('prints a listing that fails instead of failing', async () => {
    const host = await checkedHost({}, { drill: null });
    const result = await backup(host, ['status'], { GSM_BACKUP_NOW: MORNING, STUB_STATUS_EXIT: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('last run:      never');
    expect(result.stdout).toContain('last drill:    never');
    expect(result.stdout).toContain('THE BUCKET COULD NOT BE LISTED');
    expect(result.curls).toEqual([]);
  });
});

describe('gsm-backup drill', () => {
  async function drillHost() {
    const host = await makeHost();
    const identity = join(host.dir, 'gsm-backup.agekey');
    await writeFile(identity, 'AGE-SECRET-KEY-1EXAMPLEFORTHETESTSONLY\n', { mode: 0o600 });
    return { host, identity, copy: join(host.state, 'age.key.restore') };
  }

  it('copies the key for the container (mode 0400, uid 10001), runs the drill, removes the copy and records the drill', async () => {
    const { host, identity, copy } = await drillHost();
    const result = await backup(host, ['drill', identity]);
    expect(result.code).toBe(0);
    const install = result.calls.indexOf(`install -m 0400 -o 10001 -g 10001 ${identity} ${copy}`);
    const drill = result.calls.indexOf(
      `compose run --rm -T -v ${copy}:/age.key:ro backup restore-drill.sh --identity /age.key`,
    );
    const shred = result.calls.indexOf(`shred -u ${copy}`);
    expect(install).toBeGreaterThan(-1);
    expect(drill).toBeGreaterThan(install);
    expect(shred).toBeGreaterThan(drill);
    expect(await text(join(host.dir, 'key-mode'))).toBe('400\n');
    expect(await text(join(host.dir, 'key-seen'))).toBe(await text(identity));
    expect(existsSync(copy)).toBe(false);
    expect(await stateFile(host, 'last-drill')).toBe('at=2026-11-10T01:15:00Z\ndump=gsm-20261109T011500Z.dump.age\n');
    expect(result.stdout).toContain('restore drill passed with gsm-20261109T011500Z.dump.age');
  });

  it('removes the copy and records nothing when the drill fails, and removes it without shred when shred fails', async () => {
    const failing = await drillHost();
    const failed = await backup(failing.host, ['drill', failing.identity], { STUB_DRILL_EXIT: '3' });
    expect(failed.code).toBe(3);
    expect(existsSync(failing.copy)).toBe(false);
    expect(existsSync(join(failing.host.state, 'last-drill'))).toBe(false);
    const noShred = await drillHost();
    const passed = await backup(noShred.host, ['drill', noShred.identity], { STUB_SHRED_EXIT: '1' });
    expect(passed.code).toBe(0);
    expect(passed.calls).toContain(`shred -u ${noShred.copy}`);
    expect(existsSync(noShred.copy)).toBe(false);
  });

  it('removes the copy when the drill is stopped by a signal', async () => {
    const { host, identity, copy } = await drillHost();
    const child = Bun.spawn([BASH, SCRIPT, 'drill', identity], {
      env: { ...host.env, STUB_DRILL_SLEEP: '30' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const pidFile = join(host.dir, 'docker.pid');
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(25);
    expect(existsSync(copy)).toBe(true);
    // Like a terminal that closes: the script and the container's command both get the signal.
    process.kill(child.pid, 'SIGTERM');
    process.kill(Number((await text(pidFile)).trim()), 'SIGTERM');
    expect(await child.exited).toBe(143);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(host.state, 'last-drill'))).toBe(false);
  });

  it('refuses a key file it cannot read, and stops when the copy cannot be made, running no drill', async () => {
    const { host, identity } = await drillHost();
    const missing = await backup(host, ['drill', join(host.dir, 'none.agekey')]);
    expect(missing.code).toBe(2);
    expect(missing.calls).toEqual([]);
    const refused = await backup(host, ['drill', identity], { STUB_INSTALL_EXIT: '1' });
    expect(refused.code).toBe(1);
    expect(refused.calls.some((call) => call.startsWith('compose '))).toBe(false);
  });
});

describe('gsm-backup settings', () => {
  it('stops with exit code 2 and a clear message on a wrong setting, before anything runs', async () => {
    const cases: [string, (host: { dir: string; root: string; state: string }) => string, string][] = [
      ['no ROOT', ({ state }) => `STATE=${state}\n`, 'set ROOT in '],
      [
        'no checkout',
        ({ dir, state }) => `ROOT=${dir}/nowhere\nSTATE=${state}\n`,
        'does not hold the backend checkout',
      ],
      ['relative STATE', ({ root }) => `ROOT=${root}\nSTATE=state\n`, 'STATE must be an absolute path'],
      [
        'MAX_AGE_HOURS',
        ({ root, state }) => `ROOT=${root}\nSTATE=${state}\nMAX_AGE_HOURS=soon\n`,
        'MAX_AGE_HOURS must be',
      ],
      [
        'DRILL_EVERY_DAYS',
        ({ root, state }) => `ROOT=${root}\nSTATE=${state}\nDRILL_EVERY_DAYS=0\n`,
        'DRILL_EVERY_DAYS must be',
      ],
      [
        'ALERT_EMAIL',
        ({ root, state }) => `ROOT=${root}\nSTATE=${state}\nALERT_EMAIL="ops at example"\n`,
        'ALERT_EMAIL must be one e-mail address',
      ],
      [
        'HEARTBEAT_URL',
        ({ root, state }) => `ROOT=${root}\nSTATE=${state}\nHEARTBEAT_URL=http://hc.example.com/ping/secret-token\n`,
        'HEARTBEAT_URL must be an https:// address',
      ],
      [
        'CONFIG_PATHS',
        ({ root, state }) => `ROOT=${root}\nSTATE=${state}\nCONFIG_PATHS="backend/deploy/.env"\n`,
        'CONFIG_PATHS holds absolute paths',
      ],
      [
        'COMPOSE_OVERRIDE',
        ({ dir, root, state }) => `ROOT=${root}\nSTATE=${state}\nCOMPOSE_OVERRIDE=${dir}/none.yaml\n`,
        'cannot read COMPOSE_OVERRIDE',
      ],
    ];
    for (const [label, conf, message] of cases) {
      const host = await makeHost({ conf });
      const result = await backup(host, ['run']);
      expect(result.code, label).toBe(2);
      expect(result.stderr, label).toMatch(/^gsm-backup: /);
      expect(result.stderr, label).toContain(message);
      expect(result.stderr, label).not.toContain('secret-token');
      expect(result.calls, label).toEqual([]);
      expect(existsSync(host.state), label).toBe(false);
    }
    const host = await makeHost();
    const missing = await backup(host, ['status'], { GSM_BACKUP_CONF: join(host.dir, 'none.conf') });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read ');
  });

  it('refuses an unknown command and a drill without its key file', async () => {
    const host = await makeHost();
    for (const args of [[], ['ship-it'], ['drill'], ['drill', 'a', 'b']]) {
      const result = await backup(host, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr, args.join(' ')).toContain('usage: gsm-backup');
      expect(result.calls, args.join(' ')).toEqual([]);
    }
  });
});

describe('deploy/backup/r2-bucket-rules.sh', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const BUCKET = 'gsm-backups-example';
  const TOKEN = 'cf-example-token-0123456789';
  const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;
  const DAY = 86_400;

  const lifecycle = (daily: number) => ({
    rules: [
      ...(
        [
          ['db-incoming', 'db/incoming/', 2],
          ['db-daily', 'db/daily/', daily + 5],
          ['db-monthly', 'db/monthly/', 400],
          ['config', 'config/', daily + 5],
        ] as const
      ).map(([id, prefix, days]) => ({
        id,
        enabled: true,
        conditions: { prefix },
        deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * DAY } },
      })),
      {
        id: 'abort-multipart',
        enabled: true,
        conditions: { prefix: '' },
        abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 172_800 } },
      },
    ],
  });
  const lock = (daily: number) => ({
    rules: [
      {
        id: 'lock-db-daily',
        enabled: true,
        prefix: 'db/daily/',
        condition: { type: 'Age', maxAgeSeconds: daily * DAY },
      },
      {
        id: 'lock-db-monthly',
        enabled: true,
        prefix: 'db/monthly/',
        condition: { type: 'Age', maxAgeSeconds: 395 * DAY },
      },
      { id: 'lock-config', enabled: true, prefix: 'config/', condition: { type: 'Age', maxAgeSeconds: daily * DAY } },
      { id: 'lock-files', enabled: true, prefix: 'files-age/', condition: { type: 'Indefinite' } },
    ],
  });

  /** Runs the script against the stub API; returns each call's method, address, body, arguments and config. */
  async function rules(args: string[], env: Record<string, string> = {}) {
    const dir = await tempDir();
    const bin = await toolFolder(dir, { curl: 'cloudflare-curl.sh' });
    const result = await run([BASH, RULES, ...args], {
      env: { PATH: bin, HOME: dir, STUB_DIR: dir, CLOUDFLARE_API_TOKEN: TOKEN, ...env },
    });
    const count = Number((await text(join(dir, 'curl-count')).catch(() => '0')).trim());
    const calls = [];
    for (let n = 1; n <= count; n++) {
      const argv = (await text(join(dir, `curl-${n}.args`))).split('\n').filter(Boolean);
      calls.push({
        method: argv[argv.indexOf('-X') + 1],
        url: argv.at(-1),
        body: await text(join(dir, `curl-${n}.body`)).then(
          (body) => JSON.parse(body) as unknown,
          () => null,
        ),
        argv,
        config: await text(join(dir, `curl-${n}.config`)),
      });
    }
    return { ...result, calls };
  }

  it("apply puts exactly the two rule sets, then shows both; the token is only in curl's config", async () => {
    const result = await rules([ACCOUNT, BUCKET, 'apply']);
    expect(result.code).toBe(0);
    expect(result.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT ${API}/lifecycle`,
      `PUT ${API}/lock`,
      `GET ${API}/lifecycle`,
      `GET ${API}/lock`,
    ]);
    expect(result.calls[0]?.body).toEqual(lifecycle(30));
    expect(result.calls[1]?.body).toEqual(lock(30));
    for (const call of result.calls) {
      expect(call.argv.join(' ')).not.toContain(TOKEN);
      expect(call.config).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
    }
    expect(JSON.parse(result.stdout)).toEqual({
      lifecycle: { rules: [{ id: 'GET-lifecycle' }] },
      lock: { rules: [{ id: 'GET-lock' }] },
    });
  });

  it('takes the daily retention from DAILY_DAYS: the lock ends five days before the removal', async () => {
    const result = await rules([ACCOUNT, BUCKET, 'apply'], { DAILY_DAYS: '14' });
    expect(result.code).toBe(0);
    expect(result.calls[0]?.body).toEqual(lifecycle(14));
    expect(result.calls[1]?.body).toEqual(lock(14));
  });

  it('show only reads', async () => {
    const result = await rules([ACCOUNT, BUCKET, 'show']);
    expect(result.code).toBe(0);
    expect(result.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(result.calls.every((call) => call.body === null)).toBe(true);
  });

  it('prints the errors of an answer without success, exits non-zero and sends nothing after it', async () => {
    const first = await rules([ACCOUNT, BUCKET, 'apply'], { STUB_FAIL_ON: 'PUT lifecycle' });
    expect(first.code).not.toBe(0);
    expect(first.stderr).toContain('The specified bucket does not exist.');
    expect(first.calls).toHaveLength(1);
    const second = await rules([ACCOUNT, BUCKET, 'apply'], { STUB_FAIL_ON: 'PUT lock' });
    expect(second.code).not.toBe(0);
    expect(second.calls).toHaveLength(2);
    expect(second.stdout).toBe('');
  });

  it('sends the jurisdiction header on every request with R2_JURISDICTION, and refuses a value that is not a name', async () => {
    const eu = await rules([ACCOUNT, BUCKET, 'apply'], { R2_JURISDICTION: 'eu' });
    expect(eu.code).toBe(0);
    expect(eu.calls).toHaveLength(4);
    for (const call of eu.calls) {
      expect(call.argv).toContain('cf-r2-jurisdiction: eu');
      expect(call.argv[call.argv.indexOf('cf-r2-jurisdiction: eu') - 1]).toBe('-H');
    }
    const plain = await rules([ACCOUNT, BUCKET, 'show']);
    for (const call of plain.calls) expect(call.argv.join(' ')).not.toContain('cf-r2-jurisdiction');
    for (const value of ['e u', 'eu;x', 'eu"']) {
      const refused = await rules([ACCOUNT, BUCKET, 'apply'], { R2_JURISDICTION: value });
      expect(refused.code, value).toBe(2);
      expect(refused.calls, value).toEqual([]);
    }
  });

  it('refuses to run without a token, with a wrong action or a wrong DAILY_DAYS', async () => {
    for (const [args, env] of [
      [[ACCOUNT, BUCKET, 'apply'], { CLOUDFLARE_API_TOKEN: '' }],
      [[ACCOUNT, BUCKET, 'delete'], {}],
      [[ACCOUNT, BUCKET], {}],
      [[ACCOUNT, BUCKET, 'apply'], { DAILY_DAYS: 'a month' }],
    ] as [string[], Record<string, string>][]) {
      const result = await rules(args, env);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.calls, args.join(' ')).toEqual([]);
    }
  });
});

/** The settings of a systemd unit file, by section and key. */
function unit(path: string): Record<string, Record<string, string[]>> {
  const sections: Record<string, Record<string, string[]>> = {};
  let section: Record<string, string[]> = {};
  for (const line of read(path).split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = {};
      sections[header[1] ?? ''] = section;
      continue;
    }
    const at = line.indexOf('=');
    (section[line.slice(0, at)] ??= []).push(line.slice(at + 1));
  }
  return sections;
}

describe('the systemd units and the settings of the backups', () => {
  it('run the installed script as one-shot services after Docker', () => {
    for (const [name, command] of [
      ['gsm-backup', 'run'],
      ['gsm-backup-check', 'check'],
    ]) {
      const service = unit(`deploy/backup/${name}.service`);
      expect(service.Service?.Type, name).toEqual(['oneshot']);
      expect(service.Service?.ExecStart, name).toEqual([`/usr/local/sbin/gsm-backup ${command}`]);
      expect(service.Unit?.Requires, name).toEqual(['docker.service']);
      expect(service.Unit?.After?.[0], name).toContain('docker.service');
    }
    expect(unit('deploy/backup/gsm-backup.service').Service?.TimeoutStartSec).toEqual(['3h']);
    // A run that found another one going on (exit code 75) is not a failed unit.
    expect(unit('deploy/backup/gsm-backup.service').Service?.SuccessExitStatus).toEqual(['75']);
  });

  it('start at their hours and catch up a time the server was off', () => {
    const nightly = unit('deploy/backup/gsm-backup.timer');
    expect(nightly.Timer).toEqual({
      OnCalendar: ['*-*-* 01:15:00 UTC'],
      RandomizedDelaySec: ['15min'],
      Persistent: ['true'],
    });
    const morning = unit('deploy/backup/gsm-backup-check.timer');
    expect(morning.Timer).toEqual({ OnCalendar: ['*-*-* 07:30:00 UTC'], Persistent: ['true'] });
    for (const timer of [nightly, morning]) expect(timer.Install?.WantedBy).toEqual(['timers.target']);
  });

  it('are installed at the paths the runbook names, and the settings template names every setting with example values', () => {
    const runbook = read('docs/OPERATIONS.md');
    expect(runbook).toContain('install -m 0750 deploy/backup/gsm-backup.sh /usr/local/sbin/gsm-backup');
    expect(runbook).toContain('install -m 0600 deploy/backup/gsm-backup.conf.example /etc/gsm-backup.conf');
    for (const name of [
      'gsm-backup.service',
      'gsm-backup.timer',
      'gsm-backup-check.service',
      'gsm-backup-check.timer',
    ]) {
      expect(runbook).toContain(`deploy/backup/${name}`);
    }
    const template = read('deploy/backup/gsm-backup.conf.example');
    for (const line of [
      'ROOT=/opt/gsm',
      'COMPOSE_OVERRIDE=',
      'ALERT_EMAIL=ops@example.com',
      'HEARTBEAT_URL=',
      '# STATE=/var/lib/gsm-backup',
      '# MAX_AGE_HOURS=26',
      '# DRILL_EVERY_DAYS=35',
      '# CONFIG_PATHS=',
    ]) {
      expect(template).toContain(`\n${line}`);
    }
  });

  it('the scripts parse', async () => {
    for (const script of ['deploy/backup/gsm-backup.sh', 'deploy/backup/r2-bucket-rules.sh']) {
      expect((await run(['bash', '-n', script])).code, script).toBe(0);
    }
  });
});
