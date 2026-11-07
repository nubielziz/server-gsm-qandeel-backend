// Seeder of the orders module: the demo's merchant (B2B) orders with their timelines, mapped exactly as the frontend mock maps them
// (src/mocks/orders.ts of the frontend): ids without the `ORD-` prefix, the five demo states as `status` + `dispatch_state` (the queue is
// derived), review reasons on the event that opened the queue, pricing snapshots, the manual order and the two verification requests of
// `enrich`. Their holds and settlements are in the ledger already (the money seed replays the demo's journals): this seeder links the
// orders to them and posts nothing.
//
// Left for later features, by the lead's seed order (2026-11-07): `supplier_id`, `supplier_service_id` and `supplier_ref` stay null (feature 6
// fills them: its seeder runs before this one and this seeder then links the supplier of each order by name); the storefront (B2C)
// orders need customers (14b) and arrive with 14b and 16.
import type { AppConfig } from '../../src/config';
import { hashToken } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { MANUAL_REASON, VERIFICATION_REASON } from '../../src/modules/orders/domain/order-timeline';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, syncIdentity } from './helpers';

type DemoEvent = { ts: number; k: string; text: string; by: string };

/** An order of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoOrder {
  id: string;
  mid?: string;
  cid?: string;
  sid: string;
  input: string;
  device?: string | null;
  qty: number;
  created: number;
  status: 'queued' | 'processing' | 'review' | 'completed' | 'rejected';
  price: number;
  list?: number;
  cost: number;
  source: string;
  chan: string;
  reason: string | null;
  doneAt: number | null;
  reply: string | null;
  events: DemoEvent[];
  updated?: number;
  risk?: { decision: string; reviewedAt: number | null };
}

/** A service of the demo seed (the fields a pricing snapshot needs). */
interface DemoService {
  id: string;
  type: 'IMEI' | 'Server' | 'Remote' | 'File';
  cost: number;
  markup: number;
  price: number;
  minProfit: number;
}

/** The demo's channel names as `orders.source` values (B12). */
const SOURCES: Readonly<Record<string, 'dhru' | 'v1' | 'portal' | 'store'>> = {
  'Dhru API': 'dhru',
  'REST API': 'v1',
  Portal: 'portal',
  Storefront: 'store',
};

type OrderInsert = typeof s.orders.$inferInsert & { id: number };
type EventInsert = typeof s.orderEvents.$inferInsert;

/** Where an order stands, as the frontend mock's `stateOf` says, in the engine's words (decision 025). */
function stateOf(order: DemoOrder): Pick<OrderInsert, 'status' | 'dispatchState'> {
  switch (order.status) {
    case 'completed':
    case 'rejected':
      return { status: order.status, dispatchState: 'done' };
    case 'queued':
      return { status: 'pending', dispatchState: 'pending' };
    case 'processing':
      return { status: 'processing', dispatchState: 'sent' };
    case 'review':
      // The mock keeps a supplier problem as a processing order that needs attention; a manual one waits as pending.
      return order.reason === MANUAL_REASON
        ? { status: 'pending', dispatchState: 'manual' }
        : { status: 'processing', dispatchState: 'needs_attention' };
  }
}

/** What the resolver decided at order time, as the mock writes it (`snapshotOf`): the price source and the steps that led to it. */
function snapshotOf(order: DemoOrder, service: DemoService): Record<string, unknown> {
  const unit = order.price / order.qty;
  const floor = service.cost + service.minProfit;
  const base = { source: order.source, price: toMoney(unit), floor: toMoney(floor), clamped: false, fx: 1, taxRate: 0 };
  const fixed = order.source === 'client' || order.source === 'group';
  return {
    ...base,
    steps: [
      {
        id: 'client',
        label: 'Client override',
        state: order.source === 'client' ? 'win' : 'none',
        value: order.source === 'client' ? unit : null,
        after: order.source === 'client' ? unit : null,
        note: order.source === 'client' ? 'Fixed price set for this merchant' : 'None for this merchant',
      },
      {
        id: 'group',
        label: 'Group service price',
        state: order.source === 'group' ? 'win' : order.source === 'client' ? 'skip' : 'none',
        value: order.source === 'group' ? unit : null,
        after: order.source === 'group' ? unit : null,
        note: order.source === 'group' ? 'Group price for this service' : 'None for the merchant’s group',
      },
      {
        id: 'base',
        label: 'Base price',
        state: fixed ? 'skip' : 'apply',
        value: service.price,
        after: fixed ? null : unit,
        note: fixed
          ? 'Skipped, a fixed price applies'
          : `Cost ${toMoney(service.cost)} plus ${Math.round(service.markup * 100)}% markup`,
      },
    ],
  };
}

/** The merchant's cost of a settlement in a demo timeline line ("Settled: revenue $3.31, cost $2.40"). */
function settledCost(text: string): string | null {
  const match = /cost \$([\d.]+)/.exec(text);
  return match ? toMoney(Number(match[1])) : null;
}

/** The two newest completed merchant orders wait for a verification decision (the mock's `enrich`: the demo has none). */
function verificationOrderIds(orders: readonly DemoOrder[]): Set<string> {
  return new Set(
    orders
      .filter((order) => order.status === 'completed' && order.doneAt)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      .slice(0, 2)
      .map((order) => order.id),
  );
}

/**
 * Seeds the demo's merchant orders and their timelines.
 *
 * Why: seed = frontend mocks (decision 014): the console's Orders page, merchant drawers and dashboard read the demo's orders through
 * the real API. Idempotent: an order that exists is skipped with its timeline (the timeline has no key to conflict on, so it is
 * written only for orders this run inserted).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (its token pepper keys the duplicate fingerprints of the orders); without it the
 *   fingerprints are left out
 * @returns one report per table
 */
export async function seedOrders(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const demoOrders = demoRows<DemoOrder>(demo, 'orders').filter((order) => order.mid !== undefined);
  const services = new Map(demoRows<DemoService>(demo, 'services').map((service) => [service.id, service]));
  const staff = new Map(
    demoRows<{ id: string; name: string }>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]),
  );
  const merchants = new Map(demoRows<{ id: string; name: string }>(demo, 'merchants').map((m) => [m.id, m]));
  const known = await db.select({ id: s.clients.id }).from(s.clients);
  const clientIds = new Set(known.map((row) => row.id));
  const suppliers = new Map(
    (await db.select({ id: s.suppliers.id, name: s.suppliers.name }).from(s.suppliers)).map((row) => [
      row.name,
      row.id,
    ]),
  );

  const verifying = verificationOrderIds(demoOrders.filter((order) => order.mid));
  const firstQueued = demoOrders.find((order) => order.status === 'queued');

  const orderRows: OrderInsert[] = [];
  const eventsOf = new Map<number, EventInsert[]>();
  let skipped = 0;
  for (const demoOrder of demoOrders) {
    const clientId = demoNumericId(demoOrder.mid!);
    const service = services.get(demoOrder.sid);
    if (!clientIds.has(clientId) || !service) {
      skipped += 1;
      continue;
    }
    const id = demoNumericId(demoOrder.id);
    const merchant = merchants.get(demoOrder.mid!);
    const manual = demoOrder === firstQueued;
    const verification = verifying.has(demoOrder.id);
    const state = manual ? { status: 'pending' as const, dispatchState: 'manual' as const } : stateOf(demoOrder);
    const dispatched = manual ? undefined : demoOrder.events.find((event) => event.k === 'dispatch');
    const createdAt = toDate(demoOrder.created)!;
    const serviceId = demoNumericId(service.id);
    const squashed = demoOrder.input.replace(/\s+/g, '').toLowerCase();

    // The actor of a demo timeline line by its name: staff by name, the merchant (or its API) as the client, a supplier by name when
    // the suppliers are seeded, otherwise the system.
    const actorOf = (by: string): Pick<EventInsert, 'actorType' | 'actorId'> => {
      const staffId = staff.get(by);
      if (staffId !== undefined) return { actorType: 'staff', actorId: staffId };
      if (by === 'Merchant API' || by === merchant?.name) return { actorType: 'client', actorId: clientId };
      const supplierId = suppliers.get(by);
      if (supplierId !== undefined) return { actorType: 'supplier', actorId: supplierId };
      // The system, and any other name the demo has no account for (a customer or a supplier that is not seeded yet).
      return { actorType: 'system', actorId: null };
    };
    const kept = manual
      ? demoOrder.events.filter((event) => event.k === 'created' || event.k === 'hold')
      : demoOrder.events;
    const lines: EventInsert[] = kept.map((event) => ({
      orderId: id,
      type: event.k as EventInsert['type'],
      ...actorOf(event.by),
      data: {
        message: event.text,
        ...(event.k === 'review' ? { reason: event.text } : {}),
        ...(event.k === 'settle'
          ? { revenue: toMoney(demoOrder.price), cost: settledCost(event.text) ?? toMoney(0) }
          : {}),
      },
      createdAt: toDate(Math.round(event.ts))!,
    }));
    if (manual) {
      const hold = kept.find((event) => event.k === 'hold');
      lines.push({
        orderId: id,
        type: 'review',
        actorType: 'system',
        actorId: null,
        data: { message: MANUAL_REASON, reason: MANUAL_REASON },
        createdAt: toDate((hold?.ts ?? demoOrder.created) + 1000)!,
      });
    }
    if (verification) {
      lines.push({
        orderId: id,
        type: 'verification',
        actorType: 'client',
        actorId: clientId,
        data: { message: 'Verification requested by the merchant', reason: VERIFICATION_REASON },
        createdAt: toDate(Math.round((demoOrder.doneAt ?? demoOrder.created) + 30 * 60_000))!,
      });
    }
    eventsOf.set(
      id,
      lines.sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime()),
    );

    const supplierName = manual
      ? undefined
      : demoOrder.events.find((event) => suppliers.has(event.by) && event.k === 'dispatch')?.by;
    orderRows.push({
      id,
      clientId,
      serviceId,
      type: service.type.toLowerCase() as OrderInsert['type'],
      source: SOURCES[demoOrder.chan] ?? 'portal',
      ...state,
      imei: demoOrder.input,
      quantity: demoOrder.qty,
      inputs: demoOrder.device ? { device: demoOrder.device } : {},
      unitPrice: toMoney(demoOrder.price / demoOrder.qty),
      totalPrice: toMoney(demoOrder.price),
      unitCost: toMoney(demoOrder.cost / demoOrder.qty),
      totalCost: toMoney(demoOrder.cost),
      currency: 'USD',
      pricingSnapshot: snapshotOf(demoOrder, service),
      supplierId: supplierName === undefined ? null : (suppliers.get(supplierName) ?? null),
      resultCode:
        demoOrder.status === 'completed' ? demoOrder.reply : demoOrder.status === 'rejected' ? demoOrder.reason : null,
      verificationStatus: verification ? 'requested' : null,
      fingerprint:
        config && squashed !== ''
          ? hashToken(config.security.tokenPepper, `order-duplicate:${clientId}:${serviceId}:${squashed}`)
          : null,
      // Both timestamps are the demo's placement time, as a placement writes them (placed_at equals created_at).
      placedAt: createdAt,
      createdAt,
      updatedAt: toDate(Math.round(demoOrder.updated ?? demoOrder.created))!,
      sentAt: toDate(dispatched?.ts),
      completedAt: demoOrder.doneAt ? toDate(Math.round(demoOrder.doneAt)) : null,
    });
  }
  if (skipped > 0)
    console.log(`  orders    skipped ${skipped} demo orders of merchants or services that are not seeded`);

  // Orders first, in chunks; the timeline is written only for the orders this run inserted.
  const inserted = new Set<number>();
  for (let start = 0; start < orderRows.length; start += 200) {
    const chunk = orderRows.slice(start, start + 200);
    const written = await db
      .insert(s.orders)
      .overridingSystemValue()
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: s.orders.id });
    for (const row of written) inserted.add(row.id);
  }
  const lines = [...inserted].sort((a, b) => a - b).flatMap((id) => eventsOf.get(id) ?? []);
  for (let start = 0; start < lines.length; start += 500) {
    await db.insert(s.orderEvents).values(lines.slice(start, start + 500));
  }
  for (const table of [s.orders, s.orderEvents]) await syncIdentity(db, table);
  return [
    { table: 'orders', inserted: inserted.size, existing: orderRows.length - inserted.size },
    { table: 'order_events', inserted: lines.length, existing: 0 },
  ];
}
