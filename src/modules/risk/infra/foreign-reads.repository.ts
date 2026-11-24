// Read-only lookups into tables other modules own, kept in this one file (orders, payments, checkout sessions, customers, services,
// suppliers, refunds, disputes, the TAC catalogue, staff): the risk queue joins them, the screening counts earlier orders, and the
// decisions read the held order.
//
// DEVIATION to resolve when those features export reads: decision 016 wants these reads through the owning module's public
// service. Orders, money, customers, catalog and suppliers export no read for a held order's card, so this file reads the tables with
// plain selects, like the foreign-read files of orders and customers. Two list joins outside this file are the known exceptions: the
// blocklist list joins `staff_users` for the name of who added an entry, and the data-request list joins `customers` for the name and
// status of the requester. Every other foreign table is named only here.
import { type SQL, and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** One latest-assessment condition: the row is the newest assessment of its order. */
const newestOfOrder = sql`${s.riskAssessments.id} = (select max(a.id) from ${s.riskAssessments} a where a.order_id = ${s.riskAssessments.orderId})`;

/** A held order with everything the queue card shows, before the per-customer and per-device lookups. */
export interface HeldRow {
  readonly assessmentId: number;
  readonly orderId: number;
  readonly score: number;
  readonly signals: unknown;
  readonly serviceId: number;
  readonly serviceName: string;
  readonly supplierId: number | null;
  readonly supplierName: string | null;
  readonly imei: string | null;
  readonly totalPrice: string;
  readonly taxAmount: string;
  /** The USD gross the checkout session locked (`checkout_sessions.gross_amount`), the figure the Refunds page shows. */
  readonly grossUsd: string | null;
  readonly orderCreatedAt: Date;
  readonly currency: string | null;
  readonly fxRate: string | null;
  readonly capturedAt: Date | null;
  readonly methodType: string | null;
  readonly customerId: number;
  readonly customerName: string;
  readonly customerEmail: string;
  readonly customerCountry: string;
}

/**
 * Reads the orders the rules are holding, oldest payment first.
 *
 * Why: GET /admin/risk/queue: every storefront order whose newest assessment says `review` and was not decided, and whose dispatch
 * state is `held` (paid, never sent to a supplier). The order's payment gives the capture time and method; the checkout session
 * gives the currency and rate the customer paid in.
 *
 * @param db the database or a transaction
 * @returns the held orders
 */
export async function heldOrders(db: DbExecutor): Promise<HeldRow[]> {
  const captured = sql<Date | null>`(select p.captured_at from ${s.payments} p where p.order_id = ${s.orders.id} and p.purpose = 'order' order by p.id limit 1)`;
  const method = sql<
    string | null
  >`(select p.method_type from ${s.payments} p where p.order_id = ${s.orders.id} and p.purpose = 'order' order by p.id limit 1)`;
  const rows = await db
    .select({
      assessmentId: s.riskAssessments.id,
      orderId: s.orders.id,
      score: s.riskAssessments.score,
      signals: s.riskAssessments.signals,
      serviceId: s.services.id,
      serviceName: s.services.name,
      supplierId: s.suppliers.id,
      supplierName: s.suppliers.name,
      imei: s.orders.imei,
      totalPrice: s.orders.totalPrice,
      taxAmount: s.orders.taxAmount,
      grossUsd: s.checkoutSessions.grossAmount,
      orderCreatedAt: s.orders.createdAt,
      currency: s.checkoutSessions.currency,
      fxRate: s.checkoutSessions.fxRate,
      capturedAt: captured.mapWith(s.orders.createdAt),
      methodType: method,
      customerId: s.customers.id,
      customerName: s.customers.name,
      customerEmail: s.customers.email,
      customerCountry: s.customers.country,
    })
    .from(s.riskAssessments)
    .innerJoin(s.orders, eq(s.orders.id, s.riskAssessments.orderId))
    .innerJoin(s.customers, eq(s.customers.id, s.orders.customerId))
    .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
    .leftJoin(s.suppliers, eq(s.suppliers.id, s.orders.supplierId))
    .leftJoin(s.checkoutSessions, eq(s.checkoutSessions.id, s.orders.checkoutSessionId))
    .where(
      and(
        eq(s.riskAssessments.decision, 'review'),
        sql`${s.riskAssessments.reviewedAt} is null`,
        eq(s.orders.dispatchState, 'held'),
        newestOfOrder,
      ),
    )
    .orderBy(asc(sql`coalesce(${captured}, ${s.orders.createdAt})`), asc(s.riskAssessments.id));
  return rows;
}

/** The supplier a held order would go to. */
export interface SupplierRef {
  readonly id: number;
  readonly name: string;
}

/**
 * Finds the supplier each service would be sent to: its first active link by priority.
 *
 * Why: a held order was never dispatched, so `orders.supplier_id` is empty; the queue still names the supplier the reviewer is
 * about to send it to (the console prints it on the card).
 *
 * @param db the database or a transaction
 * @param serviceIds the services of the held orders
 * @returns the supplier by service id (a service without an active link is absent)
 */
export async function plannedSuppliers(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, SupplierRef>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([s.serviceSupplierLinks.serviceId], {
      serviceId: s.serviceSupplierLinks.serviceId,
      supplierId: s.suppliers.id,
      supplierName: s.suppliers.name,
    })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .innerJoin(s.suppliers, eq(s.suppliers.id, s.supplierServices.supplierId))
    .where(and(inArray(s.serviceSupplierLinks.serviceId, [...serviceIds]), eq(s.serviceSupplierLinks.isActive, true)))
    .orderBy(s.serviceSupplierLinks.serviceId, asc(s.serviceSupplierLinks.priority), asc(s.serviceSupplierLinks.id));
  return new Map(rows.map((row) => [row.serviceId, { id: row.supplierId, name: row.supplierName }]));
}

/** What a customer did before a held order. */
export interface CustomerHistoryRow {
  readonly earlierOrders: number;
  readonly refunds: number;
  readonly disputes: number;
}

/**
 * Counts the earlier orders, refunds and disputes of the customers of held orders.
 *
 * Why: the card's "Who is buying" block. An earlier order is one the same customer created before the held order (an older creation
 * time, or the same time and a smaller id), so a later order and another held order of the same customer are not counted as history.
 * The held order itself is not counted either (RESOLUTIONS risk.md queue). Refunds and disputes are the customer's totals.
 *
 * @param db the database or a transaction
 * @param pairs each held order with its customer
 * @returns the history by order id
 */
export async function customerHistories(
  db: DbExecutor,
  pairs: ReadonlyArray<{ readonly orderId: number; readonly customerId: number }>,
): Promise<Map<number, CustomerHistoryRow>> {
  const result = new Map<number, CustomerHistoryRow>();
  if (pairs.length === 0) return result;
  const customerIds = [...new Set(pairs.map((pair) => pair.customerId))];
  const heldOrder = alias(s.orders, 'held_order');
  const earlierOrder = alias(s.orders, 'earlier_order');
  const [orderCounts, refundCounts, disputeCounts] = await Promise.all([
    db
      .select({ orderId: heldOrder.id, total: sql<number>`count(${earlierOrder.id})::int` })
      .from(heldOrder)
      .leftJoin(
        earlierOrder,
        and(
          eq(earlierOrder.customerId, heldOrder.customerId),
          sql`(${earlierOrder.createdAt}, ${earlierOrder.id}) < (${heldOrder.createdAt}, ${heldOrder.id})`,
        ),
      )
      .where(
        inArray(
          heldOrder.id,
          pairs.map((pair) => pair.orderId),
        ),
      )
      .groupBy(heldOrder.id),
    db
      .select({ customerId: s.refunds.customerId, total: sql<number>`count(*)::int` })
      .from(s.refunds)
      .where(inArray(s.refunds.customerId, customerIds))
      .groupBy(s.refunds.customerId),
    db
      .select({ customerId: s.disputes.customerId, total: sql<number>`count(*)::int` })
      .from(s.disputes)
      .where(inArray(s.disputes.customerId, customerIds))
      .groupBy(s.disputes.customerId),
  ]);
  const orders = new Map(orderCounts.map((row) => [row.orderId, row.total]));
  const refunds = new Map(refundCounts.map((row) => [row.customerId, row.total]));
  const disputes = new Map(disputeCounts.map((row) => [row.customerId, row.total]));
  for (const pair of pairs) {
    result.set(pair.orderId, {
      earlierOrders: orders.get(pair.orderId) ?? 0,
      refunds: refunds.get(pair.customerId) ?? 0,
      disputes: disputes.get(pair.customerId) ?? 0,
    });
  }
  return result;
}

/** A device name as the TAC catalogue gives it. */
export interface TacRow {
  readonly tac: string;
  readonly brand: string;
  readonly model: string;
  readonly marketingName: string;
}

/**
 * Reads catalogue entries by TAC.
 *
 * @param db the database or a transaction
 * @param tacs 8-digit TACs
 * @returns the entries by TAC
 */
export async function tacEntries(db: DbExecutor, tacs: readonly string[]): Promise<Map<string, TacRow>> {
  if (tacs.length === 0) return new Map();
  const rows = await db
    .select({
      tac: s.tacCatalog.tac,
      brand: s.tacCatalog.brand,
      model: s.tacCatalog.model,
      marketingName: s.tacCatalog.marketingName,
    })
    .from(s.tacCatalog)
    .where(inArray(s.tacCatalog.tac, [...new Set(tacs)]));
  return new Map(rows.map((row) => [row.tac, row]));
}

/** The decided orders for the "Decided recently" list. */
export interface DecidedRow {
  readonly orderId: number;
  readonly score: number;
  readonly customerId: number;
  readonly customerName: string;
  readonly totalPrice: string;
  readonly taxAmount: string;
  /** The USD gross the checkout session locked, the figure the Refunds page shows. */
  readonly grossUsd: string | null;
  readonly currency: string | null;
  readonly fxRate: string | null;
  readonly outcome: 'approved' | 'refunded';
  readonly reviewerId: number | null;
  readonly reviewerName: string | null;
  readonly reviewedAt: Date;
}

/**
 * Reads the latest decisions of the review queue.
 *
 * @param db the database or a transaction
 * @param limit how many to read
 * @returns the decided orders, newest decision first
 */
export async function recentDecisions(db: DbExecutor, limit: number): Promise<DecidedRow[]> {
  const rows = await db
    .select({
      orderId: s.orders.id,
      score: s.riskAssessments.score,
      customerId: s.customers.id,
      customerName: s.customers.name,
      totalPrice: s.orders.totalPrice,
      taxAmount: s.orders.taxAmount,
      grossUsd: s.checkoutSessions.grossAmount,
      currency: s.checkoutSessions.currency,
      fxRate: s.checkoutSessions.fxRate,
      outcome: s.riskAssessments.outcome,
      reviewerId: s.staffUsers.id,
      reviewerName: s.staffUsers.name,
      reviewedAt: s.riskAssessments.reviewedAt,
    })
    .from(s.riskAssessments)
    .innerJoin(s.orders, eq(s.orders.id, s.riskAssessments.orderId))
    .innerJoin(s.customers, eq(s.customers.id, s.orders.customerId))
    .leftJoin(s.checkoutSessions, eq(s.checkoutSessions.id, s.orders.checkoutSessionId))
    .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.riskAssessments.reviewedBy))
    .where(and(isNotNull(s.riskAssessments.reviewedAt), isNotNull(s.riskAssessments.outcome), newestOfOrder))
    .orderBy(desc(s.riskAssessments.reviewedAt), desc(s.riskAssessments.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, outcome: row.outcome!, reviewedAt: row.reviewedAt! }));
}

/** The 30-day figures of the strip above the queue. */
export interface QueueFigures {
  readonly decided: number;
  readonly approved: number;
  readonly refunded: number;
  readonly heldOrders: number;
  readonly storefrontOrders: number;
}

/**
 * Counts the decisions and the held share over a window.
 *
 * Why: the strip shows decided, approved and refunded counts and the share of storefront orders the rules held. An order counts as
 * held when its newest assessment says `review`, decided or not.
 *
 * @param db the database or a transaction
 * @param since the start of the window (the clock's time minus 30 days)
 * @returns the five counts
 */
export async function queueFigures(db: DbExecutor, since: Date): Promise<QueueFigures> {
  const [decisions] = await db
    .select({
      decided: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where ${s.riskAssessments.outcome} = 'approved')::int`,
      refunded: sql<number>`count(*) filter (where ${s.riskAssessments.outcome} = 'refunded')::int`,
    })
    .from(s.riskAssessments)
    .where(and(isNotNull(s.riskAssessments.reviewedAt), gte(s.riskAssessments.reviewedAt, since), newestOfOrder));
  const [held] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.riskAssessments)
    .innerJoin(s.orders, eq(s.orders.id, s.riskAssessments.orderId))
    .where(
      and(
        eq(s.riskAssessments.decision, 'review'),
        isNotNull(s.orders.customerId),
        gte(s.orders.createdAt, since),
        newestOfOrder,
      ),
    );
  const [orders] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.orders)
    .where(and(isNotNull(s.orders.customerId), gte(s.orders.createdAt, since)));
  return {
    decided: decisions?.decided ?? 0,
    approved: decisions?.approved ?? 0,
    refunded: decisions?.refunded ?? 0,
    heldOrders: held?.total ?? 0,
    storefrontOrders: orders?.total ?? 0,
  };
}

/** The order a decision is about, with the newest assessment (locked). */
export interface HeldOrderContext {
  readonly assessmentId: number;
  readonly orderId: number;
  readonly customerId: number;
  readonly customerName: string;
  readonly customerEmail: string;
  readonly serviceId: number;
  readonly imei: string | null;
  readonly dispatchState: string;
  readonly decision: string;
  readonly reviewedAt: Date | null;
  readonly signals: unknown;
  /** The email the checkout was opened with (`checkout_sessions.email`); `null` when the order has no checkout session. */
  readonly sessionEmail: string | null;
  /** The checkout's `opened_signed_in`; `null` when the order has no checkout session (decision 050). */
  readonly openedSignedIn: boolean | null;
  /** The card fingerprint of the order's own payment, when the gateway gave one. */
  readonly cardFingerprint: string | null;
  /**
   * An account existed before the order: the customer row was made by staff, or its email was verified (a link was used) before the
   * order was placed. Only then does blocking a guest order's email leave the account its use (decision 050).
   */
  readonly accountBeforeOrder: boolean;
}

/**
 * Reads a storefront order with its newest assessment and locks the assessment row.
 *
 * Why: approve and refund must see the same state: two staff members deciding at once queue on the assessment lock, and the second
 * finds it decided (`409 NOT_HELD`) instead of racing the order update. Lock order: the assessment first, then the order (the order
 * transition), then the ledger accounts. Decision 050: it also reads what the refund's blocks need to tell a guest order from a signed-in
 * one (the checkout's email and flag, the order's card, and whether an account existed before the order); only the assessment row is locked.
 *
 * @param tx the caller's transaction
 * @param orderId the order id
 * @returns the context, or `undefined` when the order is not a storefront order or has no assessment
 */
export async function lockHeldContext(tx: DbExecutor, orderId: number): Promise<HeldOrderContext | undefined> {
  const [row] = await tx
    .select({
      assessmentId: s.riskAssessments.id,
      orderId: s.orders.id,
      customerId: s.customers.id,
      customerName: s.customers.name,
      customerEmail: s.customers.email,
      serviceId: s.orders.serviceId,
      imei: s.orders.imei,
      dispatchState: s.orders.dispatchState,
      decision: s.riskAssessments.decision,
      reviewedAt: s.riskAssessments.reviewedAt,
      signals: s.riskAssessments.signals,
      sessionEmail: s.checkoutSessions.email,
      openedSignedIn: s.checkoutSessions.openedSignedIn,
      cardFingerprint: sql<
        string | null
      >`(select p.card_fingerprint from ${s.payments} p where p.order_id = ${s.orders.id} and p.purpose = 'order' and p.card_fingerprint is not null order by p.id limit 1)`,
      accountBeforeOrder: sql<boolean>`(${s.customers.createdBy} is not null or (${s.customers.emailVerifiedAt} is not null and ${s.customers.emailVerifiedAt} < ${s.orders.createdAt}))`,
    })
    .from(s.riskAssessments)
    .innerJoin(s.orders, eq(s.orders.id, s.riskAssessments.orderId))
    .innerJoin(s.customers, eq(s.customers.id, s.orders.customerId))
    .leftJoin(s.checkoutSessions, eq(s.checkoutSessions.id, s.orders.checkoutSessionId))
    .where(and(eq(s.orders.id, orderId), newestOfOrder))
    .limit(1)
    .for('update', { of: s.riskAssessments });
  return row;
}

/** What the placement rule needs to know about a service. */
export interface ServiceDispatchFacts {
  readonly manualService: boolean;
  readonly hasActiveSupplierLink: boolean;
}

/**
 * Reads whether an approved order goes to the manual queue or to a supplier.
 *
 * Why: decision 025 placement row: a service with `fulfillment = manual`, or without an active supplier link, is `manual`; any other
 * waits for the dispatch job. A risk approval releases the order by the same rule.
 *
 * @param db the database or a transaction
 * @param serviceId the order's service
 * @returns the two facts
 */
export async function serviceDispatchFacts(db: DbExecutor, serviceId: number): Promise<ServiceDispatchFacts> {
  const [service] = await db
    .select({ fulfillment: s.services.fulfillment })
    .from(s.services)
    .where(eq(s.services.id, serviceId))
    .limit(1);
  const [link] = await db
    .select({ id: s.serviceSupplierLinks.id })
    .from(s.serviceSupplierLinks)
    .where(and(eq(s.serviceSupplierLinks.serviceId, serviceId), eq(s.serviceSupplierLinks.isActive, true)))
    .limit(1);
  return { manualService: service?.fulfillment === 'manual', hasActiveSupplierLink: link !== undefined };
}

/** How many earlier orders the screening counts. */
export interface OrderCounts {
  readonly lastDayByEmail: number;
  readonly lastHourByDevice: number;
  readonly earlierOrders: number;
}

/**
 * Counts the earlier storefront orders, and the checkouts with a payment in flight, that the score looks at.
 *
 * Why: the signals "more than N orders in 24 hours from one email", "4 orders in one hour from one device" and "first order of a new
 * customer". An order belongs to an email through the checkout session it was paid from; the device is the address the session came from
 * (or the same buyer). Decision 050: the buyer of a signed-in checkout is the account's own signed-in checkouts; the buyer of a guest
 * checkout is its email and the customer row of that email; a checkout of the buyer with a payment pending or held and no order yet counts
 * like an order in the two windows; all of it is one statement, so a payment being captured in parallel is seen once, as its pending row or
 * as its order. The order being screened, when it exists, and the checkout being screened are not counted. A rejected order is not an
 * earlier order of the customer (the customer never received anything).
 *
 * @param db the database or a transaction
 * @param who the email (trimmed, lower case), the customer if known, the address, the order and the checkout being screened, and whether
 *   the payment is proven (a signed-in checkout of a known customer)
 * @param now the clock's time (decision 031)
 * @returns the three counts
 */
export async function countEarlierOrders(
  db: DbExecutor,
  who: {
    email: string;
    customerId: number | null;
    ip: string | null;
    exceptOrderId: number | null;
    exceptSessionId: number | null;
    proven: boolean;
  },
  now: Date,
): Promise<OrderCounts> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const email = who.email.trim().toLowerCase();
  const { customerId } = who;
  const proven = who.proven && customerId !== null;
  // `col` is the customer column of the side being counted (the order's, or the in-flight checkout's); `cs` is its checkout session.
  const sameBuyer = (col: SQL): SQL =>
    proven
      ? sql`(${col} = ${customerId} and cs.opened_signed_in)`
      : sql`(lower(cs.email) = ${email}${customerId === null ? sql`` : sql` or ${col} = ${customerId}`})`;
  const sameEmail = (col: SQL): SQL => (proven ? sameBuyer(col) : sql`lower(cs.email) = ${email}`);
  const sameDevice = (col: SQL): SQL => sql`(${sameBuyer(col)}${who.ip === null ? sql`` : sql` or cs.ip = ${who.ip}`})`;
  const exceptOrder = who.exceptOrderId === null ? sql`true` : sql`o.id <> ${who.exceptOrderId}`;
  const exceptSession = who.exceptSessionId === null ? sql`true` : sql`cs.id <> ${who.exceptSessionId}`;
  const orderCustomer = sql.raw('o.customer_id');
  const flyingCustomer = sql.raw('cs.customer_id');
  const result = await db.execute(sql`
    select ord.day + fly.day as last_day_by_email, ord.hour + fly.hour as last_hour_by_device, ord.earlier as earlier_orders
    from (
      select count(*) filter (where ${sameEmail(orderCustomer)} and o.created_at >= ${dayAgo}::timestamptz)::int as day,
             count(*) filter (where o.created_at >= ${hourAgo}::timestamptz)::int as hour,
             count(*) filter (where ${sameBuyer(orderCustomer)} and o.status <> 'rejected')::int as earlier
      from ${s.orders} o
      left join ${s.checkoutSessions} cs on cs.id = o.checkout_session_id
      where o.customer_id is not null and ${exceptOrder} and ${sameDevice(orderCustomer)}
    ) ord, (
      -- Decision 050: a checkout whose payment is in flight (a page open, or a confirmation held for staff) counts like an order.
      select count(distinct cs.id) filter (where ${sameEmail(flyingCustomer)} and p.created_at >= ${dayAgo}::timestamptz)::int as day,
             count(distinct cs.id) filter (where p.created_at >= ${hourAgo}::timestamptz)::int as hour
      from ${s.payments} p
      join ${s.checkoutSessions} cs on cs.id = p.checkout_session_id
      where p.purpose = 'order' and p.status = 'pending' and p.order_id is null and cs.order_id is null
        and p.created_at >= ${dayAgo}::timestamptz
        and ${exceptSession} and ${sameDevice(flyingCustomer)}
    ) fly
  `);
  const row = result.rows[0] as
    { last_day_by_email?: number; last_hour_by_device?: number; earlier_orders?: number } | undefined;
  return {
    lastDayByEmail: row?.last_day_by_email ?? 0,
    lastHourByDevice: row?.last_hour_by_device ?? 0,
    earlierOrders: row?.earlier_orders ?? 0,
  };
}

/**
 * Tells whether any country has a tax window in force.
 *
 * Why: decision 050: a declared tax country that the card or the visitor contradicts holds the payment only while the shop taxes by country
 * (at least one window in force, the condition of the checkout's country refusal); with none, the declared country decides no tax. The
 * money module owns the table; this is a foreign read like the others in this file.
 *
 * @param db the database or a transaction
 * @param now the clock's time (decision 031)
 * @returns true when any `tax_rates` row has started and has not ended
 */
export async function hasAnyCurrentTaxRate(db: DbExecutor, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: s.taxRates.id })
    .from(s.taxRates)
    .where(
      and(
        sql`${s.taxRates.validFrom} <= ${now}`,
        sql`(${s.taxRates.validTo} is null or ${s.taxRates.validTo} > ${now})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
