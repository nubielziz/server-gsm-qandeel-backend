// Integration tests of the frozen merchant wallet (decision 064): a frozen `client_wallet` takes no new hold, and
// `AccountWallets.assertNotFrozen` is what the order placement calls after the account row lock and before it posts the hold. Settlement and
// release of holds that exist, credits and staff debits still post on a frozen wallet. The service is built as the module builds it, on the
// real database; the HTTP refusal of the placement belongs to the order engine's tests, which call the same method.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AppError } from '@src/common/errors';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import {
  type PostTransactionInput,
  adjust,
  complete,
  deposit,
  order,
  postTransaction,
  reject,
} from '@src/modules/money';
import { AccountWalletsService } from '@src/modules/money/application/account-wallets';
import type { SettingsReader } from '@src/modules/platform';
import { makeAccount } from '../../support/accounts';
import { insertInvoiceRow } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { accountFigures, fundWallet, insertWalletMerchant } from '../../support/money';
import { rejectionOf } from '../../support/rejection';

beforeEach(resetDb);
afterAll(closeTestDb);

const m = (amount: string) => Money.of(amount);
const clock = new TestClock(new Date().toISOString());
/** The settings are all at their defaults: no key is set. */
const settings = { all: () => Promise.resolve({}) } as unknown as SettingsReader;
const wallets = new AccountWalletsService(settings, clock);

const freeze = (
  db: Database,
  accountId: number,
  kind: 'client_wallet' | 'customer_wallet',
  reason = 'Dispute review',
) =>
  db
    .update(s.ledgerAccounts)
    .set({ frozenAt: new Date(), frozenReason: reason })
    .where(
      and(
        eq(s.ledgerAccounts.kind, kind),
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
      ),
    );

let counter = 0;

/** A posting of an event builder with a fresh key, as the use cases post it. */
const posting = (event: Pick<PostTransactionInput, 'kind' | 'refType' | 'lines'>): PostTransactionInput => ({
  ...event,
  refId: 1,
  idempotencyKey: `frozen-test:${++counter}`,
  currency: 'USD',
  createdBy: { type: 'system', id: null },
});

const post = (db: Database, input: PostTransactionInput) =>
  db.transaction((tx) => postTransaction(tx, input, new Date()));

async function frozenMerchant() {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  await fundWallet(db, merchant.id, '100');
  await freeze(db, merchant.id, 'client_wallet');
  return { db, merchant };
}

describe('AccountWallets.assertNotFrozen', () => {
  it('lets a hold through while the merchant wallet is not frozen', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    expect(await db.transaction((tx) => wallets.assertNotFrozen(tx, merchant.id))).toBeUndefined();
  });

  it('refuses a new hold on a frozen merchant wallet with 409 WALLET_FROZEN', async () => {
    const { db, merchant } = await frozenMerchant();
    const error = await rejectionOf(db.transaction((tx) => wallets.assertNotFrozen(tx, merchant.id)));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('WALLET_FROZEN');
    expect((error as AppError).status).toBe(409);
  });

  it('has nothing to refuse for an account whose wallet was never opened', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const account = await makeAccount({ rank: 'merchant', db });
    expect(await db.transaction((tx) => wallets.assertNotFrozen(tx, account.id))).toBeUndefined();
  });

  it('reads the merchant wallet only: a frozen store balance blocks no hold', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await db.insert(s.ledgerAccounts).values({
      kind: 'customer_wallet',
      ownerType: 'account',
      ownerId: merchant.id,
      currency: 'USD',
      frozenAt: new Date(),
      frozenReason: 'left behind',
    });
    expect(await db.transaction((tx) => wallets.assertNotFrozen(tx, merchant.id))).toBeUndefined();
  });
});

describe('a frozen merchant wallet still takes the postings that are not a new hold', () => {
  it('settles and releases the hold that exists, takes a credit and a staff debit', async () => {
    const { db, merchant } = await frozenMerchant();
    // The hold was placed before the freeze (a freeze never reaches back), so it can still be settled or released.
    await postHold(db, merchant.id, '40');
    const settled = await post(db, posting(complete({ clientId: merchant.id, price: m('40') })));
    expect(settled.replayed).toBe(false);
    await postHold(db, merchant.id, '10');
    await post(db, posting(reject({ clientId: merchant.id, amount: m('10') })));
    await post(db, posting(deposit({ clientId: merchant.id, amount: m('5') })));
    await post(db, posting(adjust({ clientId: merchant.id, amount: m('3'), direction: 'debit' })));
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id })).toMatchObject({
      balance: '62.0000',
    });
    expect(await accountFigures(db, 'client_hold', { type: 'account', id: merchant.id })).toMatchObject({
      balance: '0.0000',
    });
  });
});

describe('AccountWallets.kindOf and viewsOf', () => {
  it('names the kind of the rank: merchant for a merchant rank, store for any other', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchant = await makeAccount({ rank: 'merchant', db });
    const shopper = await makeAccount({ rank: 'retail', db });
    expect(await db.transaction((tx) => wallets.kindOf(tx, merchant.id))).toBe('merchant');
    expect(await db.transaction((tx) => wallets.kindOf(tx, shopper.id))).toBe('store');
    const missing = await rejectionOf(db.transaction((tx) => wallets.kindOf(tx, 999_999)));
    expect(missing).toBeInstanceOf(Error);
  });

  it('answers the live wallet of each account in one call: figures, the freeze and the pending top-ups', async () => {
    const { db, merchant } = await frozenMerchant();
    await insertInvoiceRow(db, merchant.id, { amount: '40.0000', fee: '1.0000' });
    const shopper = await makeAccount({ rank: 'retail', db });
    const views = await wallets.viewsOf(db, [merchant.id, shopper.id, 999_999]);
    expect([...views.keys()].sort()).toEqual([merchant.id, shopper.id].sort());
    expect(views.get(merchant.id)).toMatchObject({
      kind: 'merchant',
      currency: 'USD',
      balance: '100.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '100.0000',
      creditAllowed: false,
      frozen: { reason: 'Dispute review' },
      enabled: true,
      pendingTopUps: { count: 1, amount: '39.0000' },
      openDisputes: 0,
      adjustApprovalLimit: '10000.0000',
    });
    // An account that never had a wallet reads as zeros, with the kind of its rank.
    expect(views.get(shopper.id)).toMatchObject({
      kind: 'store',
      balance: '0.0000',
      available: '0.0000',
      creditAllowed: false,
      frozen: null,
      enabled: false,
      pendingTopUps: { count: 0, amount: '0.0000' },
      adjustApprovalLimit: '500.0000',
    });
  });

  it('reads only the wallet of the rank kind: money left on the other kind does not show', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '70');
    await db.insert(s.ledgerAccounts).values({
      kind: 'customer_wallet',
      ownerType: 'account',
      ownerId: merchant.id,
      currency: 'USD',
      balance: '9.0000',
    });
    const view = (await wallets.viewsOf(db, [merchant.id])).get(merchant.id);
    expect(view).toMatchObject({ kind: 'merchant', balance: '70.0000' });
  });

  it('asks nothing of the database for no account', async () => {
    const { db } = await testDb();
    expect((await wallets.viewsOf(db, [])).size).toBe(0);
  });
});

/** Moves an amount from the wallet to the hold, as an order that was placed before the freeze did. */
async function postHold(db: Database, accountId: number, amount: string) {
  await post(db, posting(order({ clientId: accountId, amount: m(amount) })));
}
