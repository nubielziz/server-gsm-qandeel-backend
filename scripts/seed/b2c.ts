// Seeder of the storefront money (feature 16): the demo's 104 storefront orders with their checkout session, payment, tax receipt and timeline,
// its 11 refunds and 5 disputes, mapped as the frontend mocks map them (src/features/refunds/mocks/seed.ts of the frontend): ids without the prefix
// (`SF-20400` is 20400, `RF-1007` is 1007, `DP-2005` is 2005), a payment takes the id of its order, amounts in USD in the demo become the
// payment currency at the order's rate. The journals of these orders are in the ledger already (the money seed replays the demo's journals):
// this seeder links refunds and lost disputes to them and posts nothing. Customers are 14b's: the customers seeder runs before this one and writes
// every customer of the demo, so an order whose customer is missing is skipped. Runs after the money, billing, catalog, customers and storefront seeders.
import { eq, sql } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { Money } from '../../src/common/money';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { CHECKOUT_IMEI_AAD } from '../../src/modules/customers';
import { fromUsd } from '../../src/modules/money/domain/b2c-money';
import { invoiceNumber } from '../../src/modules/money/domain/invoice-rules';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

type DemoEvent = { ts: number; k: string; text: string; by: string };

/** A storefront order of the demo (the fields the seed uses). */
interface DemoStoreOrder {
  id: string;
  cid: string;
  sid: string;
  input: string;
  device?: string | null;
  qty: number;
  created: number;
  status: 'queued' | 'processing' | 'review' | 'completed' | 'rejected';
  price: number;
  cost: number;
  sup?: string;
  reason: string | null;
  doneAt: number | null;
  reply: string | null;
  updated?: number;
  token: string;
  country: string;
  cur: string;
  fx: number;
  taxRate: number;
  tax: number;
  gross: number;
  fee: number;
  pay: { method: 'card' | 'wallet' | 'crypto'; status: string; ref: string; threeDS: boolean; brand: string };
  events: DemoEvent[];
}

/** A customer of the demo (the fields the orders use; the customer rows themselves are 14b's). */
interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  lastIp: string;
}

interface DemoRefund {
  id: string;
  oid: string;
  cid: string;
  amount: number;
  cur: string;
  reason: string;
  method: 'original' | 'manual';
  status: 'requested' | 'completed' | 'failed' | 'rejected';
  created: number;
  by: string;
  auto: boolean;
  note: string;
  gw: string | null;
}

interface DemoDispute {
  id: string;
  oid: string;
  cid: string;
  amount: number;
  cur: string;
  fee: number;
  code: string;
  status: 'needs_response' | 'under_review' | 'won' | 'lost';
  opened: number;
  due: number;
  submittedAt: number | null;
  resolvedAt: number | null;
}

type OrderInsert = typeof s.orders.$inferInsert & { id: number };
type EventInsert = typeof s.orderEvents.$inferInsert;

/** The demo's reason text of a dispute as the gateway's reason code (`Fraudulent (10.4)` is `fraudulent`). */
function reasonCodeOf(text: string): string {
  const word = text.replace(/\s*\(.*\)\s*$/, '').toLowerCase();
  if (word.includes('fraud')) return 'fraudulent';
  if (word.includes('not received')) return 'product_not_received';
  if (word.includes('unacceptable')) return 'product_unacceptable';
  if (word.includes('duplicate')) return 'duplicate';
  return 'general';
}

/** `Visa 4417` as `Visa •••• 4417`; a coin or a wallet name stays as it is (RESOLUTIONS money-4). */
function brandOf(method: 'card' | 'wallet' | 'crypto', text: string): string {
  const card = /^(\w+) (\d{4})$/.exec(text);
  if (method === 'card' && card) return `${card[1]} •••• ${card[2]}`;
  if (method === 'crypto') return text.replace('TRC20', 'TRC-20');
  return text;
}

/** The order's place in the engine, from the demo status (decision 025): a storefront order in review is held by risk. */
function stateOf(order: DemoStoreOrder): Pick<OrderInsert, 'status' | 'dispatchState'> {
  switch (order.status) {
    case 'completed':
    case 'rejected':
      return { status: order.status, dispatchState: 'done' };
    case 'queued':
      return { status: 'pending', dispatchState: 'pending' };
    case 'processing':
      return { status: 'processing', dispatchState: 'sent' };
    case 'review':
      return { status: 'pending', dispatchState: 'held' };
  }
}

/** A tracking or checkout token of the valid length (22 characters) made from the demo's shorter one. */
const longToken = (prefix: string, text: string): string => `${prefix}${text}`.padEnd(22, '0').slice(0, 22);

/**
 * Seeds the demo's storefront orders, payments, refunds and disputes.
 *
 * Why: seed = frontend mocks (decision 014): the console's Refunds, Disputes and payments report pages, the order drawers and the customer pages
 * read the demo's storefront money through the real API. Idempotent: rows that exist are skipped, and the timelines and consents are written
 * only for the orders this run inserted (they have no key to conflict on).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration; without it the IMEIs are left out of the checkout sessions
 * @returns one report per table
 */
export async function seedB2c(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const demoOrders = demoRows<DemoStoreOrder>(demo, 'orders').filter((order) => order.cid !== undefined);
  const demoCustomers = new Map(demoRows<DemoCustomer>(demo, 'customers').map((customer) => [customer.id, customer]));
  const staff = new Map(
    demoRows<{ id: string; name: string }>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]),
  );
  const services = new Map(
    demoRows<{ id: string; type: string }>(demo, 'services').map((service) => [service.id, service]),
  );
  const serviceIds = new Set((await db.select({ id: s.services.id }).from(s.services)).map((row) => row.id));
  const supplierRows = await db.select({ id: s.suppliers.id, name: s.suppliers.name }).from(s.suppliers);
  const suppliers = new Map(supplierRows.map((row) => [row.name, row.id]));
  const gatewayIds = new Map(
    (await db.select({ id: s.paymentGateways.id, code: s.paymentGateways.code }).from(s.paymentGateways)).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const decimals = new Map(
    (await db.select({ code: s.currencies.code, decimals: s.currencies.decimals }).from(s.currencies)).map((row) => [
      row.code,
      row.decimals,
    ]),
  );
  const legal = new Map(
    (
      await db
        .select({ id: s.legalDocuments.id, type: s.legalDocuments.type })
        .from(s.legalDocuments)
        .where(eq(s.legalDocuments.isCurrent, true))
    ).map((row) => [row.type, row.id]),
  );
  const encryption = config ? new EncryptionService(config) : undefined;

  const local = (usd: number, order: { fx: number; cur: string }): string =>
    fromUsd(Money.of(toMoney(usd)), order.fx.toFixed(8), decimals.get(order.cur) ?? 2).toWire();

  // 1. The customers are written by the customers seeder (14b), which runs first: an order of a customer that is not there is skipped.
  const customerIds = new Set((await db.select({ id: s.customers.id }).from(s.customers)).map((row) => row.id));

  // 2. Orders, sessions, payments, receipts, timelines.
  const orderRows: OrderInsert[] = [];
  const sessionRows: Array<typeof s.checkoutSessions.$inferInsert & { id: number }> = [];
  const paymentRows: Array<typeof s.payments.$inferInsert & { id: number }> = [];
  const invoiceRows: Array<typeof s.invoices.$inferInsert & { id: number }> = [];
  const eventsOf = new Map<number, EventInsert[]>();
  const consentsOf = new Map<number, Array<typeof s.consentRecords.$inferInsert>>();
  const seeded = new Map<number, DemoStoreOrder>();
  let skipped = 0;
  for (const demoOrder of demoOrders) {
    const id = demoNumericId(demoOrder.id);
    const customerId = demoNumericId(demoOrder.cid);
    const service = services.get(demoOrder.sid);
    const gatewayId = gatewayIds.get(demoOrder.pay.method === 'crypto' ? 'crypto' : 'card');
    if (
      !customerIds.has(customerId) ||
      !demoCustomers.has(demoOrder.cid) ||
      !service ||
      !serviceIds.has(demoNumericId(service.id)) ||
      gatewayId === undefined
    ) {
      skipped += 1;
      continue;
    }
    seeded.set(id, demoOrder);
    const serviceId = demoNumericId(service.id);
    const customer = demoCustomers.get(demoOrder.cid)!;
    const createdAt = toDate(demoOrder.created)!;
    const paidAt = toDate(demoOrder.events.find((event) => event.k === 'paid')?.ts ?? demoOrder.created + 2000)!;
    const dispatched = demoOrder.events.find((event) => event.k === 'dispatch');
    const supplierName = /^Sent to (.+?) \(/.exec(dispatched?.text ?? '')?.[1];
    const supplierId = (supplierName ? suppliers.get(supplierName) : undefined) ?? null;
    const actorOf = (by: string): Pick<EventInsert, 'actorType' | 'actorId'> => {
      const staffId = staff.get(by);
      if (staffId !== undefined) return { actorType: 'staff', actorId: staffId };
      if (by === customer.name) return { actorType: 'customer', actorId: customerId };
      const supplier = suppliers.get(by);
      if (supplier !== undefined) return { actorType: 'supplier', actorId: supplier };
      return { actorType: 'system', actorId: null };
    };
    eventsOf.set(
      id,
      demoOrder.events
        .map((event): EventInsert => ({
          orderId: id,
          type: event.k as EventInsert['type'],
          ...actorOf(event.by),
          data: { message: event.text },
          createdAt: toDate(Math.round(event.ts))!,
        }))
        .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime()),
    );
    const net = toMoney(demoOrder.price);
    const tax = toMoney(demoOrder.tax ?? 0);
    const gross = toMoney(demoOrder.gross ?? demoOrder.price);
    const taxRate = ((demoOrder.taxRate ?? 0) * 100).toFixed(4);
    const fx = demoOrder.fx.toFixed(8);
    const done = stateOf(demoOrder);

    sessionRows.push({
      id,
      token: longToken('cs', `${id}${demoOrder.token}`),
      customerId,
      email: customer.email,
      serviceId,
      imeiEnc: encryption ? encryption.encrypt(demoOrder.input, CHECKOUT_IMEI_AAD) : null,
      inputs: demoOrder.device ? { device: demoOrder.device } : {},
      quantity: demoOrder.qty,
      currency: demoOrder.cur,
      fxRate: fx,
      netAmount: net,
      taxRate,
      taxAmount: tax,
      grossAmount: gross,
      taxCountry: demoOrder.country,
      ip: customer.lastIp,
      userAgent: 'Mozilla/5.0 (seed)',
      status: 'paid',
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
      orderId: id,
      createdAt,
      updatedAt: paidAt,
    });
    orderRows.push({
      id,
      customerId,
      clientId: null,
      serviceId,
      type: service.type.toLowerCase() as OrderInsert['type'],
      source: 'store',
      ...done,
      imei: demoOrder.input,
      quantity: demoOrder.qty,
      inputs: demoOrder.device ? { device: demoOrder.device } : {},
      unitPrice: toMoney(demoOrder.price / demoOrder.qty),
      totalPrice: net,
      unitCost: toMoney(demoOrder.cost / demoOrder.qty),
      totalCost: toMoney(demoOrder.cost),
      currency: 'USD',
      pricingSnapshot: { source: 'storefront', currency: demoOrder.cur, fxRate: fx, taxRate },
      supplierId,
      resultCode:
        demoOrder.status === 'completed' ? demoOrder.reply : demoOrder.status === 'rejected' ? demoOrder.reason : null,
      publicToken: longToken('', demoOrder.token),
      checkoutSessionId: id,
      taxAmount: tax,
      taxCountry: demoOrder.country,
      placedAt: createdAt,
      createdAt,
      updatedAt: toDate(Math.round(demoOrder.updated ?? demoOrder.created))!,
      sentAt: toDate(dispatched?.ts),
      completedAt: demoOrder.doneAt ? toDate(Math.round(demoOrder.doneAt)) : null,
    });

    const paid = local(demoOrder.gross ?? demoOrder.price, demoOrder);
    const taxShown = local(demoOrder.tax ?? 0, demoOrder);
    const invoiceId = id;
    paymentRows.push({
      id,
      invoiceId,
      customerId,
      orderId: id,
      purpose: 'order',
      gatewayId,
      gatewayTxnId: demoOrder.pay.ref,
      amount: paid,
      feeAmount: local(demoOrder.fee ?? 0, demoOrder),
      currency: demoOrder.cur,
      status: demoOrder.pay.status as 'captured',
      methodType: demoOrder.pay.method,
      brand: brandOf(demoOrder.pay.method, demoOrder.pay.brand),
      threeDs: demoOrder.pay.threeDS,
      capturedAt: paidAt,
      checkoutSessionId: id,
      createdAt,
      updatedAt: paidAt,
    });
    invoiceRows.push({
      id: invoiceId,
      number: invoiceNumber(paidAt.getUTCFullYear(), invoiceId),
      customerId,
      orderId: id,
      kind: 'receipt',
      amount: paid,
      fee: '0',
      netAmount: Money.of(paid).sub(Money.of(taxShown)).toWire(),
      taxAmount: taxShown,
      taxRate,
      taxCountry: demoOrder.country,
      customerVatId: '',
      total: paid,
      currency: demoOrder.cur,
      status: 'paid',
      gatewayId,
      paidAt,
      description: `Order SF-${id}`,
      createdAt: paidAt,
      updatedAt: paidAt,
    });
    const proof = (purpose: 'terms' | 'privacy' | 'withdrawal_waiver') => ({
      subjectType: 'customer' as const,
      subjectId: customerId,
      legalDocumentId: purpose === 'withdrawal_waiver' ? null : (legal.get(purpose) ?? null),
      purpose,
      granted: true,
      checkoutSessionId: id,
      orderId: id,
      ip: customer.lastIp,
      userAgent: 'Mozilla/5.0 (seed)',
      createdAt,
    });
    consentsOf.set(id, [proof('terms'), proof('privacy'), proof('withdrawal_waiver')]);
  }
  if (skipped > 0)
    console.log(
      `  b2c       skipped ${skipped} storefront orders of customers, services or gateways that are not seeded`,
    );

  const insertedOrders = new Set<number>();
  for (let start = 0; start < orderRows.length; start += 100) {
    // The session and the payment come first only by reference: the order row points at the session, the session at the order.
    const chunk = orderRows.slice(start, start + 100);
    await insertRows(
      db,
      s.checkoutSessions,
      chunk.map((order) => ({ ...sessionRows.find((row) => row.id === order.id)!, orderId: null })),
    );
    const written = await db
      .insert(s.orders)
      .overridingSystemValue()
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: s.orders.id });
    for (const row of written) insertedOrders.add(row.id);
  }
  for (const row of sessionRows) {
    await db.update(s.checkoutSessions).set({ orderId: row.id }).where(eq(s.checkoutSessions.id, row.id));
  }
  const invoiceReport = await insertRows(
    db,
    s.invoices,
    invoiceRows.filter((row) => seeded.has(row.id)),
  );
  const paymentReport = await insertRows(db, s.payments, paymentRows);
  const lines = [...insertedOrders].sort((a, b) => a - b).flatMap((id) => eventsOf.get(id) ?? []);
  for (let start = 0; start < lines.length; start += 500)
    await db.insert(s.orderEvents).values(lines.slice(start, start + 500));
  const consents = [...insertedOrders].sort((a, b) => a - b).flatMap((id) => consentsOf.get(id) ?? []);
  for (let start = 0; start < consents.length; start += 500)
    await db.insert(s.consentRecords).values(consents.slice(start, start + 500));

  // 3. Refunds and disputes, linked to the journals the money seed replayed.
  const journals = await db.execute<{ id: number; kind: string; ref_id: number }>(
    sql`select id, kind, ref_id from ledger_transactions where ref_type = 'order' and kind in ('refund', 'chargeback') order by id`,
  );
  const journalOf = (kind: string, orderId: number): number | null =>
    Number(journals.rows.find((row) => row.kind === kind && Number(row.ref_id) === orderId)?.id ?? 0) || null;

  const refundRows: Array<typeof s.refunds.$inferInsert & { id: number }> = [];
  for (const refund of demoRows<DemoRefund>(demo, 'refunds')) {
    const orderId = demoNumericId(refund.oid);
    const order = seeded.get(orderId);
    if (!order) continue;
    const customerId = demoNumericId(refund.cid);
    const decidedBy = !refund.auto && refund.status !== 'requested' ? staff.get(refund.by) : undefined;
    refundRows.push({
      id: demoNumericId(refund.id),
      paymentId: orderId,
      orderId,
      customerId,
      amount: local(refund.amount, order),
      currency: refund.cur,
      reason: refund.reason,
      method: refund.method,
      status: refund.status,
      gatewayRefundId: refund.gw,
      requestedByType: refund.auto ? 'system' : 'customer',
      requestedById: refund.auto ? null : customerId,
      approvedBy: decidedBy ?? null,
      ledgerTxId: refund.status === 'completed' || refund.status === 'failed' ? journalOf('refund', orderId) : null,
      completedAt: refund.status === 'completed' ? toDate(refund.created) : null,
      note: refund.note,
      createdAt: toDate(refund.created)!,
      updatedAt: toDate(refund.created)!,
    });
  }
  const refundReport = await insertRows(db, s.refunds, refundRows);

  const disputeRows: Array<typeof s.disputes.$inferInsert & { id: number }> = [];
  for (const dispute of demoRows<DemoDispute>(demo, 'disputes')) {
    const orderId = demoNumericId(dispute.oid);
    const order = seeded.get(orderId);
    if (!order) continue;
    disputeRows.push({
      id: demoNumericId(dispute.id),
      paymentId: orderId,
      orderId,
      customerId: demoNumericId(dispute.cid),
      gatewayDisputeId: `dp_seed_${demoNumericId(dispute.id)}`,
      reasonCode: reasonCodeOf(dispute.code),
      amount: local(dispute.amount, order),
      currency: dispute.cur,
      fee: local(dispute.fee, order),
      status: dispute.status,
      evidenceDueAt: toDate(dispute.due)!,
      submittedAt: toDate(dispute.submittedAt),
      resolvedAt: toDate(dispute.resolvedAt),
      // Only a lost dispute carries its chargeback journal (the server posts nothing when a dispute is won).
      ledgerTxId: dispute.status === 'lost' ? journalOf('chargeback', orderId) : null,
      createdAt: toDate(dispute.opened)!,
      updatedAt: toDate(dispute.resolvedAt ?? dispute.submittedAt ?? dispute.opened)!,
    });
  }
  const disputeReport = await insertRows(db, s.disputes, disputeRows);

  for (const table of [
    s.checkoutSessions,
    s.orders,
    s.orderEvents,
    s.consentRecords,
    s.invoices,
    s.payments,
    s.refunds,
    s.disputes,
  ]) {
    await syncIdentity(db, table);
  }
  return [
    { table: 'checkout_sessions', inserted: insertedOrders.size, existing: orderRows.length - insertedOrders.size },
    { table: 'orders', inserted: insertedOrders.size, existing: orderRows.length - insertedOrders.size },
    { table: 'order_events', inserted: lines.length, existing: 0 },
    { table: 'consent_records', inserted: consents.length, existing: 0 },
    invoiceReport,
    paymentReport,
    refundReport,
    disputeReport,
  ];
}
