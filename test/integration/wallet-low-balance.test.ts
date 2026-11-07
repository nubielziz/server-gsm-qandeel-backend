// Integration tests of the `wallet.low_balance` alert (feature 7b): a posting that takes a merchant wallet's available balance from the
// merchant's threshold (or above) to below it writes one outbox event, once per crossing, in the posting's own transaction. Real
// Postgres; postings go through the injectable LedgerPoster, the way wallet adjustments and orders will post.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { type Database, schema as s } from '../../src/infra/db';
import { LedgerPoster, adjust, deposit, order } from '../../src/modules/money';
import type { PostTransactionInput } from '../../src/modules/money';
import { type TestApp, createTestApp } from '../support/app';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { fundWallet, insertWalletMerchant } from '../support/money';
import { rejectionOf } from '../support/rejection';

let t: TestApp;
let db: Database;
let poster: LedgerPoster;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp();
  poster = t.app.get(LedgerPoster);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
});

const m = (amount: string) => Money.of(amount);
type Posting = Omit<PostTransactionInput, 'refId' | 'idempotencyKey' | 'currency' | 'createdBy'>;

/** Posts through the LedgerPoster in its own transaction. */
function post(posting: Posting, key = `k-${++counter}`) {
  return db.transaction((tx) =>
    poster.post(tx, {
      ...posting,
      refId: 1,
      idempotencyKey: key,
      currency: 'USD',
      createdBy: { type: 'system', id: null },
    }),
  );
}
const setThreshold = (clientId: number, threshold: unknown) =>
  db
    .update(s.clients)
    .set({ notificationPrefs: { lowBalanceThreshold: threshold } })
    .where(eq(s.clients.id, clientId));
const alerts = () =>
  db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'wallet.low_balance')).orderBy(s.outboxEvents.id);
const walletId = async (clientId: number) =>
  (await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.ownerId, clientId))).find(
    (account) => account.kind === 'client_wallet',
  )!.id;

describe('wallet.low_balance', () => {
  it('writes one event when a debit takes the available balance under the threshold, with the figures and no more', async () => {
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '100');
    await setThreshold(merchant.id, '50.0000');

    await post(order({ clientId: merchant.id, amount: m('30') }));
    expect(await alerts()).toEqual([]);
    await post(order({ clientId: merchant.id, amount: m('30') }));

    const [event] = await alerts();
    expect(event).toMatchObject({
      type: 'wallet.low_balance',
      aggregateType: 'ledger_accounts',
      aggregateId: await walletId(merchant.id),
    });
    expect(event?.payload).toMatchObject({
      clientId: merchant.id,
      currency: 'USD',
      available: '40.0000',
      threshold: '50.0000',
    });
  });

  it('writes one event per crossing, not per posting: none while it stays under, none for a credit, one more after it was back above', async () => {
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '100');
    await setThreshold(merchant.id, '50');

    await post(order({ clientId: merchant.id, amount: m('60') }));
    expect(await alerts()).toHaveLength(1);
    await post(order({ clientId: merchant.id, amount: m('10') }));
    await post(adjust({ clientId: merchant.id, amount: m('5'), direction: 'debit' }));
    expect(await alerts()).toHaveLength(1);
    await post(deposit({ clientId: merchant.id, amount: m('10') }));
    expect(await alerts()).toHaveLength(1);
    // Back above the threshold, then under it again: a second crossing.
    await post(deposit({ clientId: merchant.id, amount: m('100') }));
    expect(await alerts()).toHaveLength(1);
    await post(order({ clientId: merchant.id, amount: m('100') }));
    const events = await alerts();
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ available: '35.0000' });
  });

  it('counts the credit limit: available is balance plus limit', async () => {
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    await setThreshold(merchant.id, '50');
    await post(order({ clientId: merchant.id, amount: m('30') }));
    expect(await alerts()).toEqual([]);
    await post(order({ clientId: merchant.id, amount: m('30') }));
    const [event] = await alerts();
    // Balance -60, limit 100: 40 can still be spent.
    expect(event?.payload).toMatchObject({ available: '40.0000' });
  });

  it('sends nothing for a merchant with no threshold, a zero or a malformed one', async () => {
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '100');
    await post(order({ clientId: merchant.id, amount: m('90') }));
    for (const value of ['0', '-5', 'fifty', 50, null]) {
      await setThreshold(merchant.id, value);
      await post(deposit({ clientId: merchant.id, amount: m('100') }));
      await post(order({ clientId: merchant.id, amount: m('100') }));
    }
    expect(await alerts()).toEqual([]);
  });

  it('judges each merchant by its own threshold', async () => {
    const a = await insertWalletMerchant(db, { name: 'A' });
    const b = await insertWalletMerchant(db, { name: 'B' });
    for (const merchant of [a, b]) await fundWallet(db, merchant.id, '100');
    await setThreshold(a.id, '50');
    await setThreshold(b.id, '95');
    await post(order({ clientId: a.id, amount: m('20') }));
    await post(order({ clientId: b.id, amount: m('20') }));
    const events = await alerts();
    expect(events.map((event) => (event.payload as { clientId: number }).clientId)).toEqual([b.id]);
  });

  it('writes nothing for a replayed posting, and nothing when the posting rolls back', async () => {
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '100');
    await setThreshold(merchant.id, '50');
    await post(order({ clientId: merchant.id, amount: m('60') }), 'same-key');
    expect(await alerts()).toHaveLength(1);
    await post(order({ clientId: merchant.id, amount: m('60') }), 'same-key');
    expect(await alerts()).toHaveLength(1);

    await db.delete(s.outboxEvents);
    await post(deposit({ clientId: merchant.id, amount: m('100') }));
    const failure = await rejectionOf(
      db.transaction(async (tx) => {
        await poster.post(tx, {
          ...order({ clientId: merchant.id, amount: m('100') }),
          refId: 2,
          idempotencyKey: 'rolled-back',
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        });
        throw new Error('the use case failed after the posting');
      }),
    );
    expect((failure as Error).message).toContain('the use case failed');
    expect(await alerts()).toEqual([]);
  });
});
