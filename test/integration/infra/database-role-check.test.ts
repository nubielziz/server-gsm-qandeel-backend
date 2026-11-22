// Integration tests of the boot check of the application's database role (decision 055) against the test database: the owner is refused in
// production, so is a member of the owner that inherits nothing, a member of a server file role and the owner of a database; the role the
// grants step makes passes, development never asks. Like db-grants.test.ts it creates roles with random names in the test cluster and
// drops them (a crashed run can leave one behind, harmless).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { type AppConfig, parseEnv } from '@src/config';
import {
  DatabaseRoleCheck,
  type DbService,
  applyApplicationGrants,
  databaseRoleRefusal,
  readDatabaseRole,
} from '@src/infra/db';
import { TEST_DATABASE_URL, migrateTestDb } from '../../support/db';
import { PRODUCTION_ENV } from '../../support/app';
import { rejectionOf } from '../../support/rejection';

const role = `gsm_t_${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
let owner: Pool;
let application: Pool;

/** A DbService stand-in over a pool (the check only reads `pool`). */
const dbOver = (pool: Pool): DbService => ({ pool }) as unknown as DbService;

const production = (): AppConfig => parseEnv(PRODUCTION_ENV);
const development = (): AppConfig => parseEnv({ NODE_ENV: 'development' });

beforeAll(async () => {
  await migrateTestDb();
  owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  owner.on('error', () => undefined);
  const appUrl = new URL(TEST_DATABASE_URL);
  appUrl.username = role;
  appUrl.password = password;
  await applyApplicationGrants(TEST_DATABASE_URL, appUrl.toString());
  application = new Pool({ connectionString: appUrl.toString(), max: 1 });
  application.on('error', () => undefined);
});

afterAll(async () => {
  await application.end();
  await owner.query(`drop owned by "${role}"`).catch(() => undefined);
  await owner.query(`drop role if exists "${role}"`);
  await owner.end();
});

/** A pool that connects as another role of the test cluster (to the test database unless a database name is given). */
function poolAs(user: string, database?: string): Pool {
  const url = new URL(TEST_DATABASE_URL);
  url.username = user;
  url.password = password;
  if (database !== undefined) url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  pool.on('error', () => undefined);
  return pool;
}

/** Makes a login role, runs the test with it, and drops it. */
async function withRole(body: (name: string) => Promise<void>, attributes = ''): Promise<void> {
  const name = `gsm_t_${randomBytes(4).toString('hex')}`;
  await owner.query(`create role "${name}" login ${attributes} password '${password}'`);
  try {
    await body(name);
  } finally {
    await owner.query(`drop owned by "${name}"`).catch(() => undefined);
    await owner.query(`drop role if exists "${name}"`);
  }
}

describe('readDatabaseRole', () => {
  it('sees the owner as a superuser that owns the tables, and the application role as none of it', async () => {
    expect(await readDatabaseRole(owner)).toMatchObject({ superuser: true, ownsTables: true, ownsDatabase: true });
    expect(await readDatabaseRole(application)).toEqual({
      superuser: false,
      ownsTables: false,
      serverAccess: false,
      ownsDatabase: false,
    });
  });

  it('sees a member of the owner role as holding the rights of an owner', async () => {
    await withRole(async (member) => {
      await owner.query(`grant "${new URL(TEST_DATABASE_URL).username}" to "${member}"`);
      const pool = poolAs(member);
      try {
        expect((await readDatabaseRole(pool)).ownsTables).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  it('sees a member that inherits nothing (NOINHERIT) as a member too: it can switch to the owner role', async () => {
    await withRole(async (member) => {
      const ownerRole = new URL(TEST_DATABASE_URL).username;
      await owner.query(`grant "${ownerRole}" to "${member}"`);
      // The reason for asking about membership: the rights are not inherited, yet the member can become the owner.
      const { rows } = await owner.query<{ inherits: boolean; member: boolean }>(
        "select pg_has_role($1, $2, 'USAGE') as inherits, pg_has_role($1, $2, 'MEMBER') as member",
        [member, ownerRole],
      );
      expect(rows).toEqual([{ inherits: false, member: true }]);
      const pool = poolAs(member);
      try {
        expect(await readDatabaseRole(pool)).toMatchObject({ superuser: true, ownsTables: true });
      } finally {
        await pool.end();
      }
    }, 'noinherit');
  });

  it('sees a NOINHERIT member of a role that owns a table as an owner, without any superuser right', async () => {
    const holder = `gsm_t_${randomBytes(4).toString('hex')}`;
    const table = `gsm_t_owned_${randomBytes(3).toString('hex')}`;
    await owner.query(`create role "${holder}" nologin`);
    try {
      await owner.query(`create table "${table}" (id int)`);
      await owner.query(`alter table "${table}" owner to "${holder}"`);
      await withRole(async (member) => {
        await owner.query(`grant "${holder}" to "${member}"`);
        const pool = poolAs(member);
        try {
          expect(await readDatabaseRole(pool)).toEqual({
            superuser: false,
            ownsTables: true,
            serverAccess: false,
            ownsDatabase: false,
          });
        } finally {
          await pool.end();
        }
      }, 'noinherit');
    } finally {
      await owner.query(`drop table if exists "${table}"`);
      await owner.query(`drop role if exists "${holder}"`);
    }
  });

  it('sees a member of a server file or program role', async () => {
    for (const serverRole of ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
      await withRole(async (member) => {
        await owner.query(`grant "${serverRole}" to "${member}"`);
        const pool = poolAs(member);
        try {
          expect(await readDatabaseRole(pool), serverRole).toEqual({
            superuser: false,
            ownsTables: false,
            serverAccess: true,
            ownsDatabase: false,
          });
        } finally {
          await pool.end();
        }
      });
    }
  });

  it('sees the owner of the database it is connected to', async () => {
    await withRole(async (member) => {
      const database = `gsm_t_db_${randomBytes(4).toString('hex')}`;
      await owner.query(`create database "${database}" owner "${member}"`);
      const pool = poolAs(member, database);
      try {
        expect(await readDatabaseRole(pool)).toEqual({
          superuser: false,
          ownsTables: false,
          serverAccess: false,
          ownsDatabase: true,
        });
      } finally {
        await pool.end();
        await owner.query(`drop database if exists "${database}" with (force)`);
      }
    });
  });
});

describe('DatabaseRoleCheck.verify', () => {
  it('refuses the owner in production and accepts the role the grants step made', async () => {
    const error = await rejectionOf(new DatabaseRoleCheck(dbOver(owner), production()).verify());
    expect((error as Error).message).toBe(databaseRoleRefusal({ ...(await readDatabaseRole(owner)) }) as string);
    expect((error as Error).message).toStartWith('DATABASE_URL connects as ');
    expect(await new DatabaseRoleCheck(dbOver(application), production()).verify()).toBe('ok');
  });

  it('refuses a NOINHERIT member of the owner role in production', async () => {
    await withRole(async (member) => {
      await owner.query(`grant "${new URL(TEST_DATABASE_URL).username}" to "${member}"`);
      const pool = poolAs(member);
      try {
        const error = await rejectionOf(new DatabaseRoleCheck(dbOver(pool), production()).verify());
        expect((error as Error).message).toStartWith('DATABASE_URL connects as ');
      } finally {
        await pool.end();
      }
    }, 'noinherit');
  });

  it('does not ask outside production, whatever the role is', async () => {
    expect(await new DatabaseRoleCheck(dbOver(owner), development()).verify()).toBe('skipped');
    expect(await new DatabaseRoleCheck(dbOver(owner), parseEnv({ NODE_ENV: 'test' })).verify()).toBe('skipped');
  });
});
