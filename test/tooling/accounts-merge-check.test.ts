// The check script of the release of one account type (backend decision 064; scripts/accounts-merge-check.ts): it finds the preflight
// block of the expand migration by its markers, runs it in a READ ONLY transaction and rolls back, writes an approvals file only when no
// approved pair is refused, refuses a file that is not ids only, says which approvals the settings row already holds, and migrates a
// rehearsal copy only when it is named and is not the live database. A fake client records the statements; the integration test
// test/integration/infra/accounts-expand-stops.test.ts runs the same functions against a database.
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVALS_KEY,
  ApprovalsError,
  type CommandClient,
  type CommandDeps,
  EXIT,
  type SqlClient,
  approve,
  databaseUrlOf,
  expandMigrationText,
  findingsOf,
  main,
  modeOf,
  parseApprovals,
  preflightBlockOf,
  rehearsalEnv,
  rehearsalTarget,
  runPreflight,
  storedApprovals,
} from '../../scripts/accounts-merge-check';

/** A client that records every statement and raises `stop` when the preflight block runs. */
function fakeClient(stop?: Error): { client: SqlClient; statements: string[]; values: unknown[][] } {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const client: SqlClient = {
    query(text: string, params?: unknown[]) {
      statements.push(text.startsWith('DO $$') ? 'BLOCK' : text.replace(/\s+/g, ' ').trim());
      values.push(params ?? []);
      if (text.startsWith('DO $$') && stop) return Promise.reject(stop);
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, statements, values };
}

/** The error the block raises. */
function preflightStop(findings: string): Error {
  return Object.assign(new Error(`accounts merge stopped, nothing changed: ${findings}`), {
    code: '23514',
    constraint: 'accounts_merge_preflight',
  });
}

describe('the preflight block', () => {
  it('is found between its markers in the committed expand migration, as one DO statement', () => {
    const block = preflightBlockOf(expandMigrationText());
    expect(block).toStartWith('-- Phase 0');
    expect(block).toMatch(/^DO \$\$$/m);
    expect(block).toEndWith('$$;');
    expect(block).toContain("CONSTRAINT = 'accounts_merge_preflight'");
    expect(block).not.toContain('accounts-merge:');
  });

  it('is refused when the markers are missing, repeated or reversed', () => {
    const begin = '-- accounts-merge:preflight:begin';
    const end = '-- accounts-merge:preflight:end';
    expect(() => preflightBlockOf('DO $$ BEGIN END $$;')).toThrow('exactly one preflight block');
    expect(() => preflightBlockOf(`${begin}\nDO $$ BEGIN END $$;\n${end}\n${begin}\n${end}`)).toThrow(
      'exactly one preflight block',
    );
    expect(() => preflightBlockOf(`${end}\nDO $$ BEGIN END $$;\n${begin}`)).toThrow('exactly one preflight block');
    expect(() => preflightBlockOf(`${begin}\nSELECT 1;\n${end}`)).toThrow('not a DO block');
  });
});

describe('a read-only run', () => {
  it('runs the block inside BEGIN READ ONLY and rolls back', async () => {
    const { client, statements } = fakeClient();
    expect(await runPreflight(client, 'DO $$ BEGIN END $$;')).toEqual({ clean: true, message: '', findings: [] });
    expect(statements).toEqual(['BEGIN READ ONLY', 'BLOCK', 'ROLLBACK']);
  });

  it('returns the findings of a stop, and still rolls back', async () => {
    const { client, statements } = fakeClient(preflightStop('E5 client 3 customer 9; G3 orders 5 (2 findings)'));
    const result = await runPreflight(client, 'DO $$ BEGIN END $$;');
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([
      { code: 'E5', text: 'E5 client 3 customer 9' },
      { code: 'G3', text: 'G3 orders 5' },
    ]);
    expect(statements).toEqual(['BEGIN READ ONLY', 'BLOCK', 'ROLLBACK']);
  });

  it('passes any other database error on, after the rollback', async () => {
    const { client, statements } = fakeClient(Object.assign(new Error('connection lost'), { code: '08006' }));
    let error: unknown;
    try {
      await runPreflight(client, 'DO $$ BEGIN END $$;');
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe('connection lost');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
});

describe('an approval run', () => {
  const pairs = [{ clientId: 12, customerId: 40, action: 'one_account' as const }];

  it('writes the settings row and commits when the preflight finds nothing', async () => {
    const { client, statements, values } = fakeClient();
    expect(await approve(client, 'DO $$ BEGIN END $$;', pairs)).toMatchObject({
      written: true,
      clean: true,
      refused: [],
    });
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toStartWith('insert into settings');
    expect(values[1]).toEqual([APPROVALS_KEY, JSON.stringify(pairs)]);
    expect(statements.slice(2)).toEqual(['SAVEPOINT accounts_merge_preflight', 'BLOCK', 'COMMIT']);
  });

  it('writes nothing when a finding is about an approved pair', async () => {
    const { client, statements } = fakeClient(preflightStop('E3 client 12 customer 40 (1 finding)'));
    const result = await approve(client, 'DO $$ BEGIN END $$;', pairs);
    expect(result).toMatchObject({ written: false, refused: [{ code: 'E3', text: 'E3 client 12 customer 40' }] });
    expect(statements.slice(2)).toEqual([
      'SAVEPOINT accounts_merge_preflight',
      'BLOCK',
      'ROLLBACK TO SAVEPOINT accounts_merge_preflight',
      'ROLLBACK',
    ]);
  });

  it('commits when the findings are about other rows only, and returns them', async () => {
    const { client, statements } = fakeClient(preflightStop('E5 client 7 customer 8; G1 outbox_events 3 (2 findings)'));
    const result = await approve(client, 'DO $$ BEGIN END $$;', pairs);
    expect(result).toMatchObject({ written: true, clean: false, refused: [] });
    expect(result.findings.map((finding) => finding.code)).toEqual(['E5', 'G1']);
    expect(statements.at(-1)).toBe('COMMIT');
  });
});

describe('the approvals file', () => {
  it('reads one pair per line and skips blank lines', () => {
    expect(
      parseApprovals(
        '{"clientId": 12, "customerId": 40, "action": "one_account"}\n\n{"action":"one_account","customerId":41,"clientId":13}\r\n',
      ),
    ).toEqual([
      { clientId: 12, customerId: 40, action: 'one_account' },
      { clientId: 13, customerId: 41, action: 'one_account' },
    ]);
  });

  it('refuses a line that is not ids only, names the line, and never repeats its content', () => {
    const cases: Array<[string, string]> = [
      ['not json at all user@example.test', 'Line 1 is not JSON.'],
      ['[12, 40]', 'Line 1 is not an object.'],
      [
        '{"clientId": 12, "customerId": 40, "action": "one_account", "email": "user@example.test"}',
        'Line 1 must hold exactly',
      ],
      ['{"clientId": 12, "customerId": 40}', 'Line 1 must hold exactly'],
      [
        '{"clientId": "12", "customerId": 40, "action": "one_account"}',
        'Line 1: clientId and customerId must be positive whole numbers.',
      ],
      ['{"clientId": 12.5, "customerId": 40, "action": "one_account"}', 'positive whole numbers'],
      ['{"clientId": 0, "customerId": 40, "action": "one_account"}', 'positive whole numbers'],
      ['{"clientId": 12, "customerId": 40, "action": "merge"}', 'Line 1: action must be "one_account".'],
    ];
    for (const [text, message] of cases) {
      let error: unknown;
      try {
        parseApprovals(text);
      } catch (caught) {
        error = caught;
      }
      expect(error, text).toBeInstanceOf(ApprovalsError);
      expect((error as Error).message, text).toContain(message);
      expect((error as Error).message, text).not.toContain('@');
    }
  });

  it('refuses a merchant or a customer approved twice, and an empty file', () => {
    const line = (clientId: number, customerId: number) =>
      JSON.stringify({ clientId, customerId, action: 'one_account' });
    expect(() => parseApprovals(`${line(1, 2)}\n${line(1, 3)}`)).toThrow('Line 2: merchant 1 is approved twice.');
    expect(() => parseApprovals(`${line(1, 2)}\n${line(4, 2)}`)).toThrow('Line 2: customer 2 is approved twice.');
    expect(() => parseApprovals('\n  \n')).toThrow('The file holds no approval.');
  });
});

describe('the command', () => {
  it('reads the findings of a stop message', () => {
    expect(findingsOf('accounts merge stopped, nothing changed: G7 notification_campaigns 4 (1 finding)')).toEqual([
      { code: 'G7', text: 'G7 notification_campaigns 4' },
    ]);
    expect(findingsOf('no colon here')).toEqual([]);
  });

  it('connects to the test database under NODE_ENV=test, else to the owner role when it is set', () => {
    expect(databaseUrlOf({ NODE_ENV: 'test', DATABASE_URL_TEST: 't', DATABASE_URL: 'a' })).toBe('t');
    expect(databaseUrlOf({ DATABASE_OWNER_URL: 'o', DATABASE_URL: 'a' })).toBe('o');
    expect(databaseUrlOf({ DATABASE_URL: 'a' })).toBe('a');
    expect(() => databaseUrlOf({})).toThrow('DATABASE_OWNER_URL or DATABASE_URL');
  });

  it('refuses unknown arguments and an approvals file it cannot read, before any connection', async () => {
    expect(await main(['--check'], {})).toBe(EXIT.error);
    expect(await main(['--approve'], {})).toBe(EXIT.error);
    expect(
      await main(['--approve', '/nonexistent/approvals.jsonl'], { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }),
    ).toBe(EXIT.error);
  });
});

/** The live database of the migrate service, as its owner connection names it. */
const LIVE_ENV = {
  DATABASE_OWNER_URL: 'postgres://gsm:secret@postgres:5432/gsm?application_name=check',
  DATABASE_URL: 'postgres://gsm_app:other@postgres:5432/gsm',
};

/** A command client and migration that record what they are asked; the settings row holds `stored` when given. */
function fakeCommand(options: { stored?: unknown; migrateCode?: number; stop?: Error; applied?: boolean } = {}): {
  deps: CommandDeps;
  urls: string[];
  statements: string[];
  migrations: Array<Record<string, string | undefined>>;
} {
  const urls: string[] = [];
  const statements: string[] = [];
  const migrations: Array<Record<string, string | undefined>> = [];
  const client = (url: string): CommandClient => {
    urls.push(url);
    return {
      connect: () => Promise.resolve(),
      end: () => Promise.resolve(),
      query(text: string) {
        const isBlock = /^DO \$\$/m.test(text);
        statements.push(isBlock ? 'BLOCK' : text.replace(/\s+/g, ' ').trim());
        if (text.includes('to_regclass')) return Promise.resolve({ rows: [{ applied: options.applied === true }] });
        if (text.startsWith('select value from settings')) {
          return Promise.resolve({ rows: options.stored === undefined ? [] : [{ value: options.stored }] });
        }
        if (isBlock && options.stop) return Promise.reject(options.stop);
        return Promise.resolve({ rows: [] });
      },
    };
  };
  const migrate = (env: Record<string, string | undefined>) => {
    migrations.push(env);
    return Promise.resolve(options.migrateCode ?? 0);
  };
  return { deps: { client, migrate }, urls, statements, migrations };
}

/** The console spies of the running test, restored after it. */
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
});

/** Silences the console for one test; returns the spy on console.log. */
function silence(): { readonly mock: { readonly calls: unknown[][] } } {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  restorers.push(
    () => log.mockRestore(),
    () => error.mockRestore(),
  );
  return log;
}

describe('the approvals already stored', () => {
  it('are read as ids only, and an entry of another shape is named by its place', async () => {
    const { deps } = fakeCommand({
      stored: [{ clientId: 12, customerId: 40, action: 'one_account' }, { email: 'x@example.test' }],
    });
    expect(await storedApprovals(deps.client('postgres://x@h/db'))).toEqual([
      'merchant 12 with customer 40',
      'entry 2 of another shape (the migration stops on it: E6)',
    ]);
    expect(await storedApprovals(fakeCommand().deps.client('postgres://x@h/db'))).toBeNull();
  });

  it('are printed by the read-only check, because the migration merges them', async () => {
    const logs = silence();
    const { deps, statements } = fakeCommand({ stored: [{ clientId: 12, customerId: 40, action: 'one_account' }] });
    expect(await main([], LIVE_ENV, undefined, deps)).toBe(EXIT.ok);
    const printed = logs.mock.calls.map((call) => String(call[0]));
    expect(printed).toContain(`The settings row ${APPROVALS_KEY} holds 1 approval(s); the migration merges them:`);
    expect(printed).toContain('  merchant 12 with customer 40');
    expect(statements).toContain('BEGIN READ ONLY');
  });
});

describe('a rehearsal', () => {
  const quiet = () => void silence();

  it('reads its arguments: the scratch database always follows --rehearse', () => {
    expect(modeOf([])).toEqual({ kind: 'check' });
    expect(modeOf(['--approve', 'f'])).toEqual({ kind: 'approve', file: 'f' });
    expect(modeOf(['--rehearse', 'gsm_rehearsal'])).toEqual({ kind: 'rehearse', database: 'gsm_rehearsal' });
    expect(modeOf(['--rehearse', 'gsm_rehearsal', '--approve', 'f'])).toEqual({
      kind: 'rehearse',
      database: 'gsm_rehearsal',
      file: 'f',
    });
    expect(modeOf(['--rehearse'])).toBeNull();
    expect(modeOf(['--approve', 'f', '--rehearse', 'gsm_rehearsal'])).toBeNull();
    expect(modeOf(['--rehearse', 'gsm_rehearsal', '--approve'])).toBeNull();
  });

  it('targets the named copy on the live server, with the same role and options', () => {
    const target = rehearsalTarget(LIVE_ENV, 'gsm_rehearsal');
    expect(target).toEqual({
      url: 'postgres://gsm:secret@postgres:5432/gsm_rehearsal?application_name=check',
      database: 'gsm_rehearsal',
      live: 'gsm',
    });
    expect(rehearsalEnv(LIVE_ENV, target)).toEqual({ ...LIVE_ENV, DATABASE_OWNER_URL: target.url });
    const testEnv = { NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres://gsm:x@localhost:5434/gsm_test' };
    const testTarget = rehearsalTarget(testEnv, 'gsm_copy');
    expect(rehearsalEnv(testEnv, testTarget)).toMatchObject({
      DATABASE_OWNER_URL: 'postgres://gsm:x@localhost:5434/gsm_copy',
      DATABASE_URL_TEST: 'postgres://gsm:x@localhost:5434/gsm_copy',
    });
  });

  it('refuses the live database, the server databases and a name that is not plain', () => {
    expect(() => rehearsalTarget(LIVE_ENV, 'gsm')).toThrow('Refused: gsm is the live database.');
    expect(() =>
      rehearsalTarget({ ...LIVE_ENV, DATABASE_URL: 'postgres://gsm_app:o@postgres:5432/gsm_main' }, 'gsm_main'),
    ).toThrow('is the live database');
    for (const name of ['postgres', 'template0', 'template1'])
      expect(() => rehearsalTarget(LIVE_ENV, name)).toThrow('of the server itself');
    for (const name of ['', '--approve', 'Gsm', 'gsm-rehearsal', 'gsm;drop', 'a'.repeat(64)]) {
      expect(() => rehearsalTarget(LIVE_ENV, name), name).toThrow('lower-case letters, digits and "_"');
    }
  });

  it('never connects or migrates when the name is refused', async () => {
    quiet();
    const { deps, urls, migrations } = fakeCommand();
    expect(await main(['--rehearse', 'gsm'], LIVE_ENV, undefined, deps)).toBe(EXIT.error);
    expect(await main(['--rehearse'], LIVE_ENV, undefined, deps)).toBe(EXIT.error);
    expect(urls).toEqual([]);
    expect(migrations).toEqual([]);
  });

  it('checks the copy and migrates the copy alone', async () => {
    quiet();
    const { deps, urls, migrations } = fakeCommand();
    expect(await main(['--rehearse', 'gsm_rehearsal'], LIVE_ENV, undefined, deps)).toBe(EXIT.ok);
    expect(urls).toEqual(['postgres://gsm:secret@postgres:5432/gsm_rehearsal?application_name=check']);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.DATABASE_OWNER_URL).toBe(urls[0]);
    expect(migrations[0]!.DATABASE_URL).toBe(LIVE_ENV.DATABASE_URL);
  });

  it('writes the approvals to the copy before its migration, and migrates nothing when a pair is refused', async () => {
    quiet();
    const folder = mkdtempSync(join(tmpdir(), 'accounts-merge-check-'));
    try {
      const file = join(folder, 'approvals.jsonl');
      writeFileSync(file, '{"clientId": 12, "customerId": 40, "action": "one_account"}\n');
      const written = fakeCommand();
      expect(await main(['--rehearse', 'gsm_rehearsal', '--approve', file], LIVE_ENV, undefined, written.deps)).toBe(
        EXIT.ok,
      );
      expect(written.urls).toEqual(['postgres://gsm:secret@postgres:5432/gsm_rehearsal?application_name=check']);
      expect(written.statements).toContain('COMMIT');
      expect(written.migrations).toHaveLength(1);

      const refused = fakeCommand({ stop: preflightStop('E3 client 12 customer 40 (1 finding)') });
      expect(await main(['--rehearse', 'gsm_rehearsal', '--approve', file], LIVE_ENV, undefined, refused.deps)).toBe(
        EXIT.findings,
      );
      expect(refused.migrations).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('migrates a copy taken after the expand migration as it is, and refuses approvals for it', async () => {
    quiet();
    const later = fakeCommand({ applied: true });
    expect(await main(['--rehearse', 'gsm_rehearsal'], LIVE_ENV, undefined, later.deps)).toBe(EXIT.ok);
    expect(later.migrations).toHaveLength(1);
    const folder = mkdtempSync(join(tmpdir(), 'accounts-merge-check-'));
    try {
      const file = join(folder, 'approvals.jsonl');
      writeFileSync(file, '{"clientId": 12, "customerId": 40, "action": "one_account"}\n');
      const approving = fakeCommand({ applied: true });
      expect(await main(['--rehearse', 'gsm_rehearsal', '--approve', file], LIVE_ENV, undefined, approving.deps)).toBe(
        EXIT.applied,
      );
      expect(approving.migrations).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('fails when the migration of the copy fails', async () => {
    quiet();
    const { deps } = fakeCommand({ migrateCode: 1 });
    expect(await main(['--rehearse', 'gsm_rehearsal'], LIVE_ENV, undefined, deps)).toBe(EXIT.error);
  });
});
