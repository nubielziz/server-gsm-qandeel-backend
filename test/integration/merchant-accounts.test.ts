// Integration tests of MerchantAccounts.open (resolution identity-platform-1, user rule 2): the wallet and hold accounts of
// a new merchant, opened in the caller's transaction.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { schema as s } from '../../src/infra/db';
import { MerchantAccounts } from '../../src/modules/money';
import { insertMerchant } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { rejectionOf } from '../support/rejection';

beforeEach(resetDb);
afterAll(closeTestDb);

const accounts = new MerchantAccounts();

async function accountsOf(clientId: number) {
  const { db } = await testDb();
  return db
    .select({ kind: s.ledgerAccounts.kind, limit: s.ledgerAccounts.overdraftLimit, balance: s.ledgerAccounts.balance })
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'client'), eq(s.ledgerAccounts.ownerId, clientId)))
    .orderBy(s.ledgerAccounts.kind);
}

describe('MerchantAccounts.open', () => {
  it('opens the wallet with the credit limit and the hold, and answers the wallet view', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const clientId = await insertMerchant(db);
    const view = await accounts.open(db, {
      clientId,
      currency: 'USD',
      creditLimit: '250.0000',
      overdraftAllowed: true,
    });
    expect(view).toEqual({ balance: '0.0000', reserved: '0.0000', creditLimit: '250.0000', available: '250.0000' });
    expect(await accountsOf(clientId)).toEqual([
      { kind: 'client_hold', limit: '0.0000', balance: '0.0000' },
      { kind: 'client_wallet', limit: '250.0000', balance: '0.0000' },
    ]);
  });

  it('changes nothing when it runs again for the same merchant', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const clientId = await insertMerchant(db);
    await accounts.open(db, { clientId, currency: 'USD', creditLimit: '0.0000', overdraftAllowed: false });
    await accounts.open(db, { clientId, currency: 'USD', creditLimit: '0.0000', overdraftAllowed: false });
    expect(await accountsOf(clientId)).toHaveLength(2);
  });

  it('refuses credit on a group without overdraft (user rule 2) and a negative limit, writing nothing', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const clientId = await insertMerchant(db);
    for (const [creditLimit, code] of [
      ['10.0000', 'not_allowed'],
      ['-1.0000', 'min'],
    ] as const) {
      const error = await rejectionOf(
        accounts.open(db, { clientId, currency: 'USD', creditLimit, overdraftAllowed: false }),
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).errors).toEqual([expect.objectContaining({ field: 'creditLimit', code })]);
    }
    expect(await accountsOf(clientId)).toEqual([]);
  });
});
