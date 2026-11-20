// The guard of every order update and the late reference (decision 044): an update applies only while `sent_at` is what the decision read
// (and, for a supplier's answer, while the order still names the supplier and reference it was asked about); a reference found late is
// stored only where the order has none. Real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import {
  countEventsOfType,
  findOrder,
  insertEvents,
  storeLateReference,
  updateOrderGuarded,
} from '@src/modules/orders/infra/order.repository';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow, ordersWorld, type OrdersWorld } from '../../support/orders';
import { insertBareSupplier } from '../../support/suppliers';

let db: Database;
let world: OrdersWorld;

beforeAll(async () => {
  ({ db } = await testDb());
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  world = await ordersWorld(db);
});

const SENT = new Date('2026-11-20T10:00:00.000Z');
const order = (values: Partial<typeof s.orders.$inferInsert> = {}) =>
  insertOrderRow(db, { serviceId: world.auto.serviceId, clientId: world.merchant.id, ...values });
const from = (state: Partial<Parameters<typeof updateOrderGuarded>[2]> = {}) => ({
  status: 'pending' as const,
  dispatchState: 'pending' as const,
  verificationStatus: null,
  sentAt: null,
  ...state,
});

describe('updateOrderGuarded compares sent_at', () => {
  it('does not apply a decision made on an order that was claimed after it was read', async () => {
    const claimed = await order({ dispatchState: 'pending', sentAt: SENT });
    // A decision read the order as unclaimed (sent_at null): the claim won, so the update finds nothing.
    expect(await updateOrderGuarded(db, claimed.id, from(), { dispatchState: 'needs_attention' })).toBeUndefined();
    expect((await findOrder(db, claimed.id))!.dispatchState).toBe('pending');
    // The decision that read the claim's time applies.
    expect(
      await updateOrderGuarded(db, claimed.id, from({ sentAt: SENT }), { dispatchState: 'needs_attention' }),
    ).toMatchObject({
      dispatchState: 'needs_attention',
    });
  });

  it('applies to an unclaimed order only with sent_at null, and not with a time', async () => {
    const waiting = await order({ dispatchState: 'pending', sentAt: null });
    expect(
      await updateOrderGuarded(db, waiting.id, from({ sentAt: SENT }), { dispatchState: 'manual' }),
    ).toBeUndefined();
    expect(await updateOrderGuarded(db, waiting.id, from(), { dispatchState: 'manual' })).toMatchObject({
      dispatchState: 'manual',
    });
  });

  it('applies a supplier answer only while the order still names the supplier and reference it was asked about', async () => {
    const supplierId = await insertBareSupplier(db);
    const other = await insertBareSupplier(db);
    const sent = await order({
      status: 'processing',
      dispatchState: 'sent',
      sentAt: SENT,
      supplierId,
      supplierRef: 'REF-1',
    });
    const state = { status: 'processing' as const, dispatchState: 'sent' as const, sentAt: SENT };
    const changes = { status: 'completed' as const, dispatchState: 'done' as const };
    expect(
      await updateOrderGuarded(
        db,
        sent.id,
        from({ ...state, supplier: { supplierId: other, supplierRef: 'REF-1' } }),
        changes,
      ),
    ).toBeUndefined();
    expect(
      await updateOrderGuarded(
        db,
        sent.id,
        from({ ...state, supplier: { supplierId, supplierRef: 'REF-2' } }),
        changes,
      ),
    ).toBeUndefined();
    expect(
      await updateOrderGuarded(
        db,
        sent.id,
        from({ ...state, supplier: { supplierId, supplierRef: 'REF-1' } }),
        changes,
      ),
    ).toMatchObject({ status: 'completed', dispatchState: 'done' });
  });
});

describe('storeLateReference', () => {
  it('stores the reference only where the order has none and still names that supplier', async () => {
    const supplierId = await insertBareSupplier(db);
    const other = await insertBareSupplier(db);
    const waiting = await order({ status: 'processing', dispatchState: 'needs_attention', sentAt: SENT, supplierId });
    expect(await storeLateReference(db, waiting.id, other, 'LATE-1')).toBe(false);
    expect((await findOrder(db, waiting.id))!.supplierRef).toBeNull();
    expect(await storeLateReference(db, waiting.id, supplierId, 'LATE-1')).toBe(true);
    expect((await findOrder(db, waiting.id))!.supplierRef).toBe('LATE-1');
    // A reference that is there is never overwritten.
    expect(await storeLateReference(db, waiting.id, supplierId, 'LATE-2')).toBe(false);
    expect((await findOrder(db, waiting.id))!.supplierRef).toBe('LATE-1');
    // An order with no supplier takes none.
    const bare = await order({});
    expect(await storeLateReference(db, bare.id, supplierId, 'LATE-3')).toBe(false);
  });
});

describe('countEventsOfType with an actor', () => {
  it('counts every event of a type, or only those written by one kind of actor', async () => {
    const target = await order({});
    await insertEvents(db, [
      { orderId: target.id, type: 'retry', actorType: 'system', actorId: null, data: {} },
      { orderId: target.id, type: 'retry', actorType: 'staff', actorId: 1, data: {} },
      { orderId: target.id, type: 'retry', actorType: 'system', actorId: null, data: {} },
      { orderId: target.id, type: 'review', actorType: 'system', actorId: null, data: {} },
    ]);
    expect(await countEventsOfType(db, target.id, 'retry')).toBe(3);
    expect(await countEventsOfType(db, target.id, 'retry', 'system')).toBe(2);
    expect(await countEventsOfType(db, target.id, 'retry', 'staff')).toBe(1);
    expect(await countEventsOfType(db, target.id, 'retry', 'supplier')).toBe(0);
    expect(await db.select().from(s.orderEvents).where(eq(s.orderEvents.orderId, target.id))).toHaveLength(4);
  });
});
