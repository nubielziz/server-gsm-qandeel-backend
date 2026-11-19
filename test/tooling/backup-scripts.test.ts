// Tests of the backup scripts (feature 24D, decision 036) without a database, a bucket or a network: BACKUP_DRY_RUN=1 prints the
// commands, and for the checks that need command output stub binaries (pg_dump, age, rclone, pg_restore, psql) stand in on PATH.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = new URL('../../scripts/backup/', import.meta.url).pathname;

let work: string;
let stubs: string;
let log: string;

/** A stub that records its arguments in STUB_LOG and behaves like the real tool closely enough for the scripts. */
const STUBS: Record<string, string> = {
  pg_dump: `echo "pg_dump $*" >> "$STUB_LOG"; echo DUMP`,
  age: `echo "age $*" >> "$STUB_LOG"; cat`,
  pg_restore: `echo "pg_restore $*" >> "$STUB_LOG"; cat > /dev/null`,
  rclone: `
echo "rclone $*" >> "$STUB_LOG"
case "$1" in
  rcat) cat > /dev/null ;;
  cat) echo DUMP ;;
  lsf)
    key="\${@: -1}"; key="\${key//[^A-Za-z0-9]/_}"
    [ -f "$STUB_DIR/lsf_$key" ] && cat "$STUB_DIR/lsf_$key" || true ;;
esac`,
  psql: `
echo "psql $*" >> "$STUB_LOG"
case "$*" in
  *information_schema*) echo "\${STUB_TABLES:-0}" ;;
  *"sum(amount)"*) echo "\${STUB_LEDGER:-t}" ;;
  *__drizzle_migrations*) echo "\${STUB_MIGRATIONS:-3}" ;;
  *"from orders"*) echo 11 ;;
  *"from clients"*) echo 7 ;;
  *"from ledger_transactions"*) echo 5 ;;
esac`,
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'gsm-backup-test-'));
  stubs = join(work, 'bin');
  mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(stubs, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`);
    chmodSync(path, 0o755);
  }
  log = join(work, 'stub.log');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://gsm:topsecretpw@postgres:5432/gsm',
  BACKUP_S3_ENDPOINT: 'https://s3.example.com',
  BACKUP_S3_BUCKET: 'gsm-backups',
  BACKUP_S3_ACCESS_KEY_ID: 'key-id',
  BACKUP_S3_SECRET_ACCESS_KEY: 'key-secret',
  BACKUP_AGE_RECIPIENT: 'age1recipient',
  BACKUP_NOW: '2026-11-10T01:15:00Z',
};

interface Result {
  code: number;
  out: string;
  err: string;
  calls: string[];
}

/** Runs a backup script with the stubs first on PATH; `env` overrides BASE_ENV (an `undefined` value removes a variable). */
function runScript(script: string, args: string[], env: Record<string, string | undefined> = {}): Result {
  writeFileSync(log, '');
  const merged: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: work,
    STUB_LOG: log,
    STUB_DIR: work,
  };
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  const proc = Bun.spawnSync(['bash', join(SCRIPTS, script), ...args], { env: merged, cwd: work });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

/** Writes the canned output of `rclone lsf <path>` for the stub. */
function listing(path: string, lines: string[]): void {
  writeFileSync(join(work, `lsf_${path.replace(/[^A-Za-z0-9]/g, '_')}`), lines.join('\n') + '\n');
}

describe('every script', () => {
  it('passes bash -n', () => {
    const scripts = readdirSync(SCRIPTS).filter((name) => name.endsWith('.sh'));
    expect(scripts.sort()).toEqual(['files-mirror.sh', 'lib.sh', 'pg-backup.sh', 'pg-restore.sh', 'restore-drill.sh']);
    for (const script of scripts) {
      const check = Bun.spawnSync(['bash', '-n', join(SCRIPTS, script)]);
      expect(check.exitCode, `${script}: ${check.stderr.toString()}`).toBe(0);
    }
  });
});

describe('pg-backup.sh', () => {
  it('prints the dump | age | rclone rcat pipeline in a dry run, without the password', () => {
    const result = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      '+ pg_dump --format=custom --no-owner --no-privileges postgres://gsm:***@postgres:5432/gsm',
    );
    expect(result.err).toContain('+ age -r age1recipient');
    expect(result.err).toContain('+ rclone rcat backup:gsm-backups/db/daily/gsm-20261110T011500Z.dump.age');
    expect(result.err + result.out).not.toContain('topsecretpw');
    expect(result.calls).toEqual([]); // nothing was executed
  });

  it('refuses to upload an unencrypted dump without a recipient, unless plaintext is explicitly allowed', () => {
    const refused = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_AGE_RECIPIENT: undefined });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('BACKUP_AGE_RECIPIENT is not set');
    expect(refused.err).not.toContain('pg_dump');

    const allowed = runScript('pg-backup.sh', [], {
      BACKUP_DRY_RUN: '1',
      BACKUP_AGE_RECIPIENT: undefined,
      BACKUP_ALLOW_PLAINTEXT: '1',
    });
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain('gsm-20261110T011500Z.dump');
    expect(allowed.err).not.toContain('+ age');
  });

  it('keeps a monthly copy only on the first day of the month', () => {
    const ordinary = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1' });
    expect(ordinary.err).not.toContain('copyto');
    const first = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_NOW: '2026-12-01T01:15:00Z' });
    expect(first.err).toContain(
      '+ rclone copyto backup:gsm-backups/db/daily/gsm-20261201T011500Z.dump.age backup:gsm-backups/db/monthly/gsm-20261201T011500Z.dump.age',
    );
  });

  it('prunes with the retention variables and rejects nonsense values', () => {
    const defaults = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1' });
    expect(defaults.err).toContain('+ rclone delete backup:gsm-backups/db/daily --min-age 30d');
    const custom = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_RETENTION_DAYS: '7' });
    expect(custom.err).toContain('--min-age 7d');
    expect(runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_RETENTION_DAYS: 'soon' }).code).toBe(1);
    expect(runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_MONTHLY_KEEP: '0' }).code).toBe(1);
  });

  it('fails when a required variable is missing', () => {
    const result = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_S3_BUCKET: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('BACKUP_S3_BUCKET');
  });

  it('runs the real pipeline against the stubs, verifies the uploaded object and prunes old monthly copies', () => {
    listing('backup:gsm-backups/db/daily/', ['1234;gsm-20261110T011500Z.dump.age']);
    const months = Array.from(
      { length: 14 },
      (_, i) => `gsm-2025${String(i < 12 ? i + 1 : 12).padStart(2, '0')}0${i < 12 ? 1 : 2}T011500Z.dump.age`,
    );
    listing('backup:gsm-backups/db/monthly/', months);
    const result = runScript('pg-backup.sh', [], { BACKUP_MONTHLY_KEEP: '12' });
    expect(result.code).toBe(0);
    expect(result.calls.some((call) => call.startsWith('pg_dump --format=custom'))).toBe(true);
    expect(result.calls).toContain('age -r age1recipient');
    expect(result.calls).toContain('rclone rcat backup:gsm-backups/db/daily/gsm-20261110T011500Z.dump.age');
    const deleted = result.calls.filter((call) => call.startsWith('rclone deletefile'));
    expect(deleted.length).toBe(2);
    expect(deleted[0]).toContain(months[0] as string);
    expect(result.out).toContain('1234 bytes');
  });

  it('fails when the uploaded object is missing or empty', () => {
    listing('backup:gsm-backups/db/daily/', ['0;gsm-20261110T011500Z.dump.age']);
    expect(runScript('pg-backup.sh', []).code).toBe(1);
    listing('backup:gsm-backups/db/daily/', ['99;gsm-some-other-day.dump.age']);
    const missing = runScript('pg-backup.sh', []);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('missing or empty');
  });
});

describe('files-mirror.sh', () => {
  const filesEnv = {
    BACKUP_DRY_RUN: '1',
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'gsm-files',
    S3_ACCESS_KEY_ID: 'minio-user',
    S3_SECRET_ACCESS_KEY: 'minio-secret',
  };

  it('copies (never syncs) the files bucket to the backup bucket', () => {
    const result = runScript('files-mirror.sh', [], filesEnv);
    expect(result.code).toBe(0);
    expect(result.err).toContain('+ rclone copy files:gsm-files backup:gsm-backups/files');
    expect(result.err).not.toContain('sync');
    expect(result.err).not.toContain('delete');
  });

  it('fails without the files bucket settings', () => {
    const result = runScript('files-mirror.sh', [], { ...filesEnv, S3_BUCKET: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('S3_BUCKET');
  });
});

describe('pg-restore.sh', () => {
  const object = 'db/daily/gsm-20261110T011500Z.dump.age';
  const target = 'postgres://gsm:pw@postgres:5432/gsm_restore';

  it('refuses to run without an explicit target (it never defaults to DATABASE_URL)', () => {
    const result = runScript('pg-restore.sh', [object]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('usage');
    expect(result.calls).toEqual([]);
  });

  it('refuses a target that is not a postgres URL, and an encrypted object without an identity', () => {
    expect(runScript('pg-restore.sh', [object, 'gsm_restore']).code).toBe(1);
    const noIdentity = runScript('pg-restore.sh', [object, target]);
    expect(noIdentity.code).toBe(1);
    expect(noIdentity.err).toContain('--identity');
  });

  it('refuses a target database that already has tables unless --force is given', () => {
    writeFileSync(join(work, 'identity.txt'), 'AGE-SECRET-KEY-TEST\n');
    const identity = join(work, 'identity.txt');
    const refused = runScript('pg-restore.sh', [object, target, '--identity', identity], { STUB_TABLES: '12' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('already has 12 tables');
    expect(refused.calls.some((call) => call.startsWith('pg_restore'))).toBe(false);

    const forced = runScript('pg-restore.sh', [object, target, '--identity', identity, '--force'], {
      STUB_TABLES: '12',
    });
    expect(forced.code).toBe(0);
    expect(
      forced.calls.some((call) => call.startsWith('pg_restore --clean --if-exists --no-owner --exit-on-error')),
    ).toBe(true);
  });

  it('downloads, decrypts and restores into an empty target', () => {
    const identity = join(work, 'identity.txt');
    const result = runScript('pg-restore.sh', [object, target, '--identity', identity], { STUB_TABLES: '0' });
    expect(result.code).toBe(0);
    expect(result.calls).toContain(`rclone cat backup:gsm-backups/${object}`);
    expect(result.calls).toContain(`age --decrypt -i ${identity}`);
    expect(result.calls).toContain(`pg_restore --clean --if-exists --no-owner --exit-on-error --dbname ${target}`);
  });

  it('restores a plaintext object without age', () => {
    const result = runScript('pg-restore.sh', ['db/daily/gsm-20261110T011500Z.dump', target]);
    expect(result.code).toBe(0);
    expect(result.calls.some((call) => call.startsWith('age'))).toBe(false);
  });
});

describe('restore-drill.sh', () => {
  const identity = () => join(work, 'identity.txt');

  function migrationsDir(count: number): string {
    const dir = join(work, `migrations-${count}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `000${i}_x.sql`), '-- migration');
    return dir;
  }

  it('prints its plan in a dry run', () => {
    const result = runScript('restore-drill.sh', ['--identity', identity()], { BACKUP_DRY_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.err).toContain('gsm_restore_drill_20261110t011500z');
    expect(result.err).toContain('create database');
    expect(result.err).toContain('drop database if exists gsm_restore_drill_20261110t011500z with (force)');
  });

  it('restores the newest daily dump into a scratch database, checks it and drops it', () => {
    listing('backup:gsm-backups/db/daily/', ['gsm-20261108T011500Z.dump.age', 'gsm-20261109T011500Z.dump.age']);
    const result = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_MIGRATIONS: '3',
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContain('rclone cat backup:gsm-backups/db/daily/gsm-20261109T011500Z.dump.age');
    expect(result.calls.some((call) => call.includes('create database gsm_restore_drill_20261110t011500z'))).toBe(true);
    expect(
      result.calls.some((call) => call.includes('drop database if exists gsm_restore_drill_20261110t011500z')),
    ).toBe(true);
    expect(result.out).toContain('ledger_entries sum to zero');
    expect(result.out).toContain('orders: 11');
    expect(result.out).toContain('restore drill passed');
  });

  it('fails, and still drops the scratch database, when the ledger does not sum to zero', () => {
    listing('backup:gsm-backups/db/daily/', ['gsm-20261109T011500Z.dump.age']);
    const result = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_LEDGER: 'f',
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('do not sum to zero');
    expect(result.calls.some((call) => call.includes('drop database if exists'))).toBe(true);
  });

  it('fails when the dump has more migrations than the code, and only warns when it has fewer', () => {
    listing('backup:gsm-backups/db/daily/', ['gsm-20261109T011500Z.dump.age']);
    const ahead = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_MIGRATIONS: '4',
    });
    expect(ahead.code).toBe(1);
    expect(ahead.err).toContain('newer version');
    const behind = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_MIGRATIONS: '2',
    });
    expect(behind.code).toBe(0);
    expect(behind.out).toContain('a migration was applied after the dump');
  });

  it('fails when there is no daily backup at all', () => {
    writeFileSync(join(work, 'lsf_backup_gsm_backups_db_daily_'), '');
    const result = runScript('restore-drill.sh', ['--identity', identity()], { MIGRATIONS_DIR: migrationsDir(3) });
    expect(result.code).toBe(1);
    expect(result.err).toContain('no daily backup found');
  });
});
