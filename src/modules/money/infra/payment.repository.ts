// Drizzle queries on payments (map routes /admin/payments*, /client/invoices/:id/receipt, the payment webhook and the automatic
// credit job, stage 8): the top-up list with sort, search and exact count, find with a row lock, insert, guarded update, the due
// payments of the job and the lookups the wire needs. Only the money module touches this table. The owner of a top-up is the account of
// its invoice (`invoices.account_id`) and the wallet it fills is the invoice's `wallet_kind` (decision 064).
import { type SQL, and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { CustomerContact } from '../../../common/customer-contact';
import type { DbExecutor } from '../../../infra/db';
import { escapeLike, listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type InvoiceWalletKind, type NewPayment, type Payment, invoices, payments } from '../db/schema';
import { normalizeBankReference } from '../domain/payment-rules';
import { findCustomerIdsByNameOrEmail, findMerchantIdsByName } from './foreign-directory.repository';

/** The sort fields of the top-up payment list. */
export type PaymentSortField = 'createdAt' | 'id' | 'amount' | 'status';

/** A payment with the account and the wallet kind of its invoice. */
export interface PaymentRow {
  readonly payment: Payment;
  /** `invoices.account_id` of the linked invoice: the account that topped up, of either rank; `null` without an invoice. */
  readonly accountId: number | null;
  /** `invoices.wallet_kind` of the linked invoice: the wallet it fills (`client_wallet` or `customer_wallet`); `null` without an invoice. */
  readonly walletKind: InvoiceWalletKind | null;
}

// `accountId` and its documented alias `clientId` name one column. The owner word reads the invoice's wallet kind (decision 064): a row
// never infers its owner from which owner column is empty (the words are `TOP_UP_OWNER_WORDS`, the values of the `owner` filter).
const OWNER_WORD = sql`case ${invoices.walletKind} when 'client_wallet' then 'merchant' when 'customer_wallet' then 'customer' end`;

const COLUMNS = {
  createdAt: payments.createdAt,
  id: payments.id,
  amount: payments.amount,
  status: payments.status,
  purpose: payments.purpose,
  accountId: invoices.accountId,
  clientId: invoices.accountId,
  owner: OWNER_WORD,
};

const ROW = { payment: payments, accountId: invoices.accountId, walletKind: invoices.walletKind };

/**
 * Lists top-up payments.
 *
 * Why: RESOLUTIONS money-2: `/admin/payments` serves top-ups only, so the list always adds `purpose = 'topup'` (a `purpose=order`
 * filter then matches nothing).
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the gateway reference, as typed and in the stored form of a bank reference
 *   (`normalizeBankReference`), and the account's name; `accountId` or its alias `clientId` keeps the top-ups of one account of either
 *   rank; `owner` keeps the merchant wallet's or the store balance's)
 * @param contact what the caller may see of accounts' addresses: for `masked` `q` matches an account's name only (decision 047)
 * @returns the page of rows and the number matching the filters
 */
export async function listPaymentRows(
  db: DbExecutor,
  query: ParsedListQuery<PaymentSortField>,
  contact: CustomerContact,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const alternatives: SQL[] = [];
  if (query.search) {
    const pattern = `%${escapeLike(query.search.text)}%`;
    alternatives.push(sql`${payments.gatewayTxnId} ilike ${pattern}`);
    // A bank reference of a receipt is stored in one form: staff may type it as the payer wrote it.
    const folded = normalizeBankReference(query.search.text);
    if (folded !== '' && folded !== query.search.text) {
      alternatives.push(sql`${payments.gatewayTxnId} ilike ${`%${escapeLike(folded)}%`}`);
    }
    // One table holds every account: the name matches an account of either rank, and the address one for a caller who may read it.
    const byName = await findMerchantIdsByName(db, pattern);
    const byNameOrEmail = await findCustomerIdsByNameOrEmail(db, pattern, contact === 'full');
    const accountIds = [...new Set([...byName, ...byNameOrEmail])];
    if (accountIds.length > 0) alternatives.push(inArray(invoices.accountId, accountIds));
  }
  const where = listWhere(
    { filters: query.filters, search: undefined },
    COLUMNS,
    eq(payments.purpose, 'topup'),
    query.search ? or(...alternatives) : undefined,
  );
  const [rows, [counted]] = await Promise.all([
    db
      .select(ROW)
      .from(payments)
      .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, payments.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(payments)
      .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a top-up payment by id with its account.
 *
 * @param db the database or a transaction
 * @param id the payment id
 * @returns the row, or `undefined` when there is no top-up payment with the id (an order payment is not served here)
 */
export async function findTopupPayment(db: DbExecutor, id: number): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select(ROW)
    .from(payments)
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(payments.id, id), eq(payments.purpose, 'topup')))
    .limit(1);
  return row;
}

/**
 * Finds a top-up payment and locks it `FOR UPDATE` until the transaction ends.
 *
 * Why: approve, reject and the automatic credit all lock the payment first and re-check its status under the lock, so the loser of
 * a race changes nothing (RESOLUTIONS money-3). Lock order everywhere: the payment, then its invoice, then the ledger accounts.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @returns the payment, or `undefined` for an unknown id or an order payment
 */
export async function lockTopupPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'topup')))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds the payment a gateway reference already created.
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway
 * @param reference the gateway's id of the payment
 * @returns the payment, or `undefined`
 */
export async function findPaymentByReference(
  db: DbExecutor,
  gatewayId: number,
  reference: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.gatewayId, gatewayId), eq(payments.gatewayTxnId, reference)))
    .limit(1);
  return row;
}

/**
 * Finds the payment of a gateway that holds a bank reference: one without a receipt file whatever its status, or a pending or approved
 * one with a receipt file.
 *
 * Why: a bank reference names one transfer, so it backs one live payment of a manual method; a rejected claim releases it, so the payer
 * who made the transfer can still name it. New references are stored in one form (`normalizeBankReference`); a row stored before that
 * is compared with its white space and `-` removed and in upper case. The partial unique index `payments_gateway_txn_uq` decides
 * between two receipts that pass this check at the same moment.
 *
 * @param db the receipt's transaction
 * @param gatewayId the manual gateway
 * @param reference the reference in its stored form (`normalizeBankReference`, not empty)
 * @returns the payment, or `undefined`
 */
export async function findLiveBankReference(
  db: DbExecutor,
  gatewayId: number,
  reference: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.gatewayId, gatewayId),
        or(isNull(payments.receiptFileId), inArray(payments.status, ['pending', 'approved'])),
        or(
          eq(payments.gatewayTxnId, reference),
          sql`upper(regexp_replace(${payments.gatewayTxnId}, '[[:space:]-]+', '', 'g')) = ${reference}`,
        ),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Inserts a payment, or does nothing when the gateway reference is already there.
 *
 * Why: the unique index on `(gateway_id, gateway_txn_id)` is what makes a repeated webhook create one payment, even when two
 * deliveries race.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row, or `undefined` when the reference already existed
 */
export async function insertPaymentOnce(db: DbExecutor, row: NewPayment): Promise<Payment | undefined> {
  const [created] = await db.insert(payments).values(row).onConflictDoNothing().returning();
  return created;
}

/**
 * Inserts a payment.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertPayment(db: DbExecutor, row: NewPayment): Promise<Payment> {
  const [created] = await db.insert(payments).values(row).returning();
  return created!;
}

/**
 * Updates a payment.
 *
 * Side effects: updates the `payments` row.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updatePayment(db: DbExecutor, id: number, changes: Partial<NewPayment>): Promise<Payment> {
  const [updated] = await db.update(payments).set(changes).where(eq(payments.id, id)).returning();
  return updated!;
}

/**
 * Lists the top-up payments of an invoice, oldest first.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice
 * @returns its payments
 */
export async function listPaymentsOfInvoice(db: DbExecutor, invoiceId: number): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(asc(payments.id));
}

/**
 * Finds the top-up payments of an invoice that wait for a decision.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice
 * @returns its pending payments
 */
export async function pendingPaymentsOfInvoice(db: DbExecutor, invoiceId: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'pending')));
}

/**
 * The ids of the automatic top-ups that are due to credit themselves.
 *
 * Why: the job's sweep: pending top-ups whose time has come and that risk has not sent to staff (the partial index
 * `payments_auto_credit_idx` covers the filter). The job re-reads each one under a lock, so this list is only a to-do.
 *
 * @param db the database or a transaction
 * @param now the clock's time
 * @param limit the most ids to return
 * @returns the payment ids, oldest due first
 */
export async function dueAutoCreditIds(db: DbExecutor, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'topup'),
        eq(payments.status, 'pending'),
        eq(payments.reviewRequired, false),
        lte(payments.autoCreditAt, now),
      ),
    )
    .orderBy(asc(payments.autoCreditAt), asc(payments.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Tells which of some accounts already have an approved top-up.
 *
 * Why: a pending top-up of an account with none is a first deposit (a first top-up), which the reviewer is told (the note hint of
 * money.md). One query for both wallet kinds: the account is the owner of the invoice, of either rank (decision 064).
 *
 * @param db the database or a transaction
 * @param accountIds the accounts
 * @returns the ids that have at least one approved top-up
 */
export async function accountsWithApprovedTopup(db: DbExecutor, accountIds: readonly number[]): Promise<Set<number>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ accountId: invoices.accountId })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(eq(payments.purpose, 'topup'), eq(payments.status, 'approved'), inArray(invoices.accountId, [...accountIds])),
    );
  return new Set(rows.map((row) => row.accountId));
}

/**
 * Serialises the checks of one receipt content until the transaction ends.
 *
 * Why: decision 049: two uploads of the same bytes, to two invoices at once, are judged one after the other, so only one can pass.
 *
 * Side effects: takes `pg_advisory_xact_lock(hashtextextended('receipt-proof:<sha256>', 0))`, released at commit or rollback.
 *
 * @param tx the transaction that inserts the payment
 * @param sha256 the hex SHA-256 of the receipt
 */
export async function lockReceiptContent(tx: DbExecutor, sha256: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receipt-proof:${sha256}`}, 0))`);
}

/**
 * Tells whether one of the given files is the receipt of a pending or approved payment.
 *
 * Why: decision 049: one receipt backs one live payment; a rejected payment releases its file.
 *
 * @param db the database or a transaction
 * @param fileIds the file ids (every file with one content)
 * @returns true when such a payment exists
 */
export async function liveReceiptPaymentExists(db: DbExecutor, fileIds: readonly number[]): Promise<boolean> {
  if (fileIds.length === 0) return false;
  const [row] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(inArray(payments.receiptFileId, [...fileIds]), inArray(payments.status, ['pending', 'approved'])))
    .limit(1);
  return row !== undefined;
}

/**
 * Counts an account's receipts on top-up invoices that wait for review.
 *
 * Why: decision 049: at most five per account (`MERCHANT_OPEN_TOPUPS`), so older unpaid top-ups that stopped counting as open cannot
 * fill the review queue. Read under the account's top-up lock (`topup:<accountId>`).
 *
 * @param db the receipt's transaction
 * @param accountId the account
 * @returns the number of pending payments with a receipt file on the account's `topup` invoices
 */
export async function countPendingTopUpReceipts(db: DbExecutor, accountId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(
        eq(invoices.accountId, accountId),
        eq(invoices.kind, 'topup'),
        eq(payments.status, 'pending'),
        sql`${payments.receiptFileId} is not null`,
      ),
    );
  return row?.n ?? 0;
}
