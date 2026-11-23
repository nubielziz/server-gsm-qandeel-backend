// Tests of the backup scripts (feature 24D, decisions 036 and 055) without a database, a bucket or a network: BACKUP_DRY_RUN=1 prints
// the commands, and for the checks that need command output stub binaries (pg_dump, age, rclone, pg_restore, psql) stand in on PATH.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = new URL('../../scripts/backup/', import.meta.url).pathname;

let work: string;
let stubs: string;
let log: string;

/** A stub that records its arguments in STUB_LOG and behaves like the real tool closely enough for the scripts. */
const STUBS: Record<string, string> = {
  pg_dump: `echo "pg_dump $*" >> "$STUB_LOG"; [ "\${STUB_PG_DUMP_FAIL:-0}" = 1 ] && exit 3; echo DUMP`,
  age: `echo "age $*" >> "$STUB_LOG"; cat`,
  pg_restore: `echo "pg_restore $*" >> "$STUB_LOG"; cat > /dev/null`,
  rclone: `
echo "rclone $*" >> "$STUB_LOG"
echo "\${RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID:-}" >> "$STUB_DIR/keys.log"
case "$1" in
  rcat) cat > /dev/null ;;
  cat) [ "\${STUB_CAT_FAIL:-0}" = 1 ] && exit 4; echo DUMP ;;
  lsf)
    key="\${@: -1}"
    # STUB_LSF_FAIL names a part of the listed path that makes the listing fail, with the exit code STUB_LSF_FAIL_CODE (default 2).
    if [ -n "\${STUB_LSF_FAIL:-}" ] && [[ "$key" == *"$STUB_LSF_FAIL"* ]]; then
      echo "ERROR : listing failed (stub)" >&2
      exit "\${STUB_LSF_FAIL_CODE:-2}"
    fi
    key="\${key//[^A-Za-z0-9]/_}"
    [ -f "$STUB_DIR/lsf_$key" ] && cat "$STUB_DIR/lsf_$key" || true ;;
esac`,
  // A statement sent on standard input (the restore drill's role) is recorded on its own line, as the real psql would read it.
  psql: `
echo "psql $*" >> "$STUB_LOG"
statement=$(cat)
[ -n "$statement" ] && echo "psql-stdin $statement" >> "$STUB_LOG"
case "$*" in
  *rolsuper*) echo "\${STUB_SUPERUSER:-f}" ;;
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

// Every test writes the listings it needs: none survives from another test.
beforeEach(() => {
  for (const name of readdirSync(work)) if (name.startsWith('lsf_')) rmSync(join(work, name));
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

/**
 * Runs a backup script with the stubs first on PATH; `env` overrides BASE_ENV (an `undefined` value removes a variable), and `stdin`
 * is its standard input.
 */
function runScript(
  script: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Result {
  writeFileSync(log, '');
  writeFileSync(join(work, 'keys.log'), '');
  const merged: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: work,
    STUB_LOG: log,
    STUB_DIR: work,
  };
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  const proc = Bun.spawnSync(['bash', join(SCRIPTS, script), ...args], {
    env: merged,
    cwd: work,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

/** Writes the canned output of `rclone lsf <path>` for the stub. */
function listing(path: string, lines: string[]): void {
  writeFileSync(
    join(work, `lsf_${path.replace(/[^A-Za-z0-9]/g, '_')}`),
    lines.length === 0 ? '' : lines.join('\n') + '\n',
  );
}

describe('every script', () => {
  it('passes bash -n', () => {
    const scripts = readdirSync(SCRIPTS).filter((name) => name.endsWith('.sh'));
    expect(scripts.sort()).toEqual([
      'config-copy.sh',
      'files-mirror.sh',
      'files-purge.sh',
      'lib.sh',
      'offsite-status.sh',
      'pg-backup.sh',
      'pg-restore.sh',
      'restore-drill.sh',
    ]);
    for (const script of scripts) {
      const check = Bun.spawnSync(['bash', '-n', join(SCRIPTS, script)]);
      expect(check.exitCode, `${script}: ${check.stderr.toString()}`).toBe(0);
    }
  });
});

describe('pg-backup.sh', () => {
  const NAME = 'gsm-20261110T011500Z.dump.age';
  const INCOMING = 'backup:gsm-backups/db/incoming';
  const DAILY = 'backup:gsm-backups/db/daily';

  it('prints the dump | age pipeline into a work file, the copy to incoming and the copy to daily in a dry run, without the password', () => {
    const result = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      '+ pg_dump --format=custom --no-owner --no-privileges postgres://gsm:***@postgres:5432/gsm',
    );
    expect(result.err).toContain('+ age -r age1recipient');
    // The dump is complete in a file before anything is uploaded; it never streams into the bucket.
    expect(result.err).toMatch(new RegExp(`\\+ rclone copyto \\S+/${NAME} ${INCOMING}/${NAME}\n`));
    expect(result.err).toContain(`+ rclone copyto ${INCOMING}/${NAME} ${DAILY}/${NAME}`);
    expect(result.err).not.toContain('rcat');
    expect(result.err + result.out).not.toContain('topsecretpw');
    expect(result.calls).toEqual([]); // nothing was executed
  });

  it("deletes nothing by default: retention is the bucket's rule, and says so", () => {
    const result = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1' });
    expect(result.err).not.toContain('delete');
    expect(result.out).toContain('nothing deleted');
  });

  it('prunes with the retention variables only when BACKUP_PRUNE=1, and rejects nonsense values', () => {
    const pruning = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_PRUNE: '1' });
    expect(pruning.code).toBe(0);
    expect(pruning.err).toContain(`+ rclone delete ${DAILY} --min-age 30d`);
    expect(pruning.err).toContain(`+ rclone delete ${INCOMING} --min-age 2d`);
    expect(
      runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_PRUNE: '1', BACKUP_RETENTION_DAYS: '7' }).err,
    ).toContain('--min-age 7d');
    expect(runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_PRUNE: '2' }).code).toBe(1);
    expect(runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_RETENTION_DAYS: 'soon' }).code).toBe(1);
    expect(runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_MONTHLY_KEEP: '0' }).code).toBe(1);
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
    expect(ordinary.err).not.toContain('db/monthly');
    const first = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_NOW: '2026-12-01T01:15:00Z' });
    expect(first.err).toContain(
      `+ rclone copyto ${INCOMING}/gsm-20261201T011500Z.dump.age backup:gsm-backups/db/monthly/gsm-20261201T011500Z.dump.age`,
    );
  });

  it('fails when a required variable is missing', () => {
    const result = runScript('pg-backup.sh', [], { BACKUP_DRY_RUN: '1', BACKUP_S3_BUCKET: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('BACKUP_S3_BUCKET');
  });

  it('runs the real pipeline against the stubs: dump to a file, copy to incoming, check it there, then copy to daily; deletes nothing', () => {
    listing(`${INCOMING}/`, [`1234;${NAME}`]);
    const result = runScript('pg-backup.sh', []);
    expect(result.code).toBe(0);
    expect(result.calls.some((call) => call.startsWith('pg_dump --format=custom'))).toBe(true);
    expect(result.calls).toContain('age -r age1recipient');
    const copies = result.calls.filter((call) => call.startsWith('rclone copyto'));
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatch(new RegExp(`^rclone copyto \\S+/${NAME} ${INCOMING}/${NAME}$`));
    expect(copies[1]).toBe(`rclone copyto ${INCOMING}/${NAME} ${DAILY}/${NAME}`);
    expect(result.calls.some((call) => call.startsWith('rclone rcat'))).toBe(false);
    expect(result.calls.some((call) => /rclone delete/.test(call))).toBe(false);
    expect(result.out).toContain('1234 bytes');
  });

  it('with BACKUP_PRUNE=1 also prunes the old monthly copies, as before', () => {
    listing(`${INCOMING}/`, [`1234;${NAME}`]);
    const months = Array.from(
      { length: 14 },
      (_, i) => `gsm-2025${String(i < 12 ? i + 1 : 12).padStart(2, '0')}0${i < 12 ? 1 : 2}T011500Z.dump.age`,
    );
    listing('backup:gsm-backups/db/monthly/', months);
    const result = runScript('pg-backup.sh', [], { BACKUP_PRUNE: '1', BACKUP_MONTHLY_KEEP: '12' });
    expect(result.code).toBe(0);
    const deleted = result.calls.filter((call) => call.startsWith('rclone deletefile'));
    expect(deleted.length).toBe(2);
    expect(deleted[0]).toContain(months[0] as string);
    expect(result.calls).toContain(`rclone delete ${DAILY} --min-age 30d`);
  });

  it('fails, and copies nothing to daily, when the uploaded object is missing or empty', () => {
    listing(`${INCOMING}/`, [`0;${NAME}`]);
    const empty = runScript('pg-backup.sh', []);
    expect(empty.code).toBe(1);
    listing(`${INCOMING}/`, ['99;gsm-some-other-day.dump.age']);
    const missing = runScript('pg-backup.sh', []);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('missing or empty');
    for (const result of [empty, missing]) {
      expect(result.calls.some((call) => call.includes(`${DAILY}/`))).toBe(false);
    }
  });

  it('uploads nothing when the dump fails midway', () => {
    const result = runScript('pg-backup.sh', [], { STUB_PG_DUMP_FAIL: '1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing was uploaded');
    expect(result.calls.some((call) => call.startsWith('rclone'))).toBe(false);
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
  const SOURCE = 'files:gsm-files';
  const COPIES = 'backup:gsm-backups/files-age/';

  it('refuses to copy the files unencrypted without a recipient, unless plaintext is explicitly allowed', () => {
    const refused = runScript('files-mirror.sh', [], { ...filesEnv, BACKUP_AGE_RECIPIENT: undefined });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('BACKUP_AGE_RECIPIENT is not set: refusing to copy the files unencrypted');
    expect(refused.err).not.toContain('rclone copy');
    // The old behaviour, on request: a plain copy (never a sync) to files/.
    const allowed = runScript('files-mirror.sh', [], {
      ...filesEnv,
      BACKUP_AGE_RECIPIENT: undefined,
      BACKUP_ALLOW_PLAINTEXT: '1',
    });
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain('+ rclone copy files:gsm-files backup:gsm-backups/files ');
    expect(allowed.err).not.toContain('sync');
    expect(allowed.err).not.toContain('delete');
    expect(allowed.out).toContain('WITHOUT encryption');
  });

  it('encrypts and copies only the objects the offsite copy lacks, each from a work file, and deletes nothing', () => {
    listing(SOURCE, ['a/1.pdf', 'a/2.png', 'b/3.pdf']);
    listing(COPIES, ['a/1.pdf.age']);
    const result = runScript('files-mirror.sh', [], { ...filesEnv, BACKUP_DRY_RUN: undefined });
    expect(result.code).toBe(0);
    const reads = result.calls.filter((call) => call.startsWith('rclone cat'));
    expect(reads).toEqual([`rclone cat ${SOURCE}/a/2.png`, `rclone cat ${SOURCE}/b/3.pdf`]);
    expect(result.calls.filter((call) => call === 'age -r age1recipient')).toHaveLength(2);
    const uploads = result.calls.filter((call) => call.startsWith('rclone copyto'));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatch(/^rclone copyto \S+\/object\.age backup:gsm-backups\/files-age\/a\/2\.png\.age$/);
    expect(uploads[1]).toMatch(/^rclone copyto \S+\/object\.age backup:gsm-backups\/files-age\/b\/3\.pdf\.age$/);
    expect(result.calls.some((call) => /rclone (rcat|delete|deletefile|sync|purge)/.test(call))).toBe(false);
    expect(result.out).toContain('2 copied');
  });

  it('copies nothing of an object whose read failed (no partial copy that the next run would skip)', () => {
    listing(SOURCE, ['a/1.pdf']);
    const result = runScript('files-mirror.sh', [], { ...filesEnv, BACKUP_DRY_RUN: undefined, STUB_CAT_FAIL: '1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing of it was copied');
    expect(result.calls.some((call) => call.startsWith('rclone copyto'))).toBe(false);
  });

  it('stops, copying nothing, when the listing of the offsite target fails: it is not an empty target', () => {
    listing(SOURCE, ['a/1.pdf', 'a/2.png']);
    listing(COPIES, ['a/1.pdf.age', 'a/2.png.age']);
    for (const code of ['1', '2', '5', '7']) {
      const result = runScript('files-mirror.sh', [], {
        ...filesEnv,
        BACKUP_DRY_RUN: undefined,
        STUB_LSF_FAIL: 'files-age',
        STUB_LSF_FAIL_CODE: code,
      });
      expect(result.code, code).toBe(1);
      expect(result.err, code).toContain(`listing backup:gsm-backups/files-age failed (rclone exit code ${code})`);
      expect(result.err, code).toContain('nothing was copied');
      // No object was read, encrypted or copied, and the run never reached its plan.
      expect(
        result.calls.some((call) => /^(rclone (cat|copyto|copy|rcat)|age)/.test(call)),
        code,
      ).toBe(false);
      expect(result.out, code).not.toContain('to encrypt and copy');
    }
    // A dry run lists too, so it stops the same way instead of printing a plan for every object.
    const dry = runScript('files-mirror.sh', [], { ...filesEnv, STUB_LSF_FAIL: 'files-age', STUB_LSF_FAIL_CODE: '7' });
    expect(dry.code).toBe(1);
    expect(dry.err).not.toContain('+ rclone cat');
  });

  it('treats only a target folder that does not exist yet (rclone exit code 3) as empty: the first run copies everything', () => {
    listing(SOURCE, ['a/1.pdf', 'a/2.png']);
    const result = runScript('files-mirror.sh', [], {
      ...filesEnv,
      BACKUP_DRY_RUN: undefined,
      STUB_LSF_FAIL: 'files-age',
      STUB_LSF_FAIL_CODE: '3',
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('rclone cat'))).toEqual([
      `rclone cat ${SOURCE}/a/1.pdf`,
      `rclone cat ${SOURCE}/a/2.png`,
    ]);
    expect(result.out).toContain('2 copied');
  });

  it('stops when the listing of the application bucket fails too', () => {
    listing(COPIES, ['a/1.pdf.age']);
    const result = runScript('files-mirror.sh', [], {
      ...filesEnv,
      BACKUP_DRY_RUN: undefined,
      STUB_LSF_FAIL: 'gsm-files',
      STUB_LSF_FAIL_CODE: '5',
    });
    expect(result.code).not.toBe(0);
    expect(result.calls.some((call) => /^(rclone (cat|copyto)|age)/.test(call))).toBe(false);
  });

  it('prints its plan in a dry run and changes nothing', () => {
    listing(SOURCE, ['a/1.pdf', 'a/2.png']);
    listing(COPIES, ['a/1.pdf.age']);
    const result = runScript('files-mirror.sh', [], filesEnv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('1 object(s) to encrypt and copy');
    expect(result.err).toContain(`+ rclone cat ${SOURCE}/a/2.png`);
    expect(result.err).toMatch(/\+ rclone copyto \S+\/object\.age backup:gsm-backups\/files-age\/a\/2\.png\.age/);
    // Only the listings ran.
    expect(result.calls.every((call) => call.startsWith('rclone lsf'))).toBe(true);
  });

  it('fails without the files bucket settings', () => {
    const result = runScript('files-mirror.sh', [], { ...filesEnv, S3_BUCKET: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('S3_BUCKET');
  });
});

describe('files-purge.sh', () => {
  const purgeEnv = {
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'gsm-files',
    S3_ACCESS_KEY_ID: 'minio-user',
    S3_SECRET_ACCESS_KEY: 'minio-secret',
    BACKUP_PURGE_S3_ACCESS_KEY_ID: 'purge-key-id',
    BACKUP_PURGE_S3_SECRET_ACCESS_KEY: 'purge-key-secret',
  };
  const SOURCE = 'files:gsm-files';
  const COPIES = 'backup:gsm-backups/files-age/';

  it('refuses without the two purge variables, so the nightly key can never run it', () => {
    const result = runScript('files-purge.sh', [], { ...purgeEnv, BACKUP_PURGE_S3_SECRET_ACCESS_KEY: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('BACKUP_PURGE_S3_SECRET_ACCESS_KEY');
    expect(result.calls).toEqual([]);
  });

  it('deletes only the copies of objects that no longer exist, with the purge key', () => {
    listing(SOURCE, ['a/1.pdf']);
    listing(COPIES, ['a/1.pdf.age', 'c/9.pdf.age']);
    const result = runScript('files-purge.sh', [], purgeEnv);
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('rclone deletefile'))).toEqual([
      'rclone deletefile backup:gsm-backups/files-age/c/9.pdf.age',
    ]);
    expect(result.out).toContain('1 removed');
    // Every call of the run used the purge key, never the nightly one.
    const keys = new Set(readFileSync(join(work, 'keys.log'), 'utf8').split('\n').filter(Boolean));
    expect([...keys]).toEqual(['purge-key-id']);
  });

  it('lists what it would delete in a dry run and deletes nothing', () => {
    listing(SOURCE, ['a/1.pdf']);
    listing(COPIES, ['a/1.pdf.age', 'c/9.pdf.age']);
    const result = runScript('files-purge.sh', [], { ...purgeEnv, BACKUP_DRY_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.err).toContain('+ rclone deletefile backup:gsm-backups/files-age/c/9.pdf.age');
    expect(result.calls.some((call) => call.startsWith('rclone deletefile'))).toBe(false);
  });

  it('refuses to delete every copy when the listing of the application bucket is empty', () => {
    listing(SOURCE, []);
    listing(COPIES, ['a/1.pdf.age', 'c/9.pdf.age']);
    const result = runScript('files-purge.sh', [], purgeEnv);
    expect(result.code).toBe(1);
    expect(result.err).toContain('refusing to delete every copy');
    expect(result.calls.some((call) => call.startsWith('rclone deletefile'))).toBe(false);
  });

  it('removes nothing when every copy still has its object', () => {
    listing(SOURCE, ['a/1.pdf', 'c/9.pdf']);
    listing(COPIES, ['a/1.pdf.age', 'c/9.pdf.age']);
    const result = runScript('files-purge.sh', [], purgeEnv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('0 removed');
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

  it('refuses a target that connects as a superuser unless --as-superuser is given (decision 055)', () => {
    const identity = join(work, 'identity.txt');
    const refused = runScript('pg-restore.sh', [object, target, '--identity', identity], { STUB_SUPERUSER: 't' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the target connects as a superuser');
    expect(refused.err).toContain('--as-superuser');
    expect(refused.calls.some((call) => call.startsWith('pg_restore'))).toBe(false);

    const allowed = runScript('pg-restore.sh', [object, target, '--identity', identity, '--as-superuser'], {
      STUB_SUPERUSER: 't',
    });
    expect(allowed.code).toBe(0);
    expect(allowed.calls.some((call) => call.startsWith('pg_restore --clean'))).toBe(true);
    // A role that is not a superuser needs no flag.
    expect(runScript('pg-restore.sh', [object, target, '--identity', identity]).code).toBe(0);
  });
});

describe('restore-drill.sh', () => {
  const identity = () => join(work, 'identity.txt');
  const SCRATCH = 'gsm_restore_drill_20261110t011500z';

  function migrationsDir(count: number): string {
    const dir = join(work, `migrations-${count}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `000${i}_x.sql`), '-- migration');
    return dir;
  }

  it('prints its plan in a dry run, and the role password appears in neither output', () => {
    const result = runScript('restore-drill.sh', ['--identity', identity()], { BACKUP_DRY_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.err).toContain(SCRATCH);
    // The statement that creates the role goes to psql on its standard input: the command shows no statement at all.
    expect(result.err).toContain('+ psql postgres://gsm:***@postgres:5432/gsm --no-psqlrc --set ON_ERROR_STOP=1\n');
    expect(result.err).toContain(`create database ${SCRATCH} owner ${SCRATCH}`);
    expect(result.err).toContain(`drop database if exists ${SCRATCH} with (force)`);
    expect(result.err).toContain(`drop role if exists ${SCRATCH}`);
    for (const text of [result.out, result.err]) {
      expect(text).not.toContain('create role');
      expect(text).not.toMatch(/password '/);
      expect(text).not.toContain('topsecretpw');
      // The random password is 48 hex characters: none is printed, not even inside the restore's target URL.
      expect(text).not.toMatch(/[0-9a-f]{48}/);
    }
    expect(result.err).toMatch(new RegExp(`postgres://${SCRATCH}:\\*\\*\\*@postgres:5432/${SCRATCH}`));
  });

  it('restores the newest daily dump as a temporary role that is not a superuser, checks it and drops both', () => {
    listing('backup:gsm-backups/db/daily/', ['gsm-20261108T011500Z.dump.age', 'gsm-20261109T011500Z.dump.age']);
    const result = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_MIGRATIONS: '3',
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContain('rclone cat backup:gsm-backups/db/daily/gsm-20261109T011500Z.dump.age');
    // The role: created from standard input, with a random password and no power; the database belongs to it.
    const statement = result.calls.find((call) => call.startsWith('psql-stdin ')) ?? '';
    expect(statement).toMatch(
      new RegExp(
        `^psql-stdin create role ${SCRATCH} login password '[0-9a-f]{48}' nosuperuser nocreatedb nocreaterole;$`,
      ),
    );
    const password = /password '([0-9a-f]{48})'/.exec(statement)?.[1] ?? '';
    expect(result.calls.some((call) => call.includes(`create database ${SCRATCH} owner ${SCRATCH}`))).toBe(true);
    // The restore connects as that role, never as the owner of the server.
    expect(
      result.calls.some((call) =>
        call.endsWith(
          `pg_restore --clean --if-exists --no-owner --exit-on-error --dbname postgres://${SCRATCH}:${password}@postgres:5432/${SCRATCH}`,
        ),
      ),
    ).toBe(true);
    expect(result.calls.some((call) => call.includes(`drop database if exists ${SCRATCH} with (force)`))).toBe(true);
    expect(result.calls.some((call) => call.includes(`drop role if exists ${SCRATCH}`))).toBe(true);
    expect(result.out).toContain('ledger_entries sum to zero');
    expect(result.out).toContain('orders: 11');
    expect(result.out).toContain('restore drill passed');
    // The password is in no output.
    expect(result.out + result.err).not.toContain(password);
  });

  it('fails, and still drops the scratch database and the role, when the ledger does not sum to zero', () => {
    listing('backup:gsm-backups/db/daily/', ['gsm-20261109T011500Z.dump.age']);
    const result = runScript('restore-drill.sh', ['--identity', identity()], {
      MIGRATIONS_DIR: migrationsDir(3),
      STUB_LEDGER: 'f',
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('do not sum to zero');
    expect(result.calls.some((call) => call.includes('drop database if exists'))).toBe(true);
    expect(result.calls.some((call) => call.includes('drop role if exists'))).toBe(true);
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

describe('config-copy.sh', () => {
  const NAME = 'gsm-config-20261110T011500Z.tar.gz.age';
  const CONFIG = 'backup:gsm-backups/config';
  const AGE_FILE = 'age-encryption.org/v1\n-> X25519 stub\nencrypted bytes\n';

  it('copies an age file from its standard input to config/ and checks the object there', () => {
    listing(`${CONFIG}/`, [`12;gsm-config-20261109T011500Z.tar.gz.age`, `1234;${NAME}`]);
    const result = runScript('config-copy.sh', [NAME], {}, AGE_FILE);
    expect(result.code).toBe(0);
    const copies = result.calls.filter((call) => call.startsWith('rclone copyto'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(new RegExp(`^rclone copyto \\S+/${NAME} ${CONFIG}/${NAME}$`));
    expect(result.calls).toContain(`rclone lsf --files-only --format sp --separator ; ${CONFIG}/`);
    expect(result.calls.some((call) => /rclone (delete|deletefile|purge|sync)/.test(call))).toBe(false);
    expect(result.out).toContain('1234 bytes');
  });

  it('refuses an input that is not an age file, so a plaintext configuration never reaches the bucket, and uploads nothing', () => {
    for (const input of [
      'ROOT=/opt/gsm\nENCRYPTION_KEYS=k1:secret\n',
      '',
      'age-encryption.org/v1',
      '-----BEGIN AGE ENCRYPTED FILE-----\n',
    ]) {
      for (const dry of [undefined, '1']) {
        const result = runScript('config-copy.sh', [NAME], { BACKUP_DRY_RUN: dry, BACKUP_ALLOW_PLAINTEXT: '1' }, input);
        expect(result.code, JSON.stringify(input)).toBe(1);
        expect(result.err, JSON.stringify(input)).toContain('is not an age-encrypted file');
        expect(result.err, JSON.stringify(input)).toContain('nothing was uploaded');
        expect(result.calls, JSON.stringify(input)).toEqual([]);
        expect(result.err, JSON.stringify(input)).not.toContain('rclone copyto');
      }
    }
  });

  it('accepts only the name gsm-config-<UTC stamp>.tar.gz.age, before reading anything', () => {
    for (const name of [
      'gsm-config-20261110T011500.tar.gz.age',
      'gsm-config-20261110T011500Z.tar.gz',
      'gsm-config-2026111T011500Z.tar.gz.age',
      '../gsm-config-20261110T011500Z.tar.gz.age',
      'db/daily/gsm-20261110T011500Z.dump.age',
    ]) {
      const result = runScript('config-copy.sh', [name], {}, AGE_FILE);
      expect(result.code, name).toBe(1);
      expect(result.err, name).toContain('the object name must be gsm-config-<YYYYMMDDTHHMMSSZ>.tar.gz.age');
      expect(result.calls, name).toEqual([]);
    }
    expect(runScript('config-copy.sh', [], {}, AGE_FILE).code).toBe(1);
    expect(runScript('config-copy.sh', [NAME, NAME], {}, AGE_FILE).code).toBe(1);
  });

  it('fails when the uploaded object is missing or empty', () => {
    listing(`${CONFIG}/`, [`0;${NAME}`]);
    const empty = runScript('config-copy.sh', [NAME], {}, AGE_FILE);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain(`uploaded object ${NAME} is missing or empty`);
    listing(`${CONFIG}/`, ['99;gsm-config-20261109T011500Z.tar.gz.age']);
    const missing = runScript('config-copy.sh', [NAME], {}, AGE_FILE);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('missing or empty');
  });

  it('prints the copy in a dry run and runs nothing', () => {
    const result = runScript('config-copy.sh', [NAME], { BACKUP_DRY_RUN: '1' }, AGE_FILE);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(new RegExp(`\\+ rclone copyto \\S+/${NAME} ${CONFIG}/${NAME}\n`));
    expect(result.calls).toEqual([]);
  });
});

describe('offsite-status.sh', () => {
  const DAILY = 'backup:gsm-backups/db/daily/';
  const MONTHLY = 'backup:gsm-backups/db/monthly/';
  const CONFIG = 'backup:gsm-backups/config/';
  const FILES = 'backup:gsm-backups/files-age/';

  /** The key=value lines of standard output, as an object; fails the test on any other line there. */
  const parse = (out: string): Record<string, string> => {
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) expect(line).toMatch(/^[a-z_]+=/);
    return Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  };

  it('prints the counts and the newest object by name, with its size, of each prefix, and only key=value lines on standard output', () => {
    listing(DAILY, [
      '12;gsm-20261108T011500Z.dump.age',
      '1234;gsm-20261110T011500Z.dump.age',
      '99;gsm-20261109T011500Z.dump.age',
    ]);
    listing(MONTHLY, ['5000;gsm-20261101T011500Z.dump.age', '4000;gsm-20261001T011500Z.dump.age']);
    listing(CONFIG, ['900;gsm-config-20261110T011500Z.tar.gz.age']);
    listing(FILES, ['a/1.pdf.age', 'b/c/2.png.age', 'b/3.pdf.age']);
    const result = runScript('offsite-status.sh', []);
    expect(result.code).toBe(0);
    expect(parse(result.out)).toEqual({
      daily_count: '3',
      daily_newest: 'gsm-20261110T011500Z.dump.age',
      daily_newest_bytes: '1234',
      monthly_count: '2',
      monthly_newest: 'gsm-20261101T011500Z.dump.age',
      monthly_newest_bytes: '5000',
      config_count: '1',
      config_newest: 'gsm-config-20261110T011500Z.tar.gz.age',
      config_newest_bytes: '900',
      files_count: '3',
    });
    expect(result.calls).toContain(`rclone lsf --files-only -R ${FILES}`);
    // Read-only: nothing but listings.
    expect(result.calls.every((call) => call.startsWith('rclone lsf'))).toBe(true);
  });

  it('counts a prefix that does not exist yet (rclone exit code 3) as empty', () => {
    listing(DAILY, ['1234;gsm-20261110T011500Z.dump.age']);
    const result = runScript('offsite-status.sh', [], { STUB_LSF_FAIL: 'db/monthly', STUB_LSF_FAIL_CODE: '3' });
    expect(result.code).toBe(0);
    const status = parse(result.out);
    expect(status.daily_count).toBe('1');
    expect(status.monthly_count).toBe('0');
    expect(status.monthly_newest).toBe('');
    expect(status.monthly_newest_bytes).toBe('');
    expect(status.config_count).toBe('0');
    expect(status.files_count).toBe('0');
  });

  it('fails on any other listing failure: an unreadable bucket is never taken for an empty one', () => {
    listing(DAILY, ['1234;gsm-20261110T011500Z.dump.age']);
    for (const [prefix, code] of [
      ['db/daily', '1'],
      ['db/monthly', '2'],
      ['config', '5'],
      ['files-age', '7'],
    ] as const) {
      const result = runScript('offsite-status.sh', [], { STUB_LSF_FAIL: prefix, STUB_LSF_FAIL_CODE: code });
      expect(result.code, prefix).toBe(1);
      expect(result.err, prefix).toContain(`listing backup:gsm-backups/${prefix} failed (rclone exit code ${code})`);
      expect(result.out, prefix).not.toContain('files_count=');
    }
  });

  it('fails without the bucket settings', () => {
    const result = runScript('offsite-status.sh', [], { BACKUP_S3_BUCKET: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('BACKUP_S3_BUCKET');
    expect(result.out).toBe('');
  });
});

describe('lib.sh: the offsite remote', () => {
  /** The value of one rclone setting after `setup_backup_remote`, or `unset`. */
  function setting(name: string, provider?: string): string {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com',
      BACKUP_S3_BUCKET: 'gsm-backups',
      BACKUP_S3_ACCESS_KEY_ID: 'key-id',
      BACKUP_S3_SECRET_ACCESS_KEY: 'key-secret',
    };
    if (provider !== undefined) env.BACKUP_S3_PROVIDER = provider;
    const proc = Bun.spawnSync(
      [
        'bash',
        '-c',
        `. "$1"; setup_backup_remote; printf '%s' "\${!2:-unset}"`,
        'probe',
        join(SCRIPTS, 'lib.sh'),
        name,
      ],
      { env },
    );
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  }

  it('leaves out the read-back after an upload on Cloudflare R2, which refuses the version id it hands out, and nowhere else', () => {
    expect(setting('RCLONE_CONFIG_BACKUP_NO_HEAD', 'Cloudflare')).toBe('true');
    expect(setting('RCLONE_CONFIG_BACKUP_NO_HEAD', 'AWS')).toBe('unset');
    expect(setting('RCLONE_CONFIG_BACKUP_NO_HEAD')).toBe('unset');
  });

  it('never lets rclone create the bucket, whatever the provider', () => {
    expect(setting('RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET', 'Cloudflare')).toBe('true');
    expect(setting('RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET')).toBe('true');
  });
});
