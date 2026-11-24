// Integration test of the data migration of decision 062 (merchant sign-up and approval were retired): the SQL is run on rows written
// before it (merchants that are still pending, with live sessions and open links, and the stored template of the approval mail) and
// run again, as a database that already has it would. No table and no column is dropped, and the status "pending" stays valid, so the
// test also proves that the rows of every other merchant and every other template are left alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertMerchant } from '../../support/auth';

const FOLDER = join(import.meta.dir, '../../../drizzle');
// The migration is found by the end of its name, not its number: the number is given again when the branch is merged.
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_retired_features.sql'));

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, NAME ?? 'missing'), 'utf8'));
}

/** A time far in the past, so a rewrite of a row shows. */
const PAST = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2036-01-01T00:00:00.000Z');

async function clientOf(id: number) {
  const { db } = await testDb();
  const [row] = await db.select().from(s.clients).where(eq(s.clients.id, id));
  return row!;
}

async function insertSession(clientId: number, tokenHash: string, revokedAt: Date | null = null): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.sessions)
    .values({
      tokenHash,
      subjectType: 'client',
      subjectId: clientId,
      stage: 'active',
      ip: '203.0.113.7',
      expiresAt: FUTURE,
      revokedAt,
      updatedAt: PAST,
    })
    .returning({ id: s.sessions.id });
  return row!.id;
}

async function insertLink(clientId: number, tokenHash: string, usedAt: Date | null = null): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.authTokens)
    .values({
      purpose: 'invite',
      subjectType: 'client',
      subjectId: clientId,
      tokenHash,
      expiresAt: FUTURE,
      usedAt,
      updatedAt: PAST,
    })
    .returning({ id: s.authTokens.id });
  return row!.id;
}

async function insertTemplate(
  event: string,
  channel: 'email' | 'telegram',
  audience: 'merchant' | 'staff',
): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
}

describe('the migration that retires merchant sign-up and approval', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('suspends every merchant that is still pending, with one fixed reason and the time of the run, and never activates one', async () => {
    const { db } = await testDb();
    const first = await insertMerchant(db, { status: 'pending', updatedAt: PAST });
    const second = await insertMerchant(db, { status: 'pending', emailVerifiedAt: PAST, updatedAt: PAST });

    await migrate();
    for (const id of [first, second]) {
      const row = await clientOf(id);
      expect(row.status, String(id)).toBe('suspended');
      expect(row.suspendedAt, String(id)).not.toBeNull();
      expect(row.suspendedAt!.getTime()).toBeGreaterThan(PAST.getTime());
      expect(row.suspendedBy, String(id)).toBeNull();
      // The console's dialog takes a reason of 3 to 140 characters: the stored one follows the same rule.
      expect(row.suspendedReason!.length).toBeGreaterThanOrEqual(3);
      expect(row.suspendedReason!.length).toBeLessThanOrEqual(140);
      expect(row.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    }
    expect((await clientOf(first)).suspendedReason).toBe((await clientOf(second)).suspendedReason);
    expect((await clientOf(second)).emailVerifiedAt).toEqual(PAST);
  });

  it('leaves an active merchant and a suspended merchant exactly as they are', async () => {
    const { db } = await testDb();
    const active = await insertMerchant(db, { status: 'active', updatedAt: PAST });
    const suspended = await insertMerchant(db, {
      status: 'suspended',
      suspendedAt: PAST,
      suspendedReason: 'Under review by staff',
      updatedAt: PAST,
    });
    const before = [await clientOf(active), await clientOf(suspended)];

    await migrate();
    expect([await clientOf(active), await clientOf(suspended)]).toEqual(before);
  });

  it('ends the live sessions and cancels the open links of those merchants only', async () => {
    const { db } = await testDb();
    const pending = await insertMerchant(db, { status: 'pending' });
    const active = await insertMerchant(db, { status: 'active' });
    const ended = new Date('2026-03-01T00:00:00.000Z');
    const live = await insertSession(pending, 'session-of-the-pending-merchant');
    const already = await insertSession(pending, 'older-session-of-the-pending-merchant', ended);
    const other = await insertSession(active, 'session-of-the-active-merchant');
    const open = await insertLink(pending, 'open-link-of-the-pending-merchant');
    const used = await insertLink(pending, 'used-link-of-the-pending-merchant', ended);
    const otherLink = await insertLink(active, 'open-link-of-the-active-merchant');

    await migrate();
    const sessions = await db.select().from(s.sessions).orderBy(asc(s.sessions.id));
    const sessionOf = (id: number) => sessions.find((row) => row.id === id)!;
    expect(sessionOf(live).revokedAt).not.toBeNull();
    expect(sessionOf(already).revokedAt).toEqual(ended);
    expect(sessionOf(other).revokedAt).toBeNull();
    const links = await db.select().from(s.authTokens).orderBy(asc(s.authTokens.id));
    const linkOf = (id: number) => links.find((row) => row.id === id)!;
    expect(linkOf(open).usedAt).not.toBeNull();
    expect(linkOf(used).usedAt).toEqual(ended);
    expect(linkOf(otherLink).usedAt).toBeNull();
  });

  it('changes nothing when it runs again', async () => {
    const { db } = await testDb();
    const pending = await insertMerchant(db, { status: 'pending' });
    await insertMerchant(db, { status: 'active' });
    await insertSession(pending, 'session-of-the-pending-merchant');
    await insertLink(pending, 'open-link-of-the-pending-merchant');
    await insertTemplate('merchant.approved', 'email', 'merchant');
    const everything = async () => ({
      clients: await db.select().from(s.clients).orderBy(asc(s.clients.id)),
      sessions: await db.select().from(s.sessions).orderBy(asc(s.sessions.id)),
      links: await db.select().from(s.authTokens).orderBy(asc(s.authTokens.id)),
      templates: await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id)),
    });

    await migrate();
    const once = await everything();
    expect(once.clients.map((row) => row.status)).toEqual(['suspended', 'active']);

    await migrate();
    expect(await everything()).toEqual(once);
  });

  it('deletes the stored templates of the approval mail on every channel and keeps every other template', async () => {
    const { db } = await testDb();
    await insertTemplate('merchant.approved', 'email', 'merchant');
    await insertTemplate('merchant.approved', 'telegram', 'merchant');
    await insertTemplate('merchant.suspended', 'email', 'merchant');
    await insertTemplate('merchant.reactivated', 'email', 'merchant');
    await insertTemplate('staff.invited', 'email', 'staff');
    const events = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await events();
    expect(once).toEqual([
      'merchant.suspended|email|merchant',
      'merchant.reactivated|email|merchant',
      'staff.invited|email|staff',
    ]);

    await migrate();
    expect(await events()).toEqual(once);
  });

  it('runs on an empty database', async () => {
    const { db } = await testDb();
    await migrate();
    expect(await db.select().from(s.clients)).toEqual([]);
    expect(await db.select().from(s.notificationTemplates)).toEqual([]);
  });
});
