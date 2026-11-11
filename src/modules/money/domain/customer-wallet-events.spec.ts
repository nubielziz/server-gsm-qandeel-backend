// Unit tests of the customer wallet money events (feature 21, plan § 5.4 and § 11.1): exact lines with the plan's numbers, balanced,
// the right owners, zero lines dropped, and the pro-rata clawback split.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  WALLET_EVENT_IDS,
  WALLET_EVENT_KINDS,
  b2cWalletPay,
  b2cWalletRefund,
  clawbackSplit,
  customerAdjust,
  customerTopup,
  topupChargeback,
  type WalletEventPosting,
} from './customer-wallet-events';
import { assertBalanced } from './ledger-lines';

const m = (amount: string) => Money.of(amount);

/** The lines as `[kind, owner, debit, credit]` rows, easy to compare. */
function rows(posting: WalletEventPosting): Array<[string, string, string, string]> {
  for (const line of posting.lines) expect(line.debit.isPositive() !== line.credit.isPositive()).toBe(true);
  assertBalanced(posting.lines, 'USD');
  return posting.lines.map((line) => [
    line.account.kind,
    line.account.ownerType ? `${line.account.ownerType}:${line.account.ownerId}` : '',
    line.debit.toWire(),
    line.credit.toWire(),
  ]);
}

describe('wallet event ids and kinds', () => {
  it('give each of the five events a console kind', () => {
    expect([...WALLET_EVENT_IDS]).toEqual([
      'customer_topup',
      'b2c_wallet_pay',
      'b2c_wallet_refund',
      'customer_adjust',
      'topup_chargeback',
    ]);
    expect(Object.values(WALLET_EVENT_KINDS)).toEqual(['deposit', 'b2c_payment', 'refund', 'adjustment', 'chargeback']);
  });
});

describe('customerTopup', () => {
  it('credits the net to the customer wallet and the fee to income, from bank (manual gateway)', () => {
    const posting = customerTopup({ customerId: 7, amount: m('48.50'), fee: m('1.50'), from: 'bank' });
    expect(posting).toMatchObject({ kind: 'deposit', refType: 'payment' });
    expect(rows(posting)).toEqual([
      ['bank', '', '50.0000', '0.0000'],
      ['customer_wallet', 'customer:7', '0.0000', '48.5000'],
      ['fee_income', '', '0.0000', '1.5000'],
    ]);
  });

  it('debits gateway_clearing for an automatic gateway and drops a zero fee', () => {
    expect(
      rows(customerTopup({ customerId: 7, amount: m('48.50'), fee: m('1.50'), from: 'gateway_clearing' }))[0],
    ).toEqual(['gateway_clearing', '', '50.0000', '0.0000']);
    expect(rows(customerTopup({ customerId: 7, amount: m('20'), from: 'bank' }))).toHaveLength(2);
  });
});

describe('b2cWalletPay', () => {
  it('moves net + VAT from the wallet to customer funds and VAT payable', () => {
    const posting = b2cWalletPay({ customerId: 3, net: m('12.49'), vat: m('2.50') });
    expect(posting).toMatchObject({ kind: 'b2c_payment', refType: 'order' });
    expect(rows(posting)).toEqual([
      ['customer_wallet', 'customer:3', '14.9900', '0.0000'],
      ['customer_funds', '', '0.0000', '12.4900'],
      ['vat_payable', '', '0.0000', '2.5000'],
    ]);
  });

  it('drops the VAT line when there is no VAT', () => {
    expect(rows(b2cWalletPay({ customerId: 3, net: m('10'), vat: m('0') }))).toHaveLength(2);
  });
});

describe('b2cWalletRefund', () => {
  it('returns the money from customer funds before delivery', () => {
    const posting = b2cWalletRefund({ customerId: 3, net: m('12.49'), vat: m('2.50') });
    expect(posting).toMatchObject({ kind: 'refund', refType: 'order' });
    expect(rows(posting)).toEqual([
      ['customer_funds', '', '12.4900', '0.0000'],
      ['vat_payable', '', '2.5000', '0.0000'],
      ['customer_wallet', 'customer:3', '0.0000', '14.9900'],
    ]);
  });

  it('returns the net from revenue after delivery', () => {
    expect(rows(b2cWalletRefund({ customerId: 3, net: m('12.49'), vat: m('2.50'), from: 'revenue' }))[0]).toEqual([
      'revenue',
      '',
      '12.4900',
      '0.0000',
    ]);
  });
});

describe('customerAdjust', () => {
  it('credits from adjustments with the stored reference type customer', () => {
    const posting = customerAdjust({ customerId: 9, amount: m('10'), direction: 'credit' });
    expect(posting).toMatchObject({ kind: 'adjustment', refType: 'customer' });
    expect(rows(posting)).toEqual([
      ['adjustments', '', '10.0000', '0.0000'],
      ['customer_wallet', 'customer:9', '0.0000', '10.0000'],
    ]);
  });

  it('debits as the exact mirror', () => {
    expect(rows(customerAdjust({ customerId: 9, amount: m('10'), direction: 'debit' }))).toEqual([
      ['customer_wallet', 'customer:9', '10.0000', '0.0000'],
      ['adjustments', '', '0.0000', '10.0000'],
    ]);
  });
});

describe('topupChargeback', () => {
  it('claws back the credited amount, reverses the fee and books the dispute fee (gross 50, fee 1.50, dispute fee 15)', () => {
    const split = clawbackSplit({ gross: m('50'), fee: m('1.50'), disputed: m('50') });
    const posting = topupChargeback({ owner: { type: 'customer', id: 4 }, ...split, disputeFee: m('15') });
    expect(posting).toMatchObject({ kind: 'chargeback', refType: 'dispute' });
    expect(rows(posting)).toEqual([
      ['customer_wallet', 'customer:4', '48.5000', '0.0000'],
      ['fee_income', '', '1.5000', '0.0000'],
      ['chargeback_loss', '', '15.0000', '0.0000'],
      ['gateway_clearing', '', '0.0000', '65.0000'],
    ]);
  });

  it('debits the merchant wallet for a merchant top-up', () => {
    const posting = topupChargeback({
      owner: { type: 'client', id: 11 },
      net: m('97'),
      fee: m('3'),
      disputeFee: m('0'),
    });
    expect(rows(posting)).toEqual([
      ['client_wallet', 'client:11', '97.0000', '0.0000'],
      ['fee_income', '', '3.0000', '0.0000'],
      ['gateway_clearing', '', '0.0000', '100.0000'],
    ]);
  });
});

describe('clawbackSplit', () => {
  it('takes the whole fee when the whole top-up is disputed, so the wallet returns exactly what it got', () => {
    expect(clawbackSplit({ gross: m('50'), fee: m('1.50'), disputed: m('50') })).toEqual({
      net: m('48.50'),
      fee: m('1.50'),
    });
  });

  it('splits a partial dispute pro rata, rounded to four places', () => {
    const split = clawbackSplit({ gross: m('30'), fee: m('1'), disputed: m('10') });
    expect(split.fee.toWire()).toBe('0.3333');
    expect(split.net.toWire()).toBe('9.6667');
    expect(split.net.add(split.fee).toWire()).toBe('10.0000');
  });

  it('never claws back more than the top-up, and refuses a bad gross or a negative dispute', () => {
    expect(clawbackSplit({ gross: m('50'), fee: m('1.50'), disputed: m('80') }).net.toWire()).toBe('48.5000');
    expect(() => clawbackSplit({ gross: m('0'), fee: m('0'), disputed: m('1') })).toThrow(RangeError);
    expect(() => clawbackSplit({ gross: m('5'), fee: m('0'), disputed: m('-1') })).toThrow(RangeError);
  });
});
