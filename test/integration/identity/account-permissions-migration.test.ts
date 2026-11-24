// The stored roles of one account type (backend decision 064), migration `_account_permissions.sql`: a role that holds the merchant and
// the customer permission families unevenly (one that would lose a right, or gain one) stops the release and is named; otherwise a role
// that could block a customer gains clients:block, one that held customers:privacy only through customers:* gains it by name, a role with
// "*" is untouched, the order of the other entries is kept, and running the file again changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import {
  ACCOUNT_PERMISSIONS_SUFFIX,
  ScratchDatabases,
  appliedCount,
  migrateUntil,
  migrationStatements,
  poolOn,
} from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('amperm');
let url = '';
let pool: Pool;

beforeAll(async () => {
  const db = await scratch.create();
  url = db.url;
  await migrateUntil(url, ACCOUNT_PERMISSIONS_SUFFIX);
  pool = poolOn(url);
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await scratch.dropAll();
});

/** Inserts a role; returns its id. */
async function role(name: string, permissions: string[]): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'insert into roles (name, permissions) values ($1, $2) returning id',
    [name, permissions],
  );
  return Number(rows[0]!.id);
}

/** The permissions of every role, by name. */
async function permissionsByName(): Promise<Record<string, string[]>> {
  const { rows } = await pool.query<{ name: string; permissions: string[] }>(
    'select name, permissions from roles order by id',
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.permissions]));
}

describe('the stored roles', () => {
  it('stops on a role that reads customers but not merchants, names it, and changes nothing', async () => {
    const uneven = await role('Customer desk', ['customers:read', 'orders:read']);
    const blocker = await role('Blocker without security', ['clients:read', 'customers:read', 'customers:block']);
    // Suspending a merchant needed clients:update and clients:security; a retail suspension needs the same from now on, so a role
    // without customers:suspend would gain it.
    const suspender = await role('Merchant desk', [
      'clients:read',
      'customers:read',
      'clients:update',
      'customers:update',
      'clients:security',
      'customers:password',
    ]);
    const before = await permissionsByName();
    const migrations = await appliedCount(pool);
    let message = '';
    try {
      await migrateDatabase(url);
    } catch (error) {
      let current: unknown = error;
      while (current instanceof Error) {
        message += `${current.message}\n`;
        current = (current as Error & { cause?: unknown }).cause;
      }
    }
    expect(message).toContain('Roles hold merchant and customer permissions differently');
    expect(message).toContain(`${uneven} (Customer desk)`);
    expect(message).toContain(`${blocker} (Blocker without security)`);
    expect(message).toContain(`${suspender} (Merchant desk)`);
    expect(await permissionsByName()).toEqual(before);
    expect(await appliedCount(pool)).toBe(migrations);
    await pool.query('delete from roles where id = any($1::bigint[])', [[uneven, blocker, suspender]]);
  });

  it('adds clients:block and customers:privacy where they are due, keeps the order, and leaves "*" alone', async () => {
    await role('Support', [
      'clients:read',
      'customers:read',
      'clients:security',
      'customers:block',
      'customers:password',
    ]);
    await role('Both families', ['orders:read', 'clients:*', 'customers:*']);
    await role('Owner copy', ['*']);
    await role('Orders only', ['orders:read', 'orders:update']);
    await role('Privacy desk', ['clients:read', 'customers:read', 'customers:privacy']);
    await migrateDatabase(url);
    const after = await permissionsByName();
    expect(after['Support']).toEqual([
      'clients:read',
      'customers:read',
      'clients:security',
      'customers:block',
      'customers:password',
      'clients:block',
    ]);
    expect(after['Both families']).toEqual(['orders:read', 'clients:*', 'customers:*', 'customers:privacy']);
    expect(after['Owner copy']).toEqual(['*']);
    expect(after['Orders only']).toEqual(['orders:read', 'orders:update']);
    expect(after['Privacy desk']).toEqual(['clients:read', 'customers:read', 'customers:privacy']);
  });

  it('changes nothing when its statements run a second time', async () => {
    const before = await permissionsByName();
    for (const statement of migrationStatements(ACCOUNT_PERMISSIONS_SUFFIX)) await pool.query(statement);
    expect(await permissionsByName()).toEqual(before);
  });
});

describe('an empty database', () => {
  it('runs with no role to change', async () => {
    const db = await scratch.create();
    expect(await migrateDatabase(db.url)).toBeGreaterThan(0);
  });
});
