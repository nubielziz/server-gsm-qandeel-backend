// Integration tests of how the ledger screens name an owner and an actor after the one account type (decision 064): a wallet is owned by
// ('account', id); a journal written before the merge keeps the word it was written with, so an old `customer` number is read through the
// legacy map and never as the account whose id happens to be the same number. Real Postgres, no application: the lookups of the money
// module's directory (`foreign-directory.repository`) are called as they are.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { insertLegacyRow, mapLegacyCustomer } from '../../support/legacy-accounts';
import { makeAccount } from '../../support/accounts';
import { insertRole, insertStaff, insertMerchant } from '../../support/auth';
import { insertSupplier } from '../../support/alerts';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  findOwnersByName,
  loadActorNames,
  loadOwnerNames,
  ownerKey,
} from '@src/modules/money/infra/foreign-directory.repository';

beforeEach(resetDb);
afterAll(closeTestDb);

/** A merchant, a shopper that was customer number `merchant id`, and a staff member: the trap the map avoids is the equal numbers. */
async function world() {
  const { db } = await testDb();
  const merchantId = await insertMerchant(db, { name: 'Seven Co' });
  const shopper = await makeAccount({ rank: 'retail', name: 'Dana Shopper', db });
  // The old customer number is the merchant's id: customer 1 is not account 1.
  await mapLegacyCustomer(db, merchantId, shopper.id);
  await insertLegacyRow(db, { legacyType: 'client', legacyId: merchantId, accountId: merchantId });
  const staffId = await insertStaff(db, await insertRole(db, ['*']), { name: 'Rami K.' });
  return { db, merchantId, shopper, staffId };
}

describe('loadActorNames', () => {
  it('names an old customer number through the legacy map, never as the account with the same number', async () => {
    const { db, merchantId, shopper } = await world();
    const names = await loadActorNames(db, [
      { type: 'customer', id: merchantId },
      { type: 'client', id: merchantId },
      { type: 'account', id: shopper.id },
    ]);
    expect(names.get(ownerKey('customer', merchantId))).toBe('Dana Shopper');
    expect(names.get(ownerKey('client', merchantId))).toBe('Seven Co');
    expect(names.get(ownerKey('account', shopper.id))).toBe('Dana Shopper');
  });

  it('leaves a customer number that the map does not know without a name, even when an account has that number', async () => {
    const { db, shopper } = await world();
    // The shopper's account id is not an old customer number of the map: customer <that id> must not read as the account <that id>.
    const names = await loadActorNames(db, [{ type: 'customer', id: shopper.id }]);
    expect(names.get(ownerKey('customer', shopper.id))).toBeUndefined();
    expect(names.size).toBe(0);
  });

  it('names staff members and keeps each stored pair under its own key', async () => {
    const { db, staffId, shopper } = await world();
    const names = await loadActorNames(db, [
      { type: 'staff', id: staffId },
      { type: 'account', id: shopper.id },
    ]);
    expect(names.get(ownerKey('staff', staffId))).toBe('Rami K.');
    expect([...names.keys()].sort()).toEqual([ownerKey('account', shopper.id), ownerKey('staff', staffId)].sort());
  });

  it('asks for nothing when no actor is given', async () => {
    const { db } = await testDb();
    expect((await loadActorNames(db, [])).size).toBe(0);
  });
});

describe('loadOwnerNames and findOwnersByName', () => {
  it('names the account and the supplier owners of ledger accounts', async () => {
    const { db, shopper, merchantId } = await world();
    const supplierId = await insertSupplier(db, 'Nordic GSM');
    const names = await loadOwnerNames(db, [
      { ownerType: 'account', ownerId: shopper.id },
      { ownerType: 'account', ownerId: merchantId },
      { ownerType: 'supplier', ownerId: supplierId },
    ]);
    expect(names.get(ownerKey('account', shopper.id))).toBe('Dana Shopper');
    expect(names.get(ownerKey('account', merchantId))).toBe('Seven Co');
    expect(names.get(ownerKey('supplier', supplierId))).toBe('Nordic GSM');
  });

  it('finds the owners of a name search among accounts and suppliers', async () => {
    const { db, shopper, merchantId } = await world();
    await insertSupplier(db, 'Dana Wholesale');
    const found = await findOwnersByName(db, '%dana%');
    expect(found.account).toEqual([shopper.id]);
    expect(found.supplier).toHaveLength(1);
    expect((await findOwnersByName(db, '%seven%')).account).toEqual([merchantId]);
  });
});
