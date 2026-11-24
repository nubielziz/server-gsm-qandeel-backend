// Integration test of the data migration of decision 062 as one file: the parts each retired feature owns are proved by the tests of those
// features (they run the same file); this one proves what only the whole file shows: the API keys made for the retired REST API v1 are
// revoked, a role that holds permissions of several retired areas loses them all in one rewrite, and the whole file runs twice on an empty
// database. The migration is found by the end of its name, not its number.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { insertMerchant } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { migrationFileName } from '../../support/migration-files';

const FOLDER = join(import.meta.dir, '../../../drizzle');
const SUFFIX = '_retired_features.sql';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, migrationFileName(SUFFIX)), 'utf8'));
}

/** A time far in the past, so a rewrite of a row shows. */
const PAST = new Date('2026-01-01T00:00:00.000Z');

describe('the migration of the retired features (decision 062)', () => {
  it('exists in the migrations folder, numbered', () => {
    expect(migrationFileName(SUFFIX)).toMatch(/^\d{4}_retired_features\.sql$/);
  });

  it('revokes a key made for the retired REST API v1 only, keeps every Dhru key and every key without scopes, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db);
    const key = async (name: string, scopes: string[], revokedAt: Date | null = null) =>
      (
        await db
          .insert(s.apiKeys)
          .values({
            clientId: merchant,
            name,
            prefix: name.slice(0, 8),
            keyHash: `hash-of-${name}`,
            scopes,
            allowedIps: [],
            rateLimitPerMin: 60,
            revokedAt,
            updatedAt: PAST,
          })
          .returning({ id: s.apiKeys.id })
      )[0]!.id;
    const v1Only = await key('orders-only', ['orders:read', 'orders:write']);
    const dhru = await key('dhru-key', ['dhru']);
    const both = await key('dhru-and-orders', ['orders:read', 'dhru']);
    const plain = await key('new-key', []);
    const revokedBefore = await key('old-v1-key', ['orders:read'], PAST);
    const keys = async () => await db.select().from(s.apiKeys).orderBy(asc(s.apiKeys.id));

    await migrate();
    const once = await keys();
    const of = (id: number) => once.find((row) => row.id === id)!;
    expect(of(v1Only).revokedAt).toBeInstanceOf(Date);
    expect(of(v1Only).revokedAt!.getTime()).toBeGreaterThan(PAST.getTime());
    for (const id of [dhru, both, plain]) {
      expect(of(id).revokedAt, String(id)).toBeNull();
      expect(of(id).updatedAt, String(id)).toEqual(PAST);
    }
    // A key revoked before keeps its first revocation time.
    expect(of(revokedBefore).revokedAt).toEqual(PAST);
    expect(of(revokedBefore).updatedAt).toEqual(PAST);

    await migrate();
    expect(await keys()).toEqual(once);
  });

  it('takes the permissions of every retired area out of one role in one rewrite and keeps the others in their order', async () => {
    const { db } = await testDb();
    const [role] = await db
      .insert(s.roles)
      .values({
        name: 'Back office',
        permissions: [
          'growth:read',
          'clients:read',
          'commissions:*',
          'webhooks:read',
          'orders:read',
          'growth:*',
          'webhooks:update',
          'reports:growth',
          'commissions:approve',
        ],
        updatedAt: PAST,
      })
      .returning({ id: s.roles.id });
    const roleOf = async () => (await db.select().from(s.roles)).find((row) => row.id === role!.id)!;

    await migrate();
    const once = await roleOf();
    expect(once.permissions).toEqual(['clients:read', 'orders:read', 'reports:growth']);
    expect(once.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());

    await migrate();
    expect(await roleOf()).toEqual(once);
  });

  it('runs twice on an empty database and writes nothing', async () => {
    const { db } = await testDb();
    await migrate();
    await migrate();
    expect(await db.select().from(s.clients)).toEqual([]);
    expect(await db.select().from(s.roles)).toEqual([]);
    expect(await db.select().from(s.apiKeys)).toEqual([]);
    expect(await db.select().from(s.notificationTemplates)).toEqual([]);
    expect(await db.select().from(s.settings)).toEqual([]);
    expect(await db.select().from(s.outboxEvents)).toEqual([]);
  });
});
