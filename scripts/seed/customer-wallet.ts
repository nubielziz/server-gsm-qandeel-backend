// Development seed of the store balance (feature 21, plan § 10 B3): switches the store balance on, adds a manual B2C gateway (CliQ) and gives
// two seeded retail accounts that can sign in a credited $50 top-up and a top-up waiting for review. Called by dev-seed.ts in development only.
import { and, asc, eq, ne } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { type DbExecutor, schema as s } from '../../src/infra/db';
import { customerTopup, postTransaction } from '../../src/modules/money';
import { invoiceNumber, paymentRef } from '../../src/modules/money/domain/invoice-rules';
import { insertInvoice, reserveInvoiceId } from '../../src/modules/money/infra/invoice.repository';
import type { SeedReport } from './helpers';

/** The code of the manual gateway the seed adds. */
export const SEED_TOPUP_GATEWAY = 'cliq';

const CREDITED_KEY = 'seed:wallet:credited';
const IN_REVIEW_KEY = 'seed:wallet:in-review';

/**
 * Seeds the store balance of a development database.
 *
 * Why: the console's Wallet part of a retail account and the storefront's balance page need data to show; the money goes through `postTransaction`
 * (key `deposit:payment:<id>`, like a real credit), so the books stay balanced. Every write is keyed (the setting, the gateway code, the
 * invoices' `Idempotency-Key`), so a second run adds nothing.
 *
 * The two holders are the first retail accounts (a rank that is not a merchant one) that can sign in and may act, by number; the invoices are
 * of the store-balance kind (`wallet_kind = 'customer_wallet'`), whatever rank the account holds later.
 *
 * Side effects: may insert a `settings` row, a `payment_gateways` row, two `invoices`, two `payments` and one ledger transaction.
 *
 * @param db the transaction to write with
 * @param now the time the seeded rows carry
 * @returns how many top-ups were added and how many were already there
 */
export async function seedCustomerWallet(db: DbExecutor, now: Date): Promise<SeedReport> {
  await db
    .insert(s.settings)
    .values({ key: 'wallet.customer.enabled', value: true })
    .onConflictDoNothing({ target: s.settings.key });
  await db
    .insert(s.paymentGateways)
    .values({
      code: SEED_TOPUP_GATEWAY,
      driver: 'manual',
      name: 'CliQ transfer',
      audience: 'b2c',
      isManual: true,
      minAmount: '5',
      maxAmount: '500',
      instructions: 'Send the amount by CliQ to the alias GSMSHOP and write the top-up number in the note.',
    })
    .onConflictDoNothing({ target: s.paymentGateways.code });
  const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.code, SEED_TOPUP_GATEWAY));
  const holders = await db
    .select({ id: s.clients.id })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(and(eq(s.clients.hasAccount, true), eq(s.clients.status, 'active'), ne(s.clientGroups.kind, 'b2b')))
    .orderBy(asc(s.clients.id))
    .limit(2);
  if (!gateway || holders.length < 2) return { table: 'invoices (wallet top-ups)', inserted: 0, existing: 0 };
  let inserted = 0;
  let existing = 0;
  for (const [index, holder] of holders.entries()) {
    const key = index === 0 ? CREDITED_KEY : IN_REVIEW_KEY;
    const [found] = await db
      .select({ id: s.invoices.id })
      .from(s.invoices)
      .where(and(eq(s.invoices.accountId, holder.id), eq(s.invoices.idempotencyKey, key)));
    if (found) {
      existing++;
      continue;
    }
    const credited = index === 0;
    const id = await reserveInvoiceId(db);
    const invoice = await insertInvoice(db, {
      id,
      number: invoiceNumber(now.getUTCFullYear(), id),
      accountId: holder.id,
      walletKind: 'customer_wallet',
      kind: 'topup',
      amount: '50',
      fee: '0',
      netAmount: '50',
      total: '50',
      currency: 'USD',
      status: credited ? 'paid' : 'open',
      gatewayId: gateway.id,
      idempotencyKey: key,
      requestFingerprint: JSON.stringify([gateway.id, '50.0000']),
      description: 'Store balance top-up',
      paidAt: credited ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    const [payment] = await db
      .insert(s.payments)
      .values({
        purpose: 'topup',
        invoiceId: invoice.id,
        accountId: holder.id,
        gatewayId: gateway.id,
        gatewayTxnId: `CLIQ-SEED-${invoice.id}`,
        amount: '50',
        currency: 'USD',
        status: credited ? 'approved' : 'pending',
        methodType: 'bank',
        capturedAt: credited ? now : null,
        reviewedAt: credited ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: s.payments.id });
    if (credited) {
      await postTransaction(
        db,
        {
          ...customerTopup({ customerId: holder.id, amount: Money.of('50'), from: 'bank' }),
          refId: payment!.id,
          idempotencyKey: `deposit:payment:${payment!.id}`,
          currency: 'USD',
          memo: `Deposit ${paymentRef(payment!.id)} (Bank transfer)`,
          createdBy: { type: 'system', id: null },
        },
        now,
      );
    }
    inserted++;
  }
  return { table: 'invoices (wallet top-ups)', inserted, existing };
}
