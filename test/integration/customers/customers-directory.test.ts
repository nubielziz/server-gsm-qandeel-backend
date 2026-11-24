// Integration test of the customers module's public directory (decision 064): what orders, support and money may know about the
// account behind a shop order link, read from the one account table by account id. It says whether the link speaks for the buyer, whether
// the account was anonymized, and whom the receipt names. Making a guest row is identity's `AccountDirectory`, never this class.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { CustomerDirectory } from '@src/modules/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { type OrdersWorld, ordersWorld } from '../../support/orders';
import { insertHeldOrder } from '../../support/risk';
import { makeAccount } from '../../support/store';

const directory = new CustomerDirectory();
let world: OrdersWorld;

beforeEach(async () => {
  await resetDb();
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

describe('CustomerDirectory.isErased', () => {
  it('is true for an anonymized account and for an account that is gone, false for any other', async () => {
    const { db } = await testDb();
    const active = await makeAccount({ rank: 'retail' });
    const merchant = await makeAccount({ rank: 'merchant' });
    const gone = await makeAccount({
      rank: 'retail',
      status: 'anonymized',
      anonymizedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(await directory.isErased(db, active.id)).toBe(false);
    expect(await directory.isErased(db, merchant.id)).toBe(false);
    expect(await directory.isErased(db, gone.id)).toBe(true);
    expect(await directory.isErased(db, 999_999)).toBe(true);
  });
});

describe('CustomerDirectory.orderLinkStanding', () => {
  it('lets the link of a guest row speak for the buyer: a guest checkout never attaches to a login account', async () => {
    const { db } = await testDb();
    const held = await insertHeldOrder(world);
    expect(await directory.orderLinkStanding(db, { id: held.orderId, customerId: held.accountId })).toBe(
      'speaks-for-customer',
    );
  });

  it('lets the link speak for a login account only when the account opened the checkout signed in', async () => {
    const { db } = await testDb();
    const account = await makeAccount({ rank: 'retail' });
    const signedIn = await insertHeldOrder(world, { customerId: account.id, openedSignedIn: true });
    const typed = await insertHeldOrder(world, { customerId: account.id, openedSignedIn: false });
    expect(await directory.orderLinkStanding(db, { id: signedIn.orderId, customerId: account.id })).toBe(
      'speaks-for-customer',
    );
    // An order a guest checkout typed with this address put under the account before the one account type: it proves nothing.
    expect(await directory.orderLinkStanding(db, { id: typed.orderId, customerId: account.id })).toBe('unconfirmed');
  });

  it('opens nothing for an anonymized account or an account that is gone', async () => {
    const { db } = await testDb();
    const gone = await makeAccount({
      rank: 'retail',
      status: 'anonymized',
      anonymizedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const held = await insertHeldOrder(world, { customerId: gone.id, openedSignedIn: true });
    expect(await directory.orderLinkStanding(db, { id: held.orderId, customerId: gone.id })).toBe('erased');
    expect(await directory.orderLinkStanding(db, { id: held.orderId, customerId: 999_999 })).toBe('erased');
  });
});

describe('CustomerDirectory.buyerOf', () => {
  it('names the stored name and address of the account only when it opened the checkout signed in', async () => {
    const { db } = await testDb();
    const account = await makeAccount({ rank: 'retail', name: 'Daniel Whitmore' });
    const signedIn = await insertHeldOrder(world, { customerId: account.id, openedSignedIn: true });
    const typed = await insertHeldOrder(world, { customerId: account.id, openedSignedIn: false });
    expect(await directory.buyerOf(db, signedIn.orderId)).toEqual({ name: 'Daniel Whitmore', email: account.email });
    // Any other checkout prints the address it was opened with and no stored name.
    expect(await directory.buyerOf(db, typed.orderId)).toEqual({ name: '', email: account.email });
  });

  it('answers nothing for an order without a checkout', async () => {
    const { db } = await testDb();
    expect(await directory.buyerOf(db, 999_999)).toBeUndefined();
  });
});
