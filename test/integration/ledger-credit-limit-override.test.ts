// The one named exception to the credit limit guard of decision 024 (feature 11, user rule 5): `allowBelowCreditLimit` lets the reversal
// of a paid commission take the agent's wallet below its limit. Everything else is still refused; the option never lets a posting through
// that is unbalanced, never touches other accounts' rules, and is replay-safe like any posting.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { AppError } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import {
  type PostTransactionInput,
  adjust,
  commission,
  commissionReversal,
  order,
  postTransaction,
} from '../../src/modules/money';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, fundWallet, insertWalletMerchant, ledgerTotals } from '../support/money';
import { rejectionOf } from '../support/rejection';

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
  it('lets the reversal of a commission take the wallet below its credit limit (and below zero without any credit)', async () => {
    const { db } = await testDb();
    const agent = await insertWalletMerchant(db, { name: 'Zain' });
    await post(input(commission({ clientId: agent.id, amount: m('0.49') }), 1));
    // The agent spent it: the wallet is at zero and has no credit.
    await post(input(adjust({ clientId: agent.id, amount: m('0.49'), direction: 'debit' }), agent.id));

    const reversal = input(commissionReversal({ clientId: agent.id, amount: m('0.49') }), 1, {
      allowBelowCreditLimit: true,
    });
    const posted = await post(reversal);
    expect(posted.replayed).toBe(false);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: agent.id })).toMatchObject({
      balance: '-0.4900',
      overdraftLimit: '0.0000',
    });
    expect(await accountFigures(db, 'commission_expense')).toMatchObject({ balance: '0.0000' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('refuses the same debit without the option, with the usual INSUFFICIENT_FUNDS', async () => {
    const { db } = await testDb();
    const agent = await insertWalletMerchant(db);
    const error = await rejectionOf(post(input(commissionReversal({ clientId: agent.id, amount: m('0.49') }), 1)));
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
    const agent = await insertWalletMerchant(db);
    const reversal = input(commissionReversal({ clientId: agent.id, amount: m('1') }), 1, {
      allowBelowCreditLimit: true,
    });
    const first = await post(reversal);
    const again = await post(reversal);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect((await ledgerTotals(db)).transactions).toBe(1);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: agent.id })).toMatchObject({
      balance: '-1.0000',
    });

    const unbalanced = await rejectionOf(
      post(
        input(
          {
            kind: 'adjustment',
            refType: 'client',
            lines: commissionReversal({ clientId: agent.id, amount: m('1') }).lines.slice(0, 1),
          },
          agent.id,
          { allowBelowCreditLimit: true },
        ),
      ),
    );
    expect((unbalanced as AppError).code).toBe('LEDGER_UNBALANCED');
  });
});
