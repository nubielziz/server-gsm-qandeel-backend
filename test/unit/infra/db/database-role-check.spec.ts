// Unit tests of the boot check of the application's database role (decision 055), with a fake pool that answers what the test says:
// each fact that makes a role too powerful (superuser, owner of a table, server file or program role, owner of the database) is refused in
// production with its own words, the application role passes, development never asks, and an unanswered check stops a production start.
import { describe, expect, it } from 'bun:test';
import { type AppConfig, parseEnv } from '@src/config';
import {
  DATABASE_ROLE_FIX,
  DATABASE_ROLE_REASONS,
  DatabaseRoleCheck,
  type DatabaseRoleFacts,
  databaseRoleRefusal,
  readDatabaseRole,
} from '@src/infra/db';
import type { DbService } from '@src/infra/db';
import { rejectionOf } from '../../../support/rejection';

const PRODUCTION: AppConfig = parseEnv({
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example',
  PORTAL_BASE_URL: 'https://portal.gsm.example',
  CONSOLE_BASE_URL: 'https://admin.gsm.example',
  STORE_BASE_URL: 'https://shop.gsm.example',
  DATABASE_URL: 'postgres://gsm_app:app-password-0123456789@db.internal:5432/gsm',
  REDIS_QUEUE_URL: 'redis://:queue-password-0123456789@queue.internal:6379/0',
  REDIS_CACHE_URL: 'redis://:cache-password-0123456789@cache.internal:6379/0',
  TRUST_PROXY: 'false',
  S3_BUCKET: 'gsm-prod-files',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: 'c'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(40),
  LOOKUP_HASH_KEY: 'l'.repeat(40),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'm'.repeat(32),
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.gsm.example:465',
  MAIL_FROM: 'IMEI-HUB <noreply@gsm.example>',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
  FX_API_KEY: 'fx-app-id-for-tests',
  TYPESENSE_URL: 'http://typesense.internal:8108',
});
const DEVELOPMENT: AppConfig = parseEnv({ NODE_ENV: 'development' });

/** The answer of the query for one role: every fact false unless the test names it. */
const ROW = { superuser: false, owns_tables: false, server_access: false, owns_database: false };
type Row = typeof ROW;

/** A DbService whose pool answers one row (or fails) and counts its queries. */
function fakeDb(answer: Partial<Row> | Error): { db: DbService; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: (text: string) => {
      queries.push(text);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ rows: [{ ...ROW, ...answer }] });
    },
  };
  return { db: { pool } as unknown as DbService, queries };
}

const NONE: DatabaseRoleFacts = { superuser: false, ownsTables: false, serverAccess: false, ownsDatabase: false };

describe('readDatabaseRole', () => {
  it('reads each fact of the role from its own column', async () => {
    expect(await readDatabaseRole(fakeDb({}).db.pool)).toEqual(NONE);
    expect(await readDatabaseRole(fakeDb({ superuser: true }).db.pool)).toEqual({ ...NONE, superuser: true });
    expect(await readDatabaseRole(fakeDb({ owns_tables: true }).db.pool)).toEqual({ ...NONE, ownsTables: true });
    expect(await readDatabaseRole(fakeDb({ server_access: true }).db.pool)).toEqual({ ...NONE, serverAccess: true });
    expect(await readDatabaseRole(fakeDb({ owns_database: true }).db.pool)).toEqual({ ...NONE, ownsDatabase: true });
  });

  it('asks about a membership of any kind, never only about inherited rights', async () => {
    const { db, queries } = fakeDb({});
    await readDatabaseRole(db.pool);
    const query = queries[0] ?? '';
    // A member that inherits nothing can still switch to the role: 'USAGE' would miss it.
    expect(query).not.toContain("'USAGE'");
    expect(query).toContain("pg_has_role(current_user, s.oid, 'MEMBER')"); // a superuser role
    expect(query).toContain("pg_has_role(current_user, t.tableowner, 'MEMBER')"); // the owner of a table
    expect(query).toContain("pg_has_role(current_user, p.oid, 'MEMBER')"); // the server file and program roles
    expect(query).toContain("pg_has_role(current_user, d.datdba, 'MEMBER')"); // the owner of the database
    for (const role of ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files']) {
      expect(query).toContain(`'${role}'`);
    }
  });
});

describe('databaseRoleRefusal', () => {
  it('accepts a role with none of the facts', () => {
    expect(databaseRoleRefusal(NONE)).toBeUndefined();
  });

  it('refuses each fact on its own, in words that name the setting and the rule and no value', () => {
    const cases: [keyof DatabaseRoleFacts, string][] = [
      ['superuser', DATABASE_ROLE_REASONS.superuser],
      ['serverAccess', DATABASE_ROLE_REASONS.serverAccess],
      ['ownsTables', DATABASE_ROLE_REASONS.ownsTables],
      ['ownsDatabase', DATABASE_ROLE_REASONS.ownsDatabase],
    ];
    for (const [fact, reason] of cases) {
      const message = databaseRoleRefusal({ ...NONE, [fact]: true });
      expect(message, fact).toBe(`DATABASE_URL connects as ${reason}: ${DATABASE_ROLE_FIX}`);
      expect(message, fact).toStartWith('DATABASE_URL ');
    }
    expect(DATABASE_ROLE_REASONS.serverAccess).toContain('pg_execute_server_program');
    expect(DATABASE_ROLE_REASONS.serverAccess).toContain('pg_read_server_files');
    expect(DATABASE_ROLE_REASONS.serverAccess).toContain('pg_write_server_files');
  });

  it('names every rule a role breaks, and only the superuser rule for a superuser (it is a member of every role)', () => {
    expect(databaseRoleRefusal({ ...NONE, ownsTables: true, ownsDatabase: true, serverAccess: true })).toBe(
      `DATABASE_URL connects as ${DATABASE_ROLE_REASONS.serverAccess}; and as ${DATABASE_ROLE_REASONS.ownsTables}; and as ${DATABASE_ROLE_REASONS.ownsDatabase}: ${DATABASE_ROLE_FIX}`,
    );
    expect(databaseRoleRefusal({ superuser: true, ownsTables: true, serverAccess: true, ownsDatabase: true })).toBe(
      `DATABASE_URL connects as ${DATABASE_ROLE_REASONS.superuser}: ${DATABASE_ROLE_FIX}`,
    );
  });
});

describe('DatabaseRoleCheck', () => {
  it('refuses each fact in production, with the words of that fact', async () => {
    const rows: [Partial<Row>, DatabaseRoleFacts][] = [
      [{ superuser: true }, { ...NONE, superuser: true }],
      [{ server_access: true }, { ...NONE, serverAccess: true }],
      [{ owns_tables: true }, { ...NONE, ownsTables: true }],
      [{ owns_database: true }, { ...NONE, ownsDatabase: true }],
    ];
    for (const [row, facts] of rows) {
      const check = new DatabaseRoleCheck(fakeDb(row).db, PRODUCTION);
      const error = (await rejectionOf(check.verify())) as Error;
      expect(error.message, JSON.stringify(row)).toBe(databaseRoleRefusal(facts) as string);
      expect(error.message).toStartWith('DATABASE_URL connects as ');
    }
  });

  it('refuses at start through onModuleInit', async () => {
    const check = new DatabaseRoleCheck(fakeDb({ owns_tables: true }).db, PRODUCTION);
    const error = (await rejectionOf(check.onModuleInit())) as Error;
    expect(error.message).toContain(DATABASE_ROLE_REASONS.ownsTables);
  });

  it('accepts the application role', async () => {
    const check = new DatabaseRoleCheck(fakeDb({}).db, PRODUCTION);
    expect(await check.verify()).toBe('ok');
    await check.onModuleInit();
  });

  it('does not even ask outside production (the development and test databases are used as their owner)', async () => {
    const { db, queries } = fakeDb({ superuser: true, owns_tables: true, server_access: true, owns_database: true });
    expect(await new DatabaseRoleCheck(db, DEVELOPMENT).verify()).toBe('skipped');
    expect(queries).toEqual([]);
  });

  it('stops a production start that could not be checked, naming the variable and never the statement or a value', async () => {
    const failure = Object.assign(new Error('Failed query: select ... params: secret-marker'), {
      code: '57P01',
      table: undefined,
    });
    const check = new DatabaseRoleCheck(fakeDb(failure).db, PRODUCTION);
    const error = (await rejectionOf(check.verify())) as Error;
    expect(error.message).toStartWith('DATABASE_URL could not be checked');
    expect(error.message).not.toContain('secret-marker');
    expect(error.message).not.toContain('Failed query');
    expect(error.cause).toBeUndefined();
  });
});
