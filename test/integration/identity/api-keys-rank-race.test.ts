// Integration tests of the race between an API key creation and a rank change that leaves the merchant kind (decision 064): both
// creations take the advisory lock `api-keys:<accountId>` first and then the account row `FOR UPDATE`, and refuse from that
// locked read; the rank change holds the row and revokes the keys without the advisory lock. So a creation that waits behind the rank
// change reads the new rank and refuses, no live key is left on the account, and no cycle of locks can form. Two connections: one plays the
// rank change (its transaction holds the row, as the money module's rank change does), the other is the HTTP creation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { type Database, schema as s } from '@src/infra/db';
import { ApiKeyDirectory } from '@src/modules/identity';
import { ensureRetailGroup } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { insertApiKey } from '../../support/machine-auth';
import { portalFor } from '../../support/portal-orders';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

/** A promise the test opens by hand. */
function gate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open };
}

/** Waits until a statement of the application waits for a lock and its text matches. */
async function waitsOn(pattern: string): Promise<void> {
  await eventually(async () => {
    const { rows } = await pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
      [pattern],
    );
    return rows.length > 0 ? true : undefined;
  });
}

/** The keys of an account that are not revoked. */
async function liveKeysOf(accountId: number): Promise<number> {
  const rows = await db.select().from(s.apiKeys).where(eq(s.apiKeys.clientId, accountId));
  return rows.filter((row) => row.revokedAt === null).length;
}

/**
 * The part of a rank change to retail that matters to the keys: it holds the account row, moves the rank and revokes the live keys in
 * its own transaction, without the advisory lock of the key creations.
 *
 * @param accountId the account
 * @returns `holding`: opens when the row is held; `proceed`: the test opens it to let the change write; `done`: the keys it revoked
 */
function rankChange(accountId: number): {
  readonly holding: Promise<void>;
  readonly proceed: () => void;
  readonly done: Promise<number>;
} {
  const held = gate();
  const go = gate();
  const done = (async () => {
    const retail = await ensureRetailGroup(db);
    return db.transaction(async (tx) => {
      await tx.select({ id: s.clients.id }).from(s.clients).where(eq(s.clients.id, accountId)).for('update');
      held.open();
      await go.passed;
      await tx.update(s.clients).set({ groupId: retail }).where(eq(s.clients.id, accountId));
      return t.app.get(ApiKeyDirectory).revokeLiveKeysOf(tx, accountId);
    });
  })();
  // A failure before the row is held must not leave the test waiting for `holding`.
  done.catch(() => held.open());
  return { holding: held.passed, proceed: go.open, done };
}

describe('a key creation that waits behind a rank change to retail', () => {
  it("the merchant's own creation refuses from its locked read (403 RANK_NOT_ALLOWED) and no live key is left", async () => {
    const id = await insertMerchant(db);
    const m = await portalFor(t, id);
    const old = await insertApiKey(t, db, id, { name: 'old' });
    const change = rankChange(id);
    try {
      await change.holding;
      // The request passes the gate on the merchant rank it still sees, takes the key lock and waits for the account row.
      const creation = m.call('POST', '/client/api-keys', { name: 'racer' });
      await waitsOn('%from "clients"%for update%');
      change.proceed();
      // The change finishes while the creation holds `api-keys:<id>`: its revoke never asks for that lock, so nothing deadlocks.
      expect(await change.done).toBe(1);
      const answer = await creation;
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('RANK_NOT_ALLOWED');
    } finally {
      change.proceed();
      await change.done.catch(() => undefined);
    }
    expect(await liveKeysOf(id)).toBe(0);
    const rows = await db.select().from(s.apiKeys).where(eq(s.apiKeys.clientId, id));
    expect(rows.map((row) => row.id)).toEqual([old.id]);
  });

  it("staff's creation refuses from its locked read (409 CONFLICT) and no live key is left", async () => {
    const owner = await adminWith(t, ['*']);
    const id = await insertMerchant(db);
    await insertApiKey(t, db, id, { name: 'old' });
    const change = rankChange(id);
    try {
      await change.holding;
      const creation = owner.post(`/admin/clients/${id}/api-keys`, { name: 'racer' });
      await waitsOn('%from "clients"%for update%');
      change.proceed();
      expect(await change.done).toBe(1);
      const answer = await creation;
      expect(answer.status).toBe(409);
      expect(answer.body.code).toBe('CONFLICT');
    } finally {
      change.proceed();
      await change.done.catch(() => undefined);
    }
    expect(await liveKeysOf(id)).toBe(0);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });

  it('with no rank change in flight both creations succeed (the control of the two cases above)', async () => {
    const owner = await adminWith(t, ['*']);
    const id = await insertMerchant(db);
    const m = await portalFor(t, id);
    expect((await m.call('POST', '/client/api-keys', { name: 'own' })).status).toBe(201);
    expect((await owner.post(`/admin/clients/${id}/api-keys`, { name: 'staff' })).status).toBe(201);
    expect(await liveKeysOf(id)).toBe(2);
  });
});

describe('the order of the locks', () => {
  it('a creation takes the advisory lock before the account row: while it waits for the key lock, the row is free', async () => {
    const id = await insertMerchant(db);
    const m = await portalFor(t, id);
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`api-keys:${id}`]);
      const creation = m.call('POST', '/client/api-keys', { name: 'queued' });
      await waitsOn('%pg_advisory_xact_lock%');
      // The creation holds nothing yet: the account row can be taken at once (a rank change would not have to wait for it).
      const probe = await pool.connect();
      try {
        await probe.query('begin');
        await probe.query('select id from clients where id = $1 for update nowait', [id]);
      } finally {
        await probe.query('rollback');
        probe.release();
      }
      await holder.query('commit');
      expect((await creation).status).toBe(201);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(await liveKeysOf(id)).toBe(1);
  });

  it('revokeLiveKeysOf never asks for the advisory lock of the key creations: it completes while another connection holds it', async () => {
    const id = await insertMerchant(db);
    await insertApiKey(t, db, id);
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`api-keys:${id}`]);
      let revoked: number | undefined;
      const work = db
        .transaction((tx) => t.app.get(ApiKeyDirectory).revokeLiveKeysOf(tx, id))
        .then((count) => {
          revoked = count;
        });
      await eventually(() => (revoked === undefined ? undefined : true));
      await work;
      expect(revoked).toBe(1);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(await liveKeysOf(id)).toBe(0);
  });

  it('the row held by a rank change does not block a plain read: the gate still sees the old rank, so the request reaches the use case', async () => {
    const id = await insertMerchant(db);
    const change = rankChange(id);
    try {
      await change.holding;
      const read = await db.execute(sql`select group_id from clients where id = ${id}`);
      expect(read.rows).toHaveLength(1);
    } finally {
      change.proceed();
      await change.done.catch(() => undefined);
    }
  });
});
