// Read-only lookups into tables other modules own (currencies, orders, sessions, legal documents, risk assessments, refunds,
// disputes, support tickets and the blocklist), kept in this one file: the customer list and detail join them, and the store
// account reads the customer's own orders.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Money, orders (the customer read model), risk, support and storefront export nothing for them yet, so this file reads the
// tables with plain selects, like catalog's and orders' foreign-read files. Replace the bodies with calls to their services;
// nothing outside this file knows (the other repositories import the table handles from here).
import { type SQL, and, desc, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';

/** The table handles the customer repositories join, so no other file of this module names a foreign table. */
export const foreignTables = { currencies: s.currencies, orders: s.orders, sessions: s.sessions } as const;

/** A currency as the customer routes need it. */
export interface CurrencyRef {
  readonly id: number;
  readonly code: string;
  readonly isStorefront: boolean;
  readonly isActive: boolean;
}

/**
 * Reads a currency by its ISO code.
 *
 * Why: a customer stores the currency as a code (the foreign key), and the wire shows its id.
 *
 * @param db the database or a transaction
 * @param code the ISO code
 * @returns the currency, or `undefined` when the code is not in the table
 */
export async function currencyByCode(db: DbExecutor, code: string): Promise<CurrencyRef | undefined> {
  const [row] = await db
    .select({
      id: s.currencies.id,
      code: s.currencies.code,
      isStorefront: s.currencies.isStorefront,
      isActive: s.currencies.isActive,
    })
    .from(s.currencies)
    .where(eq(s.currencies.code, code))
    .limit(1);
  return row;
}

/**
 * Tells whether a country has a tax rate in force.
 *
 * Why: ANSWERS customers Q8: the storefront sells to the countries that have a current `tax_rates` row (the list
 * `GET /store/v1/config` serves), so staff can only give a customer one of them. The money module owns the table; this is a
 * foreign read like the others in this file.
 *
 * @param db the database or a transaction
 * @param country the upper-case ISO 3166 alpha-2 code
 * @param now the clock's time (decision 031): the window must have started and not ended
 * @returns true when a row of that country has `valid_from <= now` and no end, or an end after `now`
 */
export async function hasCurrentTaxRate(db: DbExecutor, country: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: s.taxRates.id })
    .from(s.taxRates)
    .where(
      and(
        eq(s.taxRates.country, country),
        sql`${s.taxRates.validFrom} <= ${now}`,
        sql`(${s.taxRates.validTo} is null or ${s.taxRates.validTo} > ${now})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Counts the live sessions of a customer.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @param now the clock's time (decision 031)
 * @returns sessions that are not revoked and not expired
 */
export async function activeSessionCount(db: DbExecutor, customerId: number, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.sessions)
    .where(
      and(
        eq(s.sessions.subjectType, 'customer'),
        eq(s.sessions.subjectId, customerId),
        sql`${s.sessions.revokedAt} is null`,
        sql`${s.sessions.expiresAt} > ${now}`,
      ),
    );
  return row?.total ?? 0;
}

/**
 * Finds the address a customer was last seen from.
 *
 * Why: customers.md detail: `account.lastIp` is "the most recent of sessions.ip and checkout_sessions.ip" (scenario ip-rules
 * step 5 reads it for the "Block IP" button).
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @returns the address, or `null` when the customer has no session and no checkout
 */
export async function lastSeenIp(db: DbExecutor, customerId: number): Promise<string | null> {
  const result = await db.execute<{ ip: string }>(sql`
    select ip from (
      select ip, created_at from ${s.sessions} where subject_type = 'customer' and subject_id = ${customerId}
      union all
      select ip, created_at from ${s.checkoutSessions} where customer_id = ${customerId} and ip is not null
    ) seen
    order by created_at desc
    limit 1`);
  return result.rows[0]?.ip ?? null;
}

/** The counts under the detail's stat cards. */
export interface DetailCounts {
  readonly refunds: number;
  readonly tickets: number;
  readonly disputes: number;
}

/**
 * Counts a customer's refunds, support tickets and disputes.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @returns the three counts (tickets: those the customer opened, any status)
 */
export async function detailCounts(db: DbExecutor, customerId: number): Promise<DetailCounts> {
  const result = await db.execute<{ refunds: number; tickets: number; disputes: number }>(sql`
    select
      (select count(*)::int from ${s.refunds} where customer_id = ${customerId}) as refunds,
      (select count(*)::int from ${s.supportTickets} where requester_type = 'customer' and requester_id = ${customerId}) as tickets,
      (select count(*)::int from ${s.disputes} where customer_id = ${customerId}) as disputes`);
  const row = result.rows[0];
  return { refunds: row?.refunds ?? 0, tickets: row?.tickets ?? 0, disputes: row?.disputes ?? 0 };
}

/** The risk side of the detail. */
export interface RiskSummary {
  readonly highestScore: number | null;
  readonly signals: ReadonlyArray<{ readonly text: string; readonly orderId: number }>;
}

/** The most signals the detail lists (RESOLUTIONS b2c-11). */
export const MAX_RISK_SIGNALS = 20;

/**
 * Reads the highest risk score and the signals behind a customer's orders.
 *
 * Why: RESOLUTIONS b2c-11: `highestScore` is the maximum over every assessment of the customer; `signals` flatten the
 * assessments that have an order, newest first, in stored order, at most 20.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @returns the summary
 */
export async function riskOf(db: DbExecutor, customerId: number): Promise<RiskSummary> {
  const [top] = await db
    .select({ highest: sql<number | null>`max(${s.riskAssessments.score})::int` })
    .from(s.riskAssessments)
    .where(eq(s.riskAssessments.customerId, customerId));
  const assessments = await db
    .select({ orderId: s.riskAssessments.orderId, signals: s.riskAssessments.signals })
    .from(s.riskAssessments)
    .where(and(eq(s.riskAssessments.customerId, customerId), sql`${s.riskAssessments.orderId} is not null`))
    .orderBy(desc(s.riskAssessments.createdAt), desc(s.riskAssessments.id))
    // Twenty assessments hold at least twenty signals unless some are empty; the loop below stops at the cap.
    .limit(MAX_RISK_SIGNALS * 5);
  const signals: Array<{ text: string; orderId: number }> = [];
  for (const assessment of assessments) {
    for (const text of assessment.signals ?? []) {
      if (typeof text === 'string' && assessment.orderId !== null && signals.length < MAX_RISK_SIGNALS) {
        signals.push({ text, orderId: assessment.orderId });
      }
    }
  }
  return { highestScore: top?.highest ?? null, signals };
}

/** One consent record of the latest order, with its document. */
export interface ConsentEvidence {
  readonly purpose: string;
  readonly documentType: string | null;
  readonly documentVersion: string | null;
  readonly at: Date;
  readonly ip: string;
}

/**
 * Reads the consent evidence of a customer's latest order.
 *
 * Why: RESOLUTIONS b2c-14 and b2c-12: the detail shows the consent records written for the latest order, with the document
 * (type and version) when the purpose has one, and the address each was given from.
 *
 * @param db the database or a transaction
 * @param customerId the customer id
 * @returns the latest order's id and its consent records (oldest first), or `null` when the customer has no order
 */
export async function latestConsentEvidence(
  db: DbExecutor,
  customerId: number,
): Promise<{ orderId: number; records: ConsentEvidence[] } | null> {
  const [latest] = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(eq(s.orders.customerId, customerId))
    .orderBy(desc(s.orders.createdAt), desc(s.orders.id))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select({
      purpose: s.consentRecords.purpose,
      documentType: s.legalDocuments.type,
      documentVersion: s.legalDocuments.version,
      at: s.consentRecords.createdAt,
      ip: s.consentRecords.ip,
    })
    .from(s.consentRecords)
    .leftJoin(s.legalDocuments, eq(s.legalDocuments.id, s.consentRecords.legalDocumentId))
    .where(
      and(
        eq(s.consentRecords.subjectType, 'customer'),
        eq(s.consentRecords.subjectId, customerId),
        eq(s.consentRecords.orderId, latest.id),
      ),
    )
    .orderBy(s.consentRecords.createdAt, s.consentRecords.id);
  return { orderId: latest.id, records: rows };
}

/** One of a customer's orders as the store account lists it. */
export interface StoreOrderRow {
  readonly id: number;
  readonly status: (typeof s.orders.$inferSelect)['status'];
  readonly serviceId: number;
  readonly serviceName: string;
  readonly imei: string | null;
  readonly quantity: number;
  readonly totalPrice: string;
  readonly taxAmount: string;
  readonly currency: string;
  readonly publicToken: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const ORDER_COLUMNS: ListColumns = {
  status: s.orders.status,
  createdAt: s.orders.createdAt,
  totalPrice: s.orders.totalPrice,
};

/**
 * Lists one customer's own orders.
 *
 * Why: `GET /store/v1/me/orders`: the condition `customer_id = :id` comes from the session, never from the request, so no
 * customer can read another's orders.
 *
 * @param db the database or a transaction
 * @param customerId the signed-in customer
 * @param query the parsed list request (`status` filter, `createdAt` or `totalPrice` sort)
 * @returns the page of orders and the exact total
 */
export async function listCustomerOrders(
  db: DbExecutor,
  customerId: number,
  query: ParsedListQuery<'createdAt' | 'totalPrice'>,
): Promise<{ rows: StoreOrderRow[]; total: number }> {
  const own: SQL = eq(s.orders.customerId, customerId);
  const where = listWhere(query, ORDER_COLUMNS, own);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: s.orders.id,
        status: s.orders.status,
        serviceId: s.orders.serviceId,
        serviceName: s.services.name,
        imei: s.orders.imei,
        quantity: s.orders.quantity,
        totalPrice: s.orders.totalPrice,
        taxAmount: s.orders.taxAmount,
        currency: s.orders.currency,
        publicToken: s.orders.publicToken,
        createdAt: s.orders.createdAt,
        completedAt: s.orders.completedAt,
      })
      .from(s.orders)
      .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, ORDER_COLUMNS, s.orders.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.orders)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}
