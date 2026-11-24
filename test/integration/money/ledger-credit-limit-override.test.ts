// The one named exception to the credit limit guard of decision 024: `allowBelowCreditLimit` lets the top-up chargeback clawback take a
// merchant's wallet below its limit (the merchant spent the disputed top-up). Everything else is still refused; the option never lets a
// posting through that is unbalanced, never touches other accounts' rules, and is replay-safe like any posting. The posting used here is a
// hand debit of the wallet (the `adjust` event), which has the same lines as the clawback's wallet side.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { Money } from '@src/common/money';
import { type PostTransactionInput, adjust, order, postTransaction } from '@src/modules/money';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { accountFigures, fundWallet, insertWalletMerchant, ledgerTotals } from '../../support/money';
import { rejectionOf } from '../../support/rejection';

beforeEach(resetDb);
afterAll(closeTestDb);

const m = (amount: string) => Money.of(amount);
let counter = 0;
const input = (
  posting: { kind: string; refType: PostTransactionInput['refType']; lines: PostTransactionInput['lines'] },
  refId = 1,
  extra: Partial<PostTransactionInput> = {},
): PostTransactionInput => ({
  kind: posting.kind,
  refType: posting.refType,
  lines: posting.lines,
  refId,
  idempotencyKey: `t:${++counter}`,
  currency: 'USD',
  createdBy: { type: 'system', id: null },
  ...extra,
});

async function post(posting: PostTransactionInput) {
  const { db } = await testDb();
  return db.transaction((tx) => postTransaction(tx, posting, new Date()));
}

describe('allowBelowCreditLimit', () => {
  it('lets a debit take the wallet below its credit limit (and below zero without any credit)', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    await fundWallet(db, merchant.id, '0.49');
    // The merchant spent it: the wallet is at zero and has no credit.
    await post(input(adjust({ clientId: merchant.id, amount: m('0.49'), direction: 'debit' }), merchant.id));

    const clawback = input(adjust({ clientId: merchant.id, amount: m('0.49'), direction: 'debit' }), merchant.id, {
      allowBelowCreditLimit: true,
    });
    const posted = await post(clawback);
    expect(posted.replayed).toBe(false);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-0.4900',
      overdraftLimit: '0.0000',
    });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('refuses the same debit without the option, with the usual INSUFFICIENT_FUNDS', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const error = await rejectionOf(
      post(input(adjust({ clientId: merchant.id, amount: m('0.49'), direction: 'debit' }), merchant.id)),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    expect((error as AppError).detail).toBe('The wallet would end at -0.4900, below its credit limit of 0.0000.');
    expect((await ledgerTotals(db)).transactions).toBe(0);
  });

  it('is off unless it is exactly true: an ordinary order hold is refused as before', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '5');
    const error = await rejectionOf(post(input(order({ clientId: merchant.id, amount: m('5.01') }), 9, {})));
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    const explicitFalse = await rejectionOf(
      post(input(order({ clientId: merchant.id, amount: m('5.01') }), 9, { allowBelowCreditLimit: false })),
    );
    expect((explicitFalse as AppError).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('still replays an idempotency key and still refuses an unbalanced posting', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const clawback = input(adjust({ clientId: merchant.id, amount: m('1'), direction: 'debit' }), merchant.id, {
      allowBelowCreditLimit: true,
    });
    const first = await post(clawback);
    const again = await post(clawback);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect((await ledgerTotals(db)).transactions).toBe(1);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-1.0000',
    });

    const unbalanced = await rejectionOf(
      post(
        input(
          {
            kind: 'adjustment',
            refType: 'client',
            lines: adjust({ clientId: merchant.id, amount: m('1'), direction: 'debit' }).lines.slice(0, 1),
          },
          merchant.id,
          { allowBelowCreditLimit: true },
        ),
      ),
    );
    expect((unbalanced as AppError).code).toBe('LEDGER_UNBALANCED');
  });
});
