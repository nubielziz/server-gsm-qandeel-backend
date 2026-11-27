// Reads of the account privacy routes that reach tables other modules own (orders, payments, support tickets, data requests, files, the
// ledger, API keys and invoices), kept in this one file: the block collects what to block, the export collects what is held about an
// account (and about the guest row of its proven email), and the anonymization cuts the IMEI out of the orders (a write the orders module
// does, through its export) and out of the account's own checkout sessions.
//
// DEVIATION to resolve when those modules export reads (decision 016): orders, money, support, risk and platform export no per-account
// read, so this file reads their tables with plain selects, like the other foreign-read files. Nothing outside this file names a
// foreign table.
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { rewriteCustomerOrderInputs } from '../../orders';
import { erasedMainInput } from '../../risk';
import { scrubInputs } from '../domain/customer-privacy';

/**
 * Reads the distinct card fingerprints of an account's payments.
 *
 * Why: blocking an account blocks the cards it paid with (RESOLUTIONS b2c-5); the fingerprint is the gateway's, never card data.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the non-empty fingerprints, in order
 */
export async function cardFingerprintsOf(db: DbExecutor, accountId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ fingerprint: s.payments.cardFingerprint })
    .from(s.payments)
    .where(and(eq(s.payments.accountId, accountId), isNotNull(s.payments.cardFingerprint)))
    .orderBy(asc(s.payments.cardFingerprint));
  return rows.flatMap((row) => (row.fingerprint ? [row.fingerprint] : []));
}

/** What the block needs of an account's shop orders and checkout sessions: the IMEIs still stored. */
export interface StoredImeis {
  /** `orders.imei` of the account's shop orders (the main input: an IMEI, or something else). */
  readonly orderInputs: string[];
  /** `checkout_sessions.imei_enc` of the account's sessions (ciphertext, decision 019). */
  readonly sessionCiphertexts: string[];
  /**
   * The custom field values of the account's shop orders and checkout sessions, with their service: the caller keeps those of the fields
   * of type `imei` (decision 073) and each line of those of type `imei_bulk` (decision 076).
   */
  readonly fieldValues: ReadonlyArray<{
    readonly serviceId: number;
    readonly inputs: Readonly<Record<string, unknown>>;
  }>;
}

/**
 * Reads the IMEIs an account's shop orders and checkout sessions still hold.
 *
 * Why: decision 064: a merchant orders through the portal and Dhru for other people's devices, so only the IMEIs of the account's **shop**
 * orders (`source = 'store'`) and its checkout sessions go on the blocklist, never those of a portal or Dhru order.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the main inputs of the shop orders, the encrypted IMEIs of the sessions, and the field values of both with their service
 */
export async function storedImeisOf(db: DbExecutor, accountId: number): Promise<StoredImeis> {
  // One after the other: a transaction is one connection, which runs one query at a time.
  const orders = await db
    .select({ imei: s.orders.imei, serviceId: s.orders.serviceId, inputs: s.orders.inputs })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.source, 'store')));
  const sessions = await db
    .select({
      imeiEnc: s.checkoutSessions.imeiEnc,
      serviceId: s.checkoutSessions.serviceId,
      inputs: s.checkoutSessions.inputs,
    })
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.accountId, accountId));
  return {
    orderInputs: orders.flatMap((row) => (row.imei ? [row.imei] : [])),
    sessionCiphertexts: sessions.flatMap((row) => (row.imeiEnc ? [row.imeiEnc] : [])),
    fieldValues: [...orders, ...sessions].map((row) => ({ serviceId: row.serviceId, inputs: row.inputs ?? {} })),
  };
}

/**
 * Cuts the stored IMEI of an account's orders to the TAC and a mask.
 *
 * Why: B50, RESOLUTIONS b2c-4: the order stays, the device number goes. An IMEI main input keeps its first 8 digits and bullets; any
 * other main input is erased; IMEI-looking values in the custom inputs are masked. A row that has nothing to cut is not touched.
 *
 * @param tx the anonymization's transaction
 * @param accountId the account
 * @param now the clock's time, written as `updated_at`
 * @returns how many orders changed
 */
export async function eraseOrderImeis(tx: DbExecutor, accountId: number, now: Date): Promise<number> {
  // The orders module owns the table and writes the rows; this module only says what to keep. The buyer id it takes is an account id.
  return rewriteCustomerOrderInputs(tx, accountId, now, (order) => ({
    imei: erasedMainInput(order.imei),
    inputs: scrubInputs(order.inputs),
  }));
}

/**
 * Removes the personal data from an account's checkout sessions (a table the customers module owns).
 *
 * Why: B50: the session keeps the price, tax and status the accounting needs; the buyer's IMEI (ciphertext), email, address (and the
 * visitor's country read from it, decision 050) and browser go, and IMEI-looking inputs are masked.
 *
 * @param tx the anonymization's transaction
 * @param accountId the account
 * @param email the replacement address
 * @param now the clock's time
 * @returns how many sessions changed
 */
export async function eraseCheckoutSessions(
  tx: DbExecutor,
  accountId: number,
  email: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .select({ id: s.checkoutSessions.id, inputs: s.checkoutSessions.inputs })
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.accountId, accountId))
    .for('update');
  for (const row of rows) {
    await tx
      .update(s.checkoutSessions)
      .set({
        imeiEnc: null,
        email,
        ip: null,
        ipCountry: null,
        userAgent: '',
        inputs: scrubInputs(row.inputs ?? {}),
        updatedAt: now,
      })
      .where(eq(s.checkoutSessions.id, row.id));
  }
  return rows.length;
}

/**
 * Counts what is still open on a guest row: checkout sessions that can still be paid and payments that are still pending.
 *
 * Why: decision 064: the erasure of the guest row of a proven email refuses while money or a checkout is in flight, as the erasure of
 * the account refuses while its wallet is not settled. A session is open when its status is `open` and it has not expired.
 *
 * @param db the database or a transaction
 * @param accountId the guest row
 * @param now the clock's time (decision 031)
 * @returns the number of open checkouts and of pending payments
 */
export async function openObligationsOf(
  db: DbExecutor,
  accountId: number,
  now: Date,
): Promise<{ checkouts: number; payments: number }> {
  // One after the other: the caller's transaction is one connection, which runs one query at a time.
  const [checkouts] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.checkoutSessions)
    .where(
      and(
        eq(s.checkoutSessions.accountId, accountId),
        eq(s.checkoutSessions.status, 'open'),
        sql`${s.checkoutSessions.expiresAt} > ${now}`,
      ),
    );
  const [payments] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.payments)
    .where(and(eq(s.payments.accountId, accountId), eq(s.payments.status, 'pending')));
  return { checkouts: checkouts?.total ?? 0, payments: payments?.total ?? 0 };
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
  /** The visitor's country as the proxy in front supplied it when the checkout was opened (decision 050); null when unknown. */
  readonly ipCountry: string | null;
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

/** A ticket with its public messages (only a ticket whose requester's address is confirmed, decision 053). */
export interface ExportTicket {
  readonly number: string;
  readonly subject: string;
  readonly status: string;
  readonly category: string;
  readonly createdAt: Date;
  readonly messages: Array<{ author: string; body: string; createdAt: Date }>;
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

/** One stored upload of an export: what it is called and how big it is, never where it is stored. */
export interface ExportFile {
  readonly id: number;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly createdAt: Date;
}

/** Everything the export reads about an account besides the account row. */
export interface ExportRows {
  readonly orders: ExportOrder[];
  readonly payments: ExportPayment[];
  readonly sessions: ExportSession[];
  readonly consents: ExportConsent[];
  readonly tickets: ExportTicket[];
  readonly requests: ExportRequest[];
  readonly files: ExportFile[];
}

/**
 * Reads everything the shop holds about an account.
 *
 * Why: GET /admin/clients/:id/export, the data-subject access right: the profile (read by the caller), the orders with their IMEI, the
 * payments without card data, the consents, the checkout sessions, the support tickets with their public messages (never the internal
 * notes; a ticket opened with a typed address that was never confirmed is not the account's data, decision 053), the data requests and
 * the uploaded files (name and size only). It works for an anonymized account too (the rows then hold the masks), and for a guest row.
 *
 * @param db the database or a transaction
 * @param accountId the account (or the guest row of its proven email)
 * @returns the rows, oldest first
 */
export async function exportRowsOf(db: DbExecutor, accountId: number): Promise<ExportRows> {
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
    .where(eq(s.orders.accountId, accountId))
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
    .where(eq(s.payments.accountId, accountId))
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
      ipCountry: s.checkoutSessions.ipCountry,
      userAgent: s.checkoutSessions.userAgent,
      orderId: s.checkoutSessions.orderId,
      createdAt: s.checkoutSessions.createdAt,
      expiresAt: s.checkoutSessions.expiresAt,
    })
    .from(s.checkoutSessions)
    .innerJoin(s.services, eq(s.services.id, s.checkoutSessions.serviceId))
    .where(eq(s.checkoutSessions.accountId, accountId))
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
    .where(and(eq(s.consentRecords.subjectType, 'account'), eq(s.consentRecords.subjectId, accountId)))
    .orderBy(asc(s.consentRecords.id));
  const tickets = await ticketsOf(db, accountId);
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
    .where(eq(s.dataRequests.accountId, accountId))
    .orderBy(asc(s.dataRequests.id));
  const files = await db
    .select({
      id: s.files.id,
      filename: s.files.filename,
      mime: s.files.mime,
      size: s.files.size,
      createdAt: s.files.createdAt,
    })
    .from(s.files)
    .where(and(eq(s.files.ownerType, 'account'), eq(s.files.ownerId, accountId)))
    .orderBy(asc(s.files.id));
  return { orders, payments, sessions, consents, tickets, requests, files };
}

async function ticketsOf(db: DbExecutor, accountId: number): Promise<ExportTicket[]> {
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
    .where(
      and(
        eq(s.supportTickets.requesterType, 'account'),
        eq(s.supportTickets.requesterId, accountId),
        // Decision 053: a ticket whose address is not confirmed is not in the customer's own data (the support module's one condition).
        s.requesterProven(),
      ),
    )
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

/** One API key in an export: its label and dates, never the key or its hash. */
export interface ExportApiKey {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** An invoice row as the database holds it (money owns the table). */
type InvoiceRow = typeof s.invoices.$inferSelect;

/** One invoice in an export. */
export interface ExportInvoice {
  readonly number: string;
  readonly kind: InvoiceRow['kind'];
  /** The wallet kind a top-up or manual invoice fills (`null` for the other kinds): tells a merchant invoice apart; not written to the file. */
  readonly walletKind: InvoiceRow['walletKind'];
  readonly status: string;
  readonly amount: string;
  readonly total: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
}

/** One line of the wallet statement of an export: debits shown as the owner sees them (a credit to the wallet is positive). */
export interface ExportWalletLine {
  readonly at: Date;
  readonly kind: string;
  readonly amount: string;
  readonly balanceAfter: string;
}

/** The merchant part of an export: the wallet and its statement, the API keys and the invoices. */
export interface MerchantExport {
  readonly wallet: {
    readonly currency: string;
    readonly balance: string;
    readonly reserved: string;
    readonly creditLimit: string;
    readonly lines: readonly ExportWalletLine[];
  } | null;
  readonly apiKeys: readonly ExportApiKey[];
  readonly invoices: readonly ExportInvoice[];
}

/** The wallets of a merchant are kept in US dollars (decision 011). */
const MERCHANT_WALLET_CURRENCY = 'USD';

/** The most statement lines an export holds. */
const EXPORT_LINES = 10_000;

/**
 * Reads what a merchant rank adds to an export: the wallet and its statement, the API keys and the invoices.
 *
 * Why: decision 064: an export of a merchant-rank account carries its merchant wallet and statement, its API keys (label, prefix and dates:
 * never a key and never a hash) and its invoices. The statement lines carry the kind and the amounts only: the memo of a line may hold a
 * staff reason, which the account never sees.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the merchant parts; the wallet is `null` when the account never had one
 */
export async function merchantExportOf(db: DbExecutor, accountId: number): Promise<MerchantExport> {
  // One after the other: the caller's transaction is one connection, which runs one query at a time.
  const accounts = await db
    .select({
      id: s.ledgerAccounts.id,
      kind: s.ledgerAccounts.kind,
      balance: s.ledgerAccounts.balance,
      overdraftLimit: s.ledgerAccounts.overdraftLimit,
    })
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
        eq(s.ledgerAccounts.currency, MERCHANT_WALLET_CURRENCY),
        inArray(s.ledgerAccounts.kind, ['client_wallet', 'client_hold']),
      ),
    );
  const wallet = accounts.find((row) => row.kind === 'client_wallet');
  const hold = accounts.find((row) => row.kind === 'client_hold');
  let walletPart: MerchantExport['wallet'] = null;
  if (wallet) {
    const entries = await db
      .select({
        at: s.ledgerEntries.createdAt,
        kind: s.ledgerTransactions.kind,
        amount: s.ledgerEntries.amount,
        balanceAfter: s.ledgerEntries.balanceAfter,
      })
      .from(s.ledgerEntries)
      .innerJoin(s.ledgerTransactions, eq(s.ledgerTransactions.id, s.ledgerEntries.transactionId))
      .where(eq(s.ledgerEntries.accountId, wallet.id))
      .orderBy(asc(s.ledgerEntries.id))
      .limit(EXPORT_LINES);
    walletPart = {
      currency: MERCHANT_WALLET_CURRENCY,
      balance: wallet.balance,
      reserved: hold?.balance ?? Money.zero().toWire(),
      creditLimit: wallet.overdraftLimit,
      // The ledger keeps debits positive: a credit to the wallet is negative there and positive for its owner.
      lines: entries.map((entry) => ({
        at: entry.at,
        kind: entry.kind,
        amount: Money.of(entry.amount).neg().toWire(),
        balanceAfter: entry.balanceAfter,
      })),
    };
  }
  const apiKeys = await db
    .select({
      id: s.apiKeys.id,
      name: s.apiKeys.name,
      prefix: s.apiKeys.prefix,
      createdAt: s.apiKeys.createdAt,
      lastUsedAt: s.apiKeys.lastUsedAt,
      expiresAt: s.apiKeys.expiresAt,
      revokedAt: s.apiKeys.revokedAt,
    })
    .from(s.apiKeys)
    .where(eq(s.apiKeys.clientId, accountId))
    .orderBy(asc(s.apiKeys.id));
  const invoices = await db
    .select({
      number: s.invoices.number,
      kind: s.invoices.kind,
      walletKind: s.invoices.walletKind,
      status: s.invoices.status,
      amount: s.invoices.amount,
      total: s.invoices.total,
      currency: s.invoices.currency,
      createdAt: s.invoices.createdAt,
      paidAt: s.invoices.paidAt,
    })
    .from(s.invoices)
    .where(eq(s.invoices.accountId, accountId))
    .orderBy(asc(s.invoices.id));
  return { wallet: walletPart, apiKeys, invoices };
}

/** The name and kind of an account's rank, for the export's profile. */
export interface ExportRank {
  readonly id: number;
  readonly name: string;
}

/**
 * Reads the name of a rank.
 *
 * @param db the database or a transaction
 * @param groupId the rank
 * @returns the id and name, or `undefined` when the rank row is gone
 */
export async function rankNameOf(db: DbExecutor, groupId: number): Promise<ExportRank | undefined> {
  const [row] = await db
    .select({ id: s.clientGroups.id, name: s.clientGroups.name })
    .from(s.clientGroups)
    .where(eq(s.clientGroups.id, groupId))
    .limit(1);
  return row;
}
