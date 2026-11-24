// Test helpers of the store balance (feature 21): switch it on, credit a retail account's balance through the ledger, read the wallet row.
// The wallet is the `customer_wallet` ledger account of an account of the retail rank, owned by ('account', id) (decision 064).
import { and, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { customerAdjust, customerTopup, customerWalletTemplatesSql, postTransaction } from '@src/modules/money';
import { SettingsReader } from '@src/modules/platform';
import type { LightMyRequestResponse } from 'fastify';
import type { TestApp } from './app';
import { installTemplates } from './notifications';
import { APPLE_IMEI, type StorefrontWorld } from './storefront';
import type { StoreClient } from './store';

/**
 * Inserts the five default wallet templates (the reset empties the table the migration filled), so the wallet mails are written.
 *
 * @param db the test database
 */
export async function insertWalletTemplates(db: Database): Promise<void> {
  await installTemplates(db, customerWalletTemplatesSql());
}

/**
 * Saves wallet settings (the master switch on by default) and drops the cached snapshot.
 *
 * @param t the running test app
 * @param db the test database
 * @param values setting key to JSON value, on top of `wallet.customer.enabled: true`
 */
export async function walletSettings(t: TestApp, db: Database, values: Record<string, unknown> = {}): Promise<void> {
  const all = { 'wallet.customer.enabled': true, ...values };
  for (const [key, value] of Object.entries(all)) {
    await db.insert(s.settings).values({ key, value }).onConflictDoUpdate({ target: s.settings.key, set: { value } });
  }
  await t.app.get(SettingsReader).invalidate();
}

/**
 * Credits a retail account's balance through `postTransaction` (a manual top-up from `bank`).
 *
 * @param db the test database
 * @param accountId the retail account
 * @param amount the net credited
 * @param at the posting time (the test clock's, when a test filters by time)
 * @returns the journal id
 */
export async function fundCustomer(db: Database, accountId: number, amount: string, at = new Date()): Promise<number> {
  const posted = await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...customerTopup({ customerId: accountId, amount: Money.of(amount), from: 'bank' }),
        refId: 1,
        idempotencyKey: `fund-customer:${crypto.randomUUID()}`,
        currency: 'USD',
        memo: 'Top-up PAY-1 (Bank transfer)',
        createdBy: { type: 'system', id: null },
      },
      at,
    ),
  );
  return posted.id;
}

/**
 * Debits a retail account's balance by a system adjustment that may take it below zero, freezing it in the same transaction.
 *
 * @param db the test database
 * @param accountId the retail account
 * @param amount the debit
 */
export async function pushNegative(db: Database, accountId: number, amount: string): Promise<void> {
  await db.transaction(async (tx) => {
    await postTransaction(
      tx,
      {
        ...customerAdjust({ customerId: accountId, amount: Money.of(amount), direction: 'debit' }),
        refId: accountId,
        idempotencyKey: `negative:${crypto.randomUUID()}`,
        currency: 'USD',
        createdBy: { type: 'system', id: null },
        allowNegativeCustomerWallet: true,
      },
      new Date(),
    );
    await tx
      .update(s.ledgerAccounts)
      .set({ frozenAt: new Date(), frozenReason: 'Chargeback' })
      .where(
        and(
          eq(s.ledgerAccounts.kind, 'customer_wallet'),
          eq(s.ledgerAccounts.ownerType, 'account'),
          eq(s.ledgerAccounts.ownerId, accountId),
        ),
      );
  });
}

/**
 * Reads a retail account's wallet row.
 *
 * @param db the test database
 * @param accountId the retail account
 * @returns the row, or `undefined`
 */
export async function customerWalletRow(db: Database, accountId: number) {
  const [row] = await db
    .select()
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.kind, 'customer_wallet'),
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
      ),
    );
  return row;
}

/**
 * Opens a checkout of the iCloud service in GBP as the signed-in customer of `client` (so it may be paid from the balance) and, unless
 * told otherwise, records the three consents.
 *
 * @param client the signed-in store client
 * @param world the storefront
 * @param email the account's email
 * @param options `consent: false` leaves the consents out; `currency`, `serviceId` change the checkout; `headers` are added to the open call (the
 *   visitor-country header of a proxy)
 * @returns the checkout token and the session as opened
 */
export async function openSignedInCheckout(
  client: StoreClient,
  world: StorefrontWorld,
  email: string,
  options: { consent?: boolean; currency?: string; serviceId?: number; headers?: Record<string, string> } = {},
): Promise<{ token: string; session: Record<string, unknown> }> {
  const res = await client.call(
    'POST',
    '/store/v1/checkout-sessions',
    {
      serviceId: options.serviceId ?? world.icloud.serviceId,
      email,
      country: 'GB',
      currency: options.currency ?? 'GBP',
      imei: APPLE_IMEI,
    },
    { headers: { 'user-agent': 'Mozilla/5.0 (test)', ...options.headers } },
  );
  if (res.statusCode !== 201) throw new Error(`open checkout answered ${res.statusCode}: ${res.body}`);
  const session = res.json<Record<string, unknown> & { token: string }>();
  if (options.consent !== false) {
    const consents = await client.call(
      'POST',
      `/store/v1/checkout-sessions/${session.token}/consents`,
      {
        consents: [
          { purpose: 'terms', granted: true },
          { purpose: 'privacy', granted: true },
          { purpose: 'withdrawal_waiver', granted: true },
        ],
      },
      { headers: { 'user-agent': 'Mozilla/5.0 (test)' } },
    );
    if (consents.statusCode !== 201) throw new Error(`consents answered ${consents.statusCode}: ${consents.body}`);
  }
  return { token: session.token, session };
}

/**
 * `POST /store/v1/checkout-sessions/:token/balance-payment` from a store client (its cookie and CSRF token unless told otherwise).
 *
 * @param client the store client
 * @param token the checkout token
 * @param key the `Idempotency-Key` (`null` leaves it out)
 * @param options `csrf: false` leaves the CSRF header out; `cookies: false` sends no session cookie
 * @returns the answer
 */
export function payFromBalance(
  client: StoreClient,
  token: string,
  key: string | null = crypto.randomUUID(),
  options: { csrf?: boolean; cookies?: boolean } = {},
): Promise<LightMyRequestResponse> {
  return client.call('POST', `/store/v1/checkout-sessions/${token}/balance-payment`, undefined, {
    ...options,
    headers: key === null ? {} : { 'idempotency-key': key },
  });
}
