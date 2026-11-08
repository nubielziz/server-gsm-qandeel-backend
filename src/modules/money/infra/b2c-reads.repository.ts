// Read-only lookups into the orders, checkout, customer, support and consent tables that the storefront refund, dispute and report
// screens join (feature 16), plus the ledger parts of a refund. One file, like `foreign-directory.repository.ts`.
//
// DEVIATION to resolve when the owners export a read: decision 016 wants these through the owning module's public service. Orders
// and customers export no reader that returns these rows (and orders imports money, so money cannot import orders: decision 032),
// so this file reads `orders`, `checkout_sessions`, `services`, `consent_records`, `legal_documents` and `support_tickets` with plain
// selects. Nothing outside this file knows.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** A storefront order as the refund and dispute screens read it. */
export interface OrderFacts {
  readonly id: number;
  readonly status: string;
  readonly completedAt: Date | null;
  /** The supplier cost of the order, USD. */
  readonly totalCost: string;
  readonly customerId: number | null;
  readonly checkoutSessionId: number | null;
  readonly serviceName: string;
  readonly resultCode: string | null;
  readonly publicToken: string | null;
  readonly placedAt: Date;
}

/**
 * Reads orders for the B2C screens.
 *
 * @param db the database or a transaction
 * @param ids the order ids
 * @returns the orders that exist, by id
 */
export async function loadOrderFacts(db: DbExecutor, ids: readonly number[]): Promise<Map<number, OrderFacts>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: s.orders.id,
      status: s.orders.status,
      completedAt: s.orders.completedAt,
      totalCost: s.orders.totalCost,
      customerId: s.orders.customerId,
      checkoutSessionId: s.orders.checkoutSessionId,
      serviceName: s.services.name,
      resultCode: s.orders.resultCode,
      publicToken: s.orders.publicToken,
      placedAt: s.orders.placedAt,
    })
    .from(s.orders)
    .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
    .where(inArray(s.orders.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** What a checkout session locked, found through the order it created. */
export interface SessionMoney {
  readonly currency: string;
  /** Units of the currency per 1 USD, 8 decimals. */
  readonly fxRate: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
  readonly taxRate: string;
  readonly taxCountry: string | null;
  readonly email: string;
}

/**
 * Reads the locked amounts of the sessions behind some orders.
 *
 * @param db the database or a transaction
 * @param orderIds the order ids
 * @returns the session money by order id (an order without a session is absent)
 */
export async function loadSessionMoney(
  db: DbExecutor,
  orderIds: readonly number[],
): Promise<Map<number, SessionMoney>> {
  const unique = [...new Set(orderIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: s.orders.id,
      currency: s.checkoutSessions.currency,
      fxRate: s.checkoutSessions.fxRate,
      netAmount: s.checkoutSessions.netAmount,
      taxAmount: s.checkoutSessions.taxAmount,
      grossAmount: s.checkoutSessions.grossAmount,
      taxRate: s.checkoutSessions.taxRate,
      taxCountry: s.checkoutSessions.taxCountry,
      email: s.checkoutSessions.email,
    })
    .from(s.orders)
    .innerJoin(s.checkoutSessions, eq(s.checkoutSessions.id, s.orders.checkoutSessionId))
    .where(inArray(s.orders.id, unique));
  return new Map(rows.map(({ orderId, ...rest }) => [orderId, rest]));
}

/** The parts of one posted refund or payment transaction, in USD, from its ledger lines. */
export interface LedgerParts {
  /** The net (revenue or customer funds) part. */
  readonly net: string;
  /** The VAT payable part. */
  readonly vat: string;
  /** What moved through the gateway account. */
  readonly gross: string;
}

/**
 * Reads the net, VAT and gateway parts of ledger transactions by id.
 *
 * Why: RESOLUTIONS money-4: a refund's `netAmount` and `taxAmount` and a payment's VAT are read from the posted lines (the revenue or
 * customer funds line, the `vat_payable` line and the `gateway_clearing` line), never recomputed.
 *
 * @param db the database or a transaction
 * @param transactionIds the `ledger_transactions.id` values
 * @returns the parts by transaction id (a refund or payment transaction only)
 */
export async function ledgerPartsOf(
  db: DbExecutor,
  transactionIds: readonly number[],
): Promise<Map<number, LedgerParts>> {
  const unique = [...new Set(transactionIds)];
  if (unique.length === 0) return new Map();
  const result = await db.execute<{ id: number; net: string; vat: string; gross: string }>(sql`
    select le.transaction_id as id,
      coalesce(sum(abs(le.amount)) filter (where la.kind in ('revenue', 'customer_funds')), 0)::text as net,
      coalesce(sum(abs(le.amount)) filter (where la.kind = 'vat_payable'), 0)::text as vat,
      coalesce(sum(abs(le.amount)) filter (where la.kind = 'gateway_clearing'), 0)::text as gross
    from ledger_entries le join ledger_accounts la on la.id = le.account_id
    where le.transaction_id in (${sql.join(
      unique.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by le.transaction_id`);
  return new Map(result.rows.map((row) => [Number(row.id), { net: row.net, vat: row.vat, gross: row.gross }]));
}

/** What a dispute's evidence pack is built from. */
export interface EvidenceFacts {
  readonly consents: ReadonlyArray<{
    purpose: string;
    documentType: string | null;
    version: string | null;
    ip: string;
    at: Date;
  }>;
  /** Earlier completed storefront orders of the customer that were paid and never disputed. */
  readonly priorPaidOrders: number;
  /** Support tickets of the customer around the order (within five days) or about it. */
  readonly tickets: ReadonlyArray<{ number: string; subject: string }>;
}

const FIVE_DAYS_MS = 5 * 86_400_000;

/**
 * Reads the consents, the history and the support contacts behind an evidence pack.
 *
 * @param db the database or a transaction
 * @param order the disputed order's id, customer and placement time
 * @returns the facts
 */
export async function loadEvidenceFacts(
  db: DbExecutor,
  order: { id: number; customerId: number; sessionId: number | null; placedAt: Date },
): Promise<EvidenceFacts> {
  const consentRows =
    order.sessionId === null
      ? []
      : await db
          .select({
            purpose: s.consentRecords.purpose,
            granted: s.consentRecords.granted,
            documentType: s.legalDocuments.type,
            version: s.legalDocuments.version,
            ip: s.consentRecords.ip,
            at: s.consentRecords.createdAt,
          })
          .from(s.consentRecords)
          .leftJoin(s.legalDocuments, eq(s.legalDocuments.id, s.consentRecords.legalDocumentId))
          .where(eq(s.consentRecords.checkoutSessionId, order.sessionId))
          .orderBy(asc(s.consentRecords.id));
  const prior = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from orders o
    where o.customer_id = ${order.customerId} and o.id <> ${order.id} and o.status = 'completed'
      and exists (select 1 from payments p where p.order_id = o.id and p.status in ('captured', 'partial_refund', 'refunded'))
      and not exists (select 1 from disputes d where d.order_id = o.id)`);
  const tickets = await db
    .select({ number: s.supportTickets.number, subject: s.supportTickets.subject })
    .from(s.supportTickets)
    .where(
      and(
        eq(s.supportTickets.requesterType, 'customer'),
        eq(s.supportTickets.requesterId, order.customerId),
        sql`(${s.supportTickets.orderId} = ${order.id} or (${s.supportTickets.createdAt} >= ${new Date(order.placedAt.getTime() - FIVE_DAYS_MS)} and ${s.supportTickets.createdAt} <= ${new Date(order.placedAt.getTime() + FIVE_DAYS_MS)}))`,
      ),
    )
    .orderBy(asc(s.supportTickets.id))
    .limit(10);
  return {
    consents: consentRows
      .filter((row) => row.granted)
      .map((row) => ({
        purpose: row.purpose,
        documentType: row.documentType,
        version: row.version,
        ip: row.ip,
        at: row.at,
      })),
    priorPaidOrders: prior.rows[0]?.n ?? 0,
    tickets,
  };
}

/**
 * Finds ledger transactions by their idempotency keys.
 *
 * Why: a payment's own journal is found by its key (`payment:<id>:capture`), so the VAT of a payment is read from the lines that were
 * posted for exactly that payment (RESOLUTIONS money-4), even when an order was paid twice.
 *
 * @param db the database or a transaction
 * @param keys the idempotency keys
 * @returns the transaction ids by key
 */
export async function ledgerTxIdsByKeys(db: DbExecutor, keys: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.ledgerTransactions.id, key: s.ledgerTransactions.idempotencyKey })
    .from(s.ledgerTransactions)
    .where(inArray(s.ledgerTransactions.idempotencyKey, unique));
  return new Map(rows.map((row) => [row.key, row.id]));
}

/** The columns of an order a refund's journal needs. */
export interface RefundOrderRow {
  readonly id: number;
  readonly customerId: number | null;
  readonly totalPrice: string;
  readonly taxAmount: string;
  readonly status: 'pending' | 'processing' | 'completed' | 'rejected';
  readonly currency: string;
}

const REFUND_ORDER_COLUMNS = {
  id: s.orders.id,
  customerId: s.orders.customerId,
  totalPrice: s.orders.totalPrice,
  taxAmount: s.orders.taxAmount,
  status: s.orders.status,
  currency: s.orders.currency,
};

/**
 * Reads the order of a refund.
 *
 * @param db the database or a transaction
 * @param id the order id
 * @returns the order, or `undefined`
 */
export async function orderForRefund(db: DbExecutor, id: number): Promise<RefundOrderRow | undefined> {
  const [row] = await db.select(REFUND_ORDER_COLUMNS).from(s.orders).where(eq(s.orders.id, id)).limit(1);
  return row;
}

/**
 * Reads the order of a refund and locks it until the transaction ends.
 *
 * Why: lock order, one for every writer of a storefront order's money: the order, then the payment, then the refund, then the ledger
 * accounts. A rejection already takes the order first (its guarded `UPDATE` locks the row before the refund posts), so an approval takes
 * it first too; otherwise an approval holding the payment and waiting for the order could deadlock with a rejection holding the order and
 * waiting for the payment. The lock is `FOR NO KEY UPDATE`, the one an `UPDATE` of the order takes: it does not block the timeline rows
 * that disputes insert while they hold the payment (an insert only takes `FOR KEY SHARE` on the order).
 *
 * @param db the caller's transaction
 * @param id the order id
 * @returns the order as it is now, or `undefined`
 */
export async function lockOrderForRefund(db: DbExecutor, id: number): Promise<RefundOrderRow | undefined> {
  const [row] = await db
    .select(REFUND_ORDER_COLUMNS)
    .from(s.orders)
    .where(eq(s.orders.id, id))
    .limit(1)
    .for('no key update');
  return row;
}
