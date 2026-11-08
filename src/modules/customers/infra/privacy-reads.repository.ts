// Reads of the customer privacy routes that reach tables other modules own (orders, payments, IMEI checks, support tickets, data
// requests, the blocklist), kept in this one file: the block collects what to block, the export collects what is held about a customer,
// and the anonymization cuts the IMEI out of the orders (a write the orders module does, through its export) and out of the customer's own
// checkout sessions.
//
// DEVIATION to resolve when those modules export reads (decision 016): orders, money, support and risk export no per-customer read, so
// this file reads their tables with plain selects, like the other foreign-read files. Nothing outside this file names a foreign table.
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { rewriteCustomerOrderInputs } from '../../orders';
import { erasedMainInput } from '../../risk';
import { scrubInputs } from '../domain/customer-privacy';

/**
 * Reads the distinct card fingerprints of a customer's payments.
 *
 * Why: blocking a customer blocks the cards they paid with (RESOLUTIONS b2c-5); the fingerprint is the gateway's, never card data.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the non-empty fingerprints, in order
 */
export async function cardFingerprintsOf(db: DbExecutor, customerId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ fingerprint: s.payments.cardFingerprint })
    .from(s.payments)
    .where(and(eq(s.payments.customerId, customerId), isNotNull(s.payments.cardFingerprint)))
    .orderBy(asc(s.payments.cardFingerprint));
  return rows.flatMap((row) => (row.fingerprint ? [row.fingerprint] : []));
}

/** What the block needs of a customer's orders and checkout sessions: the IMEIs still stored. */
export interface StoredImeis {
  /** `orders.imei` of the customer's orders (the main input: an IMEI, or something else). */
  readonly orderInputs: string[];
  /** `checkout_sessions.imei_enc` of the customer's sessions (ciphertext, decision 019). */
  readonly sessionCiphertexts: string[];
}

/**
 * Reads the IMEIs a customer's orders and checkout sessions still hold.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the main inputs of the orders and the encrypted IMEIs of the sessions
 */
export async function storedImeisOf(db: DbExecutor, customerId: number): Promise<StoredImeis> {
  // One after the other: a transaction is one connection, which runs one query at a time.
  const orders = await db
    .select({ imei: s.orders.imei })
    .from(s.orders)
    .where(and(eq(s.orders.customerId, customerId), isNotNull(s.orders.imei)));
  const sessions = await db
    .select({ imeiEnc: s.checkoutSessions.imeiEnc })
    .from(s.checkoutSessions)
    .where(and(eq(s.checkoutSessions.customerId, customerId), isNotNull(s.checkoutSessions.imeiEnc)));
  return {
    orderInputs: orders.flatMap((row) => (row.imei ? [row.imei] : [])),
    sessionCiphertexts: sessions.flatMap((row) => (row.imeiEnc ? [row.imeiEnc] : [])),
  };
}

/**
 * Cuts the stored IMEI of a customer's orders to the TAC and a mask.
 *
 * Why: B50, RESOLUTIONS b2c-4: the order stays, the device number goes. An IMEI main input keeps its first 8 digits and bullets; any
 * other main input is erased; IMEI-looking values in the custom inputs are masked. A row that has nothing to cut is not touched.
 *
 * @param tx the anonymization's transaction
 * @param customerId the customer
 * @param now the clock's time, written as `updated_at`
 * @returns how many orders changed
 */
export async function eraseOrderImeis(tx: DbExecutor, customerId: number, now: Date): Promise<number> {
  // The orders module owns the table and writes the rows; this module only says what to keep.
  return rewriteCustomerOrderInputs(tx, customerId, now, (order) => ({
    imei: erasedMainInput(order.imei),
    inputs: scrubInputs(order.inputs),
  }));
}

/**
 * Removes the personal data from a customer's checkout sessions (a table the customers module owns).
 *
 * Why: B50: the session keeps the price, tax and status the accounting needs; the buyer's IMEI (ciphertext), email, address and
 * browser go, and IMEI-looking inputs are masked.
 *
 * @param tx the anonymization's transaction
 * @param customerId the customer
 * @param email the replacement address
 * @param now the clock's time
 * @returns how many sessions changed
 */
export async function eraseCheckoutSessions(
  tx: DbExecutor,
  customerId: number,
  email: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .select({ id: s.checkoutSessions.id, inputs: s.checkoutSessions.inputs })
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.customerId, customerId))
    .for('update');
  for (const row of rows) {
    await tx
      .update(s.checkoutSessions)
      .set({ imeiEnc: null, email, ip: null, userAgent: '', inputs: scrubInputs(row.inputs ?? {}), updatedAt: now })
      .where(eq(s.checkoutSessions.id, row.id));
  }
  return rows.length;
}

/** The order rows of an export. */
export interface ExportOrder {
  readonly id: number;
  readonly service: string;
  readonly imei: string | null;
  readonly status: string;
  readonly quantity: number;
  readonly totalPrice: string;
  readonly taxAmount: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** The payment rows of an export: no card data (no brand, fingerprint or gateway payload). */
export interface ExportPayment {
  readonly id: number;
  readonly orderId: number | null;
  readonly amount: string;
  readonly feeAmount: string;
  readonly currency: string;
  readonly status: string;
  readonly methodType: string;
  readonly capturedAt: Date | null;
  readonly createdAt: Date;
}

/** The checkout session rows of an export. */
export interface ExportSession {
  readonly id: number;
  readonly email: string;
  readonly service: string;
  readonly imeiEnc: string | null;
  readonly quantity: number;
  readonly currency: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
  readonly taxCountry: string | null;
  readonly status: string;
  readonly ip: string | null;
  readonly userAgent: string;
  readonly orderId: number | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** The consent rows of an export. */
export interface ExportConsent {
  readonly id: number;
  readonly purpose: string;
  readonly granted: boolean;
  readonly ip: string;
  readonly userAgent: string;
  readonly checkoutSessionId: number | null;
  readonly orderId: number | null;
  readonly createdAt: Date;
}

/** A ticket with its public messages. */
export interface ExportTicket {
  readonly number: string;
  readonly subject: string;
  readonly status: string;
  readonly category: string;
  readonly createdAt: Date;
  readonly messages: Array<{ author: string; body: string; createdAt: Date }>;
}

/** The IMEI check rows of an export. */
export interface ExportImeiCheck {
  readonly id: number;
  readonly imeiEnc: string | null;
  readonly source: string;
  readonly checkType: string;
  readonly status: string;
  readonly ip: string | null;
  readonly createdAt: Date;
}

/** The data request rows of an export. */
export interface ExportRequest {
  readonly id: number;
  readonly kind: string;
  readonly status: string;
  readonly requestedAt: Date;
  readonly dueAt: Date;
  readonly completedAt: Date | null;
}

/** Everything the export reads about a customer besides the customer row. */
export interface ExportRows {
  readonly orders: ExportOrder[];
  readonly payments: ExportPayment[];
  readonly sessions: ExportSession[];
  readonly consents: ExportConsent[];
  readonly tickets: ExportTicket[];
  readonly imeiChecks: ExportImeiCheck[];
  readonly requests: ExportRequest[];
}

/**
 * Reads everything the shop holds about a customer.
 *
 * Why: GET /admin/customers/:id/export, the data-subject access right: the profile (read by the caller), the orders with their IMEI,
 * the payments without card data, the consents, the checkout sessions, the support tickets with their public messages (never the
 * internal notes), the IMEI checks and the data requests. It works for an anonymized customer too (the rows then hold the masks).
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the rows, oldest first
 */
export async function exportRowsOf(db: DbExecutor, customerId: number): Promise<ExportRows> {
  // One after the other: the caller's transaction is one connection, which runs one query at a time.
  const orders = await db
    .select({
      id: s.orders.id,
      service: s.services.name,
      imei: s.orders.imei,
      status: s.orders.status,
      quantity: s.orders.quantity,
      totalPrice: s.orders.totalPrice,
      taxAmount: s.orders.taxAmount,
      currency: s.orders.currency,
      createdAt: s.orders.createdAt,
      completedAt: s.orders.completedAt,
    })
    .from(s.orders)
    .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
    .where(eq(s.orders.customerId, customerId))
    .orderBy(asc(s.orders.id));
  const payments = await db
    .select({
      id: s.payments.id,
      orderId: s.payments.orderId,
      amount: s.payments.amount,
      feeAmount: s.payments.feeAmount,
      currency: s.payments.currency,
      status: s.payments.status,
      methodType: s.payments.methodType,
      capturedAt: s.payments.capturedAt,
      createdAt: s.payments.createdAt,
    })
    .from(s.payments)
    .where(eq(s.payments.customerId, customerId))
    .orderBy(asc(s.payments.id));
  const sessions = await db
    .select({
      id: s.checkoutSessions.id,
      email: s.checkoutSessions.email,
      service: s.services.name,
      imeiEnc: s.checkoutSessions.imeiEnc,
      quantity: s.checkoutSessions.quantity,
      currency: s.checkoutSessions.currency,
      netAmount: s.checkoutSessions.netAmount,
      taxAmount: s.checkoutSessions.taxAmount,
      grossAmount: s.checkoutSessions.grossAmount,
      taxCountry: s.checkoutSessions.taxCountry,
      status: s.checkoutSessions.status,
      ip: s.checkoutSessions.ip,
      userAgent: s.checkoutSessions.userAgent,
      orderId: s.checkoutSessions.orderId,
      createdAt: s.checkoutSessions.createdAt,
      expiresAt: s.checkoutSessions.expiresAt,
    })
    .from(s.checkoutSessions)
    .innerJoin(s.services, eq(s.services.id, s.checkoutSessions.serviceId))
    .where(eq(s.checkoutSessions.customerId, customerId))
    .orderBy(asc(s.checkoutSessions.id));
  const consents = await db
    .select({
      id: s.consentRecords.id,
      purpose: s.consentRecords.purpose,
      granted: s.consentRecords.granted,
      ip: s.consentRecords.ip,
      userAgent: s.consentRecords.userAgent,
      checkoutSessionId: s.consentRecords.checkoutSessionId,
      orderId: s.consentRecords.orderId,
      createdAt: s.consentRecords.createdAt,
    })
    .from(s.consentRecords)
    .where(and(eq(s.consentRecords.subjectType, 'customer'), eq(s.consentRecords.subjectId, customerId)))
    .orderBy(asc(s.consentRecords.id));
  const tickets = await ticketsOf(db, customerId);
  const sessionIds = db
    .select({ id: s.checkoutSessions.id })
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.customerId, customerId));
  const imeiChecks = await db
    .select({
      id: s.imeiChecks.id,
      imeiEnc: s.imeiChecks.imeiEnc,
      source: s.imeiChecks.source,
      checkType: s.imeiChecks.checkType,
      status: s.imeiChecks.status,
      ip: s.imeiChecks.ip,
      createdAt: s.imeiChecks.createdAt,
    })
    .from(s.imeiChecks)
    .where(sql`${s.imeiChecks.customerId} = ${customerId} or ${s.imeiChecks.checkoutSessionId} in (${sessionIds})`)
    .orderBy(asc(s.imeiChecks.id));
  const requests = await db
    .select({
      id: s.dataRequests.id,
      kind: s.dataRequests.kind,
      status: s.dataRequests.status,
      requestedAt: s.dataRequests.requestedAt,
      dueAt: s.dataRequests.dueAt,
      completedAt: s.dataRequests.completedAt,
    })
    .from(s.dataRequests)
    .where(eq(s.dataRequests.customerId, customerId))
    .orderBy(asc(s.dataRequests.id));
  return { orders, payments, sessions, consents, tickets, imeiChecks, requests };
}

async function ticketsOf(db: DbExecutor, customerId: number): Promise<ExportTicket[]> {
  const tickets = await db
    .select({
      id: s.supportTickets.id,
      number: s.supportTickets.number,
      subject: s.supportTickets.subject,
      status: s.supportTickets.status,
      category: s.supportTickets.category,
      createdAt: s.supportTickets.createdAt,
    })
    .from(s.supportTickets)
    .where(and(eq(s.supportTickets.requesterType, 'customer'), eq(s.supportTickets.requesterId, customerId)))
    .orderBy(asc(s.supportTickets.id));
  if (tickets.length === 0) return [];
  const messages = await db
    .select({
      ticketId: s.ticketMessages.ticketId,
      author: s.ticketMessages.authorType,
      body: s.ticketMessages.body,
      createdAt: s.ticketMessages.createdAt,
    })
    .from(s.ticketMessages)
    .where(
      and(
        inArray(
          s.ticketMessages.ticketId,
          tickets.map((ticket) => ticket.id),
        ),
        eq(s.ticketMessages.isInternal, false),
      ),
    )
    .orderBy(asc(s.ticketMessages.id));
  return tickets.map(({ id, ...ticket }) => ({
    ...ticket,
    messages: messages
      .filter((message) => message.ticketId === id)
      .map(({ author, body, createdAt }) => ({ author, body, createdAt })),
  }));
}

/**
 * Deletes a customer's sign-in data.
 *
 * Why: anonymization deletes the credentials (the password hash) of an account; the customers module owns `customer_credentials`.
 *
 * @param tx the anonymization's transaction
 * @param customerId the customer
 * @returns how many rows were deleted (0 for a guest)
 */
export async function deleteCredentialsOf(tx: DbExecutor, customerId: number): Promise<number> {
  const rows = await tx
    .delete(s.customerCredentials)
    .where(eq(s.customerCredentials.customerId, customerId))
    .returning({ id: s.customerCredentials.id });
  return rows.length;
}
