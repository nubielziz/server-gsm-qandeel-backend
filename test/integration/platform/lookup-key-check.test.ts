// The boot check of LOOKUP_HASH_KEY (decision 054): the first start writes its marker, the same key passes, another key stops
// a production start and only warns elsewhere, two processes starting together write one marker, and a database that does not answer
// stops a production start and only warns elsewhere. Real Postgres; test apps leave the root modules' check out, so each case provides
// LookupKeyCheck itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '@src/config';
import { TokenService, hashToken } from '@src/infra/crypto';
import { type Database, DbService, createDrizzle, createPool, schema as s } from '@src/infra/db';
import {
  LOOKUP_KEY_CHECK_LABEL,
  LOOKUP_KEY_CHECK_SETTING,
  LookupKeyCheck,
  SettingsService,
} from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { productionEnvOnTestInstances } from '../../support/auth';
import { DB_FAILURE_MARKER, drizzleFailure, pgRefusal } from '../../support/db-failure';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';

const KEY = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
let db: Database;
const apps: TestApp[] = [];

beforeAll(async () => {
  ({ db } = await testDb());
});
beforeEach(async () => {
  await resetDb();
  logSink.clear();
});
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await resetDb();
  await closeTestDb();
});

/** A test app that runs the check while it starts, as the API and the worker do. */
async function startWith(env: Record<string, string>): Promise<TestApp> {
  const app = await createTestApp({ env, providers: [LookupKeyCheck] });
  apps.push(app);
  return app;
}
const markers = () => db.select().from(s.settings).where(eq(s.settings.key, LOOKUP_KEY_CHECK_SETTING));
const warnings = () =>
  logSink.lines.filter((line) => line.msg === 'Configuration warning' && line.variable === 'LOOKUP_HASH_KEY');

/** The check of a started app, on another database and in the given environment. */
function checkOn(app: TestApp, db: unknown, isProduction: boolean): LookupKeyCheck {
  const config: AppConfig = { ...app.app.get<AppConfig>(APP_CONFIG), isProduction };
  return new LookupKeyCheck(
    { db } as unknown as DbService,
    app.app.get(SettingsService),
    app.app.get(TokenService),
    config,
  );
}
/** A database whose every insert fails with `failure`. */
function failingDb(failure: Error): unknown {
  const returning = () => Promise.reject(failure);
  return { insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }) };
}
/** What `verify` threw, or `undefined` when it returned. */
const thrown = (check: LookupKeyCheck): Promise<Error | undefined> =>
  check.verify().then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe('the boot check of LOOKUP_HASH_KEY', () => {
  it('the first start writes the marker and a start with the same key passes', async () => {
    const first = await startWith({ LOOKUP_HASH_KEY: KEY });
    expect((await markers()).map((row) => row.value)).toEqual([hashToken(KEY, LOOKUP_KEY_CHECK_LABEL)]);
    expect(await first.app.get(LookupKeyCheck).verify()).toBe('same');
    await startWith({ LOOKUP_HASH_KEY: KEY });
    expect(await markers()).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it('another key stops a production start, with a message that names the setting and no value', async () => {
    await startWith({ LOOKUP_HASH_KEY: KEY });
    const failure = await createTestApp({
      env: productionEnvOnTestInstances({ LOOKUP_HASH_KEY: OTHER }),
      providers: [LookupKeyCheck],
    }).then(
      (app) => {
        apps.push(app);
        return undefined;
      },
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain('LOOKUP_HASH_KEY');
    expect(failure?.message).toContain('would stop matching');
    expect(failure?.message).not.toContain(OTHER);
    expect(failure?.message).not.toContain(KEY);
    expect((await markers()).map((row) => row.value)).toEqual([hashToken(KEY, LOOKUP_KEY_CHECK_LABEL)]);
  });

  it('another key only warns outside production, once, and keeps the marker', async () => {
    await startWith({ LOOKUP_HASH_KEY: KEY });
    logSink.clear();
    const other = await startWith({ LOOKUP_HASH_KEY: OTHER });
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(warnings())).not.toContain(OTHER);
    expect(await other.app.get(LookupKeyCheck).verify()).toBe('changed');
    expect((await markers()).map((row) => row.value)).toEqual([hashToken(KEY, LOOKUP_KEY_CHECK_LABEL)]);
  });

  it('two processes starting together write one marker', async () => {
    const [a, b] = await Promise.all([startWith({ LOOKUP_HASH_KEY: KEY }), startWith({ LOOKUP_HASH_KEY: KEY })]);
    expect(await markers()).toHaveLength(1);
    await resetDb();
    const verdicts = await Promise.all([a.app.get(LookupKeyCheck).verify(), b.app.get(LookupKeyCheck).verify()]);
    expect(verdicts.sort()).toEqual(['first', 'same']);
    expect(await markers()).toHaveLength(1);
  });

  it('a database that does not answer stops a production start, without the statement, and only warns elsewhere', async () => {
    const app = await startWith({ LOOKUP_HASH_KEY: KEY });
    // Nothing listens on port 1: the driver's connection is refused, as when Postgres is down.
    const pool = createPool('postgres://gsm:gsm@127.0.0.1:1/gsm', 1);
    try {
      const unreachable = createDrizzle(pool);
      const failure = await thrown(checkOn(app, unreachable, true));
      expect(failure?.message).toStartWith('LOOKUP_HASH_KEY could not be checked against the stored lookups');
      expect(failure?.message).toContain('the database did not answer');
      expect(failure?.message).not.toContain('insert into');
      expect(failure?.message).not.toContain(hashToken(KEY, LOOKUP_KEY_CHECK_LABEL));
      expect(failure?.cause).toBeUndefined();
      expect(warnings()).toEqual([]);

      expect(await checkOn(app, unreachable, false).verify()).toBe('unreachable');
      expect(warnings()).toHaveLength(1);
      expect(String(warnings()[0]?.warning)).toContain('the database did not answer');
    } finally {
      await pool.end();
    }
    expect(await markers()).toHaveLength(1);
  });

  it('a server that takes no statement now counts as no answer; any other failure stops the start everywhere', async () => {
    const app = await startWith({ LOOKUP_HASH_KEY: KEY });
    const starting = failingDb(drizzleFailure(pgRefusal({ code: '57P03', table: undefined, constraint: undefined })));
    expect((await thrown(checkOn(app, starting, true)))?.message).toContain('the database did not answer');
    expect(await checkOn(app, starting, false).verify()).toBe('unreachable');
    logSink.clear();

    const broken = failingDb(drizzleFailure(pgRefusal({ code: '42P01', table: undefined, constraint: undefined })));
    for (const isProduction of [true, false]) {
      const failure = await thrown(checkOn(app, broken, isProduction));
      expect(failure?.message).toContain(
        'LOOKUP_HASH_KEY could not be checked against the stored lookups: Database error 42P01',
      );
      expect(failure?.message).not.toContain('did not answer');
      expect(failure?.message).not.toContain(DB_FAILURE_MARKER);
      expect(failure?.message).not.toContain('insert into');
    }
    expect(warnings()).toEqual([]);
  });

  it('is hidden from the settings route', async () => {
    const app = await startWith({ LOOKUP_HASH_KEY: KEY });
    const { adminWith } = await import('../../support/admin-api');
    const owner = await adminWith(app, ['*']);
    const res = await owner.get('/admin/settings');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).not.toContain(LOOKUP_KEY_CHECK_SETTING);
    expect((await owner.patch('/admin/settings', { [LOOKUP_KEY_CHECK_SETTING]: 'x' })).status).toBe(422);
  });
});
