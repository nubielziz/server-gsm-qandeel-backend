// Drizzle queries of the top-ups of the store balance (feature 21, plan § 5.6.4) and the lookups both top-up creates share: a store top-up
// is a `topup` invoice of the account with the wallet kind `customer_wallet` and, once paid, a `topup` payment. The advisory lock of an
// account's top-ups is `lockAccountTopUps` (decision 064), one lock for both creates, both receipt uploads and the rank change.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import {
  type Invoice,
  type InvoiceWalletKind,
  type Payment,
  type PaymentGateway,
  invoices,
  paymentGateways,
  payments,
} from '../db/schema';
import { type PriorTopUpVerdict, judgePriorTopUp } from '../domain/invoice-rules';
import { findGateway } from './gateway.repository';

/** The store top-ups of an account: its `topup` invoices that fill the store balance. */
const ownTopUp = (accountId: number) =>
  and(eq(invoices.accountId, accountId), eq(invoices.kind, 'topup'), eq(invoices.walletKind, 'customer_wallet'));

/**
 * Finds the account's top-up created with an `Idempotency-Key`, of either wallet kind.
 *
 * Why: the unique index `invoices_account_key_uq` holds one invoice per account and key, whatever wallet it fills.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param key the key
 * @returns the invoice, or `undefined`
 */
export async function findTopUpByKey(db: DbExecutor, accountId: number, key: string): Promise<Invoice | undefined> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.accountId, accountId), eq(invoices.kind, 'topup'), eq(invoices.idempotencyKey, key)))
    .limit(1);
  return row;
}

/**
 * Reads the invoice an earlier create left under a key and judges what the new request does with it.
 *
 * Why: one rule for the merchant's and the store's create (decision 064): see {@link judgePriorTopUp}. The caller holds the account's
 * top-up lock, so no other create of the account runs between this read and its own insert.
 *
 * @param tx the caller's transaction
 * @param accountId the account
 * @param key the `Idempotency-Key`
 * @param request the new request: its fingerprint and the wallet kind it fills
 * @param now the clock's time
 * @returns the earlier invoice and the verdict, or `undefined` when the key is new
 */
export async function judgeTopUpKey(
  tx: DbExecutor,
  accountId: number,
  key: string,
  request: { readonly fingerprint: string; readonly walletKind: InvoiceWalletKind },
  now: Date,
): Promise<{ readonly prior: Invoice; readonly verdict: PriorTopUpVerdict } | undefined> {
  const prior = await findTopUpByKey(tx, accountId, key);
  if (!prior) return undefined;
  const gateway = await findGateway(tx, prior.gatewayId);
  return { prior, verdict: judgePriorTopUp(prior, request, gateway?.isManual ?? true, now) };
}

/**
 * Finds one of the account's store top-ups.
 *
 * @param db the database or a transaction
 * @param accountId the account (another account's top-up is not found, and neither is a merchant top-up the account made before a rank change)
 * @param id the invoice id
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the invoice, or `undefined`
 */
export async function findCustomerTopUp(
  db: DbExecutor,
  accountId: number,
  id: number,
  lock = false,
): Promise<Invoice | undefined> {
  const query = db
    .select()
    .from(invoices)
    .where(and(ownTopUp(accountId), eq(invoices.id, id)))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Lists the account's store top-ups, newest first by default, with an exact count.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param query the parsed list request (`createdAt` sort and the range)
 * @returns the page and the total
 */
export async function listCustomerTopUps(
  db: DbExecutor,
  accountId: number,
  query: ParsedListQuery<'createdAt'>,
): Promise<{ rows: Invoice[]; total: number }> {
  const direction = query.sort[0]?.order === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(invoices)
    .where(ownTopUp(accountId))
    .orderBy(direction(invoices.createdAt), direction(invoices.id))
    .limit(query.range.limit)
    .offset(query.range.start);
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(invoices)
    .where(ownTopUp(accountId));
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Reads the newest payment of each invoice.
 *
 * Why: a top-up's store status and reference come from its newest payment (a rejected receipt voids the top-up; a new top-up is a new
 * invoice), batched for a page.
 *
 * @param db the database or a transaction
 * @param invoiceIds the invoices
 * @returns the newest payment by invoice id
 */
export async function latestPaymentsOf(db: DbExecutor, invoiceIds: readonly number[]): Promise<Map<number, Payment>> {
  const unique = [...new Set(invoiceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(payments).where(inArray(payments.invoiceId, unique)).orderBy(asc(payments.id));
  const map = new Map<number, Payment>();
  for (const row of rows) if (row.invoiceId !== null) map.set(row.invoiceId, row);
  return map;
}

/**
 * Lists the gateways a storefront customer may top up through: active, for B2C or both audiences, by name.
 *
 * @param db the database or a transaction
 * @returns the gateways (the caller keeps manual ones, and automatic ones with a driver while card top-ups are on)
 */
export async function listTopUpGateways(db: DbExecutor): Promise<PaymentGateway[]> {
  return db
    .select()
    .from(paymentGateways)
    .where(and(eq(paymentGateways.isActive, true), inArray(paymentGateways.audience, ['b2c', 'both'])))
    .orderBy(asc(paymentGateways.name), asc(paymentGateways.id));
}

/**
 * Stores the hosted payment page of an automatic top-up, while it is still open.
 *
 * Side effects: updates `invoices.checkout_url`.
 *
 * @param tx the transaction
 * @param invoiceId the top-up
 * @param url the gateway's page
 * @param now the clock's time
 * @returns the invoice after the change, or `undefined` when it was no longer open
 */
export async function storeTopUpCheckoutUrl(
  tx: DbExecutor,
  invoiceId: number,
  url: string,
  now: Date,
): Promise<Invoice | undefined> {
  const [row] = await tx
    .update(invoices)
    .set({ checkoutUrl: url, updatedAt: now })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'open')))
    .returning();
  return row;
}

/**
 * Voids a top-up that has no payment and frees its `Idempotency-Key` (a gateway that failed to open its page, or a stale attempt).
 *
 * Side effects: updates `invoices.status`, `idempotency_key` and `updated_at` when the top-up is open and has no payment.
 *
 * @param tx the transaction
 * @param invoiceId the top-up
 * @param now the clock's time
 * @returns true when it was voided
 */
export async function voidUnpaidTopUp(tx: DbExecutor, invoiceId: number, now: Date): Promise<boolean> {
  const rows = await tx
    .update(invoices)
    .set({ status: 'void', idempotencyKey: null, updatedAt: now })
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.status, 'open'),
        sql`not exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id})`,
      ),
    )
    .returning({ id: invoices.id });
  return rows.length > 0;
}
