// An own cost change racing a recompute of the effective cost (decision 069): `PATCH /admin/services/:id` with `ownCost` holds the service
// row `FOR UPDATE` from its start, and `recomputeEffectiveCost` (a supplier sync: the supplier's price moves, then the recompute in the same
// transaction) locks the rows `FOR NO KEY UPDATE` in id order before it reads them. So the two run one after the other in either order, and
// the final effective cost, floor and "cost changed" mark are those of that order: never an effective cost under the own cost (the CHECK
// would refuse the sync), never a floor worked out from a cost another transaction changed meanwhile. Two connections: the HTTP change on the
// app's pool and the sync on the test pool; a third connection holds the audit table so the change can be caught after it wrote the cost.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { type Database, schema as s } from '@src/infra/db';
import { recomputeEffectiveCost } from '@src/modules/catalog';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';

let t: TestApp;
let db: Database;
let pool: Pool;
let admin: AdminApi;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*', 'pricing:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A promise the test opens by hand. */
function gate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open };
}

/** Waits until a statement waits for a lock and its text matches. */
async function waitsOn(pattern: string): Promise<void> {
  await eventually(async () => {
    const { rows } = await pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
      [pattern],
    );
    return rows.length > 0 ? true : undefined;
  });
}

/**
 * Waits until `count` statements of the test database wait for a lock, or until `work` is over because it never had to wait.
 *
 * Why: the outcome decides, not the text of a statement: a recompute that does not lock (the fault this file guards against) runs
 * through, and the figures asserted afterwards are then wrong.
 */
async function waitingOrDone(work: Promise<unknown>, count: number): Promise<void> {
  let over = false;
  work.then(
    () => (over = true),
    () => (over = true),
  );
  await eventually(async () => {
    if (over) return true;
    const { rows } = await pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return rows[0]!.waiting >= count ? true : undefined;
  });
}

/**
 * A service at a base price of 20.00 with its own minimum profit of 0.50 (so the floor is the effective cost + 0.50) and one supplier
 * link at 10.00.
 */
async function serviceAt(ownCost: string): Promise<{ id: number; supplierServiceId: number }> {
  const categoryId = await insertCategory(db, { name: 'Gift cards', type: 'server' });
  const effective = Number(ownCost) > 10 ? ownCost : '10.0000';
  const id = await insertService(db, categoryId, {
    type: 'server',
    basePrice: '20.0000',
    minProfit: '0.5000',
    cost: ownCost,
    effectiveCost: effective,
  });
  const { supplierServiceId } = await insertSupplierLink(db, id, { credit: '10.0000' });
  return { id, supplierServiceId };
}

/**
 * The part of a supplier sync that matters here: the supplier's price of the linked service moves, then the effective cost is worked out
 * again in the same transaction (`SupplierSync` does `upsertSupplierServices` then `recomputeEffectiveCost`).
 *
 * @returns `recomputed`: opens once the recompute ran (the rows are held); `proceed`: lets it commit; `done`: the ids it changed
 */
function supplierSync(
  serviceId: number,
  supplierServiceId: number,
  credit: string,
  hold: boolean,
): { readonly recomputed: Promise<void>; readonly proceed: () => void; readonly done: Promise<number[]> } {
  const ran = gate();
  const go = gate();
  if (!hold) go.open();
  const done = db.transaction(async (tx) => {
    await tx.update(s.supplierServices).set({ credit }).where(eq(s.supplierServices.id, supplierServiceId));
    const moved = await recomputeEffectiveCost(tx, [serviceId]);
    ran.open();
    await go.passed;
    return moved;
  });
  // A failure before the recompute ran must not leave the test waiting for `recomputed`.
  done.catch(() => ran.open());
  return { recomputed: ran.passed, proceed: go.open, done };
}

/** The figures that count once both transactions are over. */
async function figuresOf(id: number) {
  const row = (await admin.get(`/admin/services/${id}`)).body as Record<string, unknown>;
  const [stored] = await db.select().from(s.services).where(eq(s.services.id, id));
  return {
    ownCost: row.ownCost,
    cost: row.cost,
    costChangedFrom: row.costChangedFrom,
    floorPrice: row.floorPrice,
    stored: { cost: stored!.cost, effectiveCost: stored!.effectiveCost, costWas: stored!.costWas },
  };
}

/**
 * Runs the change of the own cost first: it writes the cost and then waits at its audit row (a third connection holds the audit table),
 * still holding the service row; the sync starts and must wait for that row before it reads anything; then the change commits.
 */
async function changeFirst(id: number, supplierServiceId: number, ownCost: string, credit: string) {
  const holder = await pool.connect();
  try {
    await holder.query('begin');
    await holder.query('lock table audit_logs in share mode');
    const change = admin.patch(`/admin/services/${id}`, { ownCost });
    await waitsOn('%insert into "audit_logs"%');
    const sync = supplierSync(id, supplierServiceId, credit, false);
    // The recompute waits for the row the change holds, before its figures are read (two waiters: the change and the sync).
    await waitingOrDone(sync.done, 2);
    await holder.query('commit');
    const answer = await change;
    expect(answer.status).toBe(200);
    return { change: answer.body as Record<string, unknown>, moved: await sync.done };
  } finally {
    await holder.query('rollback').catch(() => undefined);
    holder.release();
  }
}

/** Runs the sync first: it holds the rows after its recompute; the change waits for the row; then the sync commits. */
async function syncFirst(id: number, supplierServiceId: number, ownCost: string, credit: string) {
  const sync = supplierSync(id, supplierServiceId, credit, true);
  try {
    await sync.recomputed;
    const change = admin.patch(`/admin/services/${id}`, { ownCost });
    // The change waits for the row the recompute holds (even when the recompute changed nothing).
    await waitingOrDone(change, 1);
    sync.proceed();
    const moved = await sync.done;
    const answer = await change;
    expect(answer.status).toBe(200);
    return { change: answer.body as Record<string, unknown>, moved };
  } finally {
    sync.proceed();
    await sync.done.catch(() => undefined);
  }
}

describe('an own cost raised while a supplier sync raises the supplier price (own cost 0 to 15, supplier 10 to 12)', () => {
  it('change first: the sync waits, then works from the new cost: the effective cost stays 15, no CHECK refusal', async () => {
    const { id, supplierServiceId } = await serviceAt('0.0000');
    const { change, moved } = await changeFirst(id, supplierServiceId, '15.0000', '12.0000');
    expect(change).toMatchObject({ ownCost: '15.0000', cost: '15.0000', costChangedFrom: '10.0000' });
    // The sync read the committed 15: the larger of 15 and 12 is what is stored already.
    expect(moved).toEqual([]);
    expect(await figuresOf(id)).toEqual({
      ownCost: '15.0000',
      cost: '15.0000',
      costChangedFrom: '10.0000',
      floorPrice: '15.5000',
      stored: { cost: '15.0000', effectiveCost: '15.0000', costWas: '10.0000' },
    });
  });

  it('sync first: the change waits, then works from the new supplier price: 10 to 12 to 15, the mark keeps 10', async () => {
    const { id, supplierServiceId } = await serviceAt('0.0000');
    const { change, moved } = await syncFirst(id, supplierServiceId, '15.0000', '12.0000');
    expect(moved).toEqual([id]);
    expect(change).toMatchObject({ ownCost: '15.0000', cost: '15.0000', costChangedFrom: '10.0000' });
    expect(await figuresOf(id)).toEqual({
      ownCost: '15.0000',
      cost: '15.0000',
      costChangedFrom: '10.0000',
      floorPrice: '15.5000',
      stored: { cost: '15.0000', effectiveCost: '15.0000', costWas: '10.0000' },
    });
  });
});

describe('an own cost lowered while a supplier sync raises the supplier price (own cost 15 to 5, supplier 10 to 12)', () => {
  it('change first: the sync waits, then raises the effective cost from the 10 the change left to 12: the floor is not too low', async () => {
    const { id, supplierServiceId } = await serviceAt('15.0000');
    const { change, moved } = await changeFirst(id, supplierServiceId, '5.0000', '12.0000');
    // The change fell back to the supplier's 10 (a fall: no mark).
    expect(change).toMatchObject({ ownCost: '5.0000', cost: '10.0000', costChangedFrom: null });
    // Then the sync, in that order: 10 to 12 is a rise, so the mark keeps 10.
    expect(moved).toEqual([id]);
    expect(await figuresOf(id)).toEqual({
      ownCost: '5.0000',
      cost: '12.0000',
      costChangedFrom: '10.0000',
      floorPrice: '12.5000',
      stored: { cost: '5.0000', effectiveCost: '12.0000', costWas: '10.0000' },
    });
  });

  it('sync first: the change waits, then falls back to the new supplier price 12, not to 10', async () => {
    const { id, supplierServiceId } = await serviceAt('15.0000');
    const { change, moved } = await syncFirst(id, supplierServiceId, '5.0000', '12.0000');
    // The larger of 15 and 12 was stored already.
    expect(moved).toEqual([]);
    expect(change).toMatchObject({ ownCost: '5.0000', cost: '12.0000', costChangedFrom: null });
    expect(await figuresOf(id)).toEqual({
      ownCost: '5.0000',
      cost: '12.0000',
      costChangedFrom: null,
      floorPrice: '12.5000',
      stored: { cost: '5.0000', effectiveCost: '12.0000', costWas: null },
    });
  });
});

describe('the lock of the recompute', () => {
  it('is taken even when nothing changes, and does not stop a foreign key check (a new link of the service)', async () => {
    const { id } = await serviceAt('0.0000');
    const sync = supplierSync(id, (await db.select().from(s.supplierServices))[0]!.id, '10.0000', true);
    try {
      await sync.recomputed;
      // The row is held: a change that wants it now is refused at once.
      const probe = await pool.connect();
      try {
        await probe.query('begin');
        const refused = await probe
          .query('select id from services where id = $1 for update nowait', [id])
          .then(() => 'free')
          .catch((error: { code?: string }) => error.code);
        expect(refused).toBe('55P03');
      } finally {
        await probe.query('rollback');
        probe.release();
      }
      // A new supplier link points at the service (a foreign key check takes `FOR KEY SHARE`) without waiting.
      await insertSupplierLink(db, id, { credit: '9.0000', priority: 2 });
    } finally {
      sync.proceed();
    }
    expect(await sync.done).toEqual([]);
  });
});
