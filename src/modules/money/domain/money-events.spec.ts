// Unit tests of the 13 money events (decision 024): every builder is compared with the map's own journal lines and amounts
// (docs/slices/money.json, generated from reference/gsm-map system.mjs), and each posting sums to zero.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Money } from '../../../common/money';
import { assertBalanced } from './ledger-lines';
import * as events from './money-events';
import { MONEY_EVENT_IDS, MONEY_EVENT_KINDS, type MoneyEventId, type MoneyEventPosting } from './money-events';

interface MapEvent {
  id: string;
  /** `[account, debit, credit]` triples exactly as the map writes them. */
  entry: Array<[string, number, number]>;
}

const slice = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../docs/slices/money.json'), 'utf8')) as {
  moneyEvents: MapEvent[];
};
const mapEvent = (id: string): MapEvent => slice.moneyEvents.find((event) => event.id === id)!;

const m = (amount: string): Money => Money.of(amount);

/** The posting as the map's `[account, debit, credit]` triples (amounts as numbers, as the map writes them). */
function triples(posting: MoneyEventPosting): Array<[string, number, number]> {
  return posting.lines.map((line) => [line.account.kind, Number(line.debit.toWire()), Number(line.credit.toWire())]);
}

/** Each builder with the map's example amounts (system.mjs: 100 + 3 fee, 5 with cost 3, ...). */
const BUILT: Record<MoneyEventId, MoneyEventPosting> = {
  deposit: events.deposit({ clientId: 7, amount: m('100'), fee: m('3') }),
  order: events.order({ clientId: 7, amount: m('5') }),
  complete: events.complete({ clientId: 7, price: m('5'), cost: m('3'), supplierId: 2 }),
  reject: events.reject({ clientId: 7, amount: m('5') }),
  topup: events.topup({ supplierId: 2, amount: m('50') }),
  commission: events.commission({ clientId: 7, amount: m('0.20') }),
  adjust: events.adjust({ clientId: 7, amount: m('10'), direction: 'credit' }),
  b2c_pay: events.b2cPay({ net: m('12.49'), vat: m('2.50') }),
  b2c_fee: events.b2cFee({ fee: m('0.73') }),
  b2c_deliver: events.b2cDeliver({ net: m('12.49'), cost: m('7.20'), supplierId: 2 }),
  b2c_refund: events.b2cRefund({ net: m('12.49'), vat: m('2.50') }),
  b2c_chargeback: events.b2cChargeback({ amount: m('14.99'), fee: m('15') }),
  payout: events.payout({ amount: m('14.26') }),
};

describe('the 13 money events of the map', () => {
  it('has a builder for every event of the map and no other', () => {
    expect<string[]>([...MONEY_EVENT_IDS].sort()).toEqual(slice.moneyEvents.map((event) => event.id).sort());
    expect(Object.keys(BUILT).sort()).toEqual([...MONEY_EVENT_IDS].sort());
  });

  for (const id of MONEY_EVENT_IDS) {
    it(`${id}: the lines are the map's journal lines, in the map's order`, () => {
      expect(triples(BUILT[id])).toEqual(mapEvent(id).entry);
    });

    it(`${id}: debits equal credits and the posting passes the writer's checks`, () => {
      expect(() => assertBalanced(BUILT[id].lines, 'USD')).not.toThrow();
      const debits = Money.sum(BUILT[id].lines.map((line) => line.debit));
      const credits = Money.sum(BUILT[id].lines.map((line) => line.credit));
      expect(debits.eq(credits)).toBe(true);
      expect(BUILT[id].event).toBe(id);
      expect(BUILT[id].kind).toBe(MONEY_EVENT_KINDS[id]);
    });
  }

  it('puts each line on the right owner: merchant accounts by client, supplier prepaid by supplier, the rest system', () => {
    const accounts = (id: MoneyEventId) => BUILT[id].lines.map((line) => line.account);
    expect(accounts('deposit')).toContainEqual({ kind: 'client_wallet', ownerType: 'client', ownerId: 7 });
    expect(accounts('order')).toContainEqual({ kind: 'client_hold', ownerType: 'client', ownerId: 7 });
    expect(accounts('complete')).toContainEqual({ kind: 'supplier_prepaid', ownerType: 'supplier', ownerId: 2 });
    expect(accounts('topup')).toContainEqual({ kind: 'supplier_prepaid', ownerType: 'supplier', ownerId: 2 });
    expect(accounts('payout')).toEqual([{ kind: 'bank' }, { kind: 'gateway_clearing' }]);
  });

  it('posts under the reference type of its record: B2C events on the order, never the payment', () => {
    const refTypes = Object.fromEntries(MONEY_EVENT_IDS.map((id) => [id, BUILT[id].refType]));
    expect(refTypes).toEqual({
      deposit: 'payment',
      order: 'order',
      complete: 'order',
      reject: 'order',
      topup: 'supplier',
      commission: 'accrual',
      adjust: 'client',
      b2c_pay: 'order',
      b2c_fee: 'order',
      b2c_deliver: 'order',
      b2c_refund: 'order',
      b2c_chargeback: 'order',
      payout: 'system',
    });
  });

  it('uses the console vocabulary for the ledger kind', () => {
    expect(MONEY_EVENT_KINDS).toEqual({
      deposit: 'deposit',
      order: 'order_hold',
      complete: 'order_settle',
      reject: 'order_release',
      topup: 'supplier_topup',
      commission: 'commission',
      adjust: 'adjustment',
      b2c_pay: 'b2c_payment',
      b2c_fee: 'gateway_fee',
      b2c_deliver: 'order_settle',
      b2c_refund: 'refund',
      b2c_chargeback: 'chargeback',
      payout: 'settlement',
    });
  });
});

describe('deposit', () => {
  it('drops the fee line when there is no fee', () => {
    const posting = events.deposit({ clientId: 7, amount: m('100') });
    expect(triples(posting)).toEqual([
      ['gateway_clearing', 100, 0],
      ['client_wallet', 0, 100],
    ]);
  });

  it('debits the bank for a manual gateway (user rule 4)', () => {
    const posting = events.deposit({ clientId: 7, amount: m('100'), fee: m('3'), from: 'bank' });
    expect(triples(posting)).toEqual([
      ['bank', 103, 0],
      ['client_wallet', 0, 100],
      ['fee_income', 0, 3],
    ]);
  });
});

describe('complete and b2c_deliver', () => {
  it('drop the cost lines when the order has no supplier cost', () => {
    expect(triples(events.complete({ clientId: 7, price: m('5') }))).toEqual([
      ['client_hold', 5, 0],
      ['revenue', 0, 5],
    ]);
    expect(triples(events.b2cDeliver({ net: m('12.49') }))).toEqual([
      ['customer_funds', 12.49, 0],
      ['revenue', 0, 12.49],
    ]);
  });

  it('refuse a cost without the supplier it is booked against', () => {
    expect(() => events.complete({ clientId: 7, price: m('5'), cost: m('3') })).toThrow(RangeError);
    expect(() => events.b2cDeliver({ net: m('5'), cost: m('3') })).toThrow(RangeError);
  });

  it('book the profit as price minus cost without rounding drift', () => {
    const posting = events.complete({ clientId: 7, price: m('3.31'), cost: m('2.40'), supplierId: 5 });
    const revenue = posting.lines.find((line) => line.account.kind === 'revenue')!;
    const cogs = posting.lines.find((line) => line.account.kind === 'cogs')!;
    expect(revenue.credit.sub(cogs.debit).toWire()).toBe('0.9100');
  });
});

describe('adjust', () => {
  it('writes the debit as the exact mirror of the credit', () => {
    const credit = events.adjust({ clientId: 7, amount: m('10'), direction: 'credit' });
    const debit = events.adjust({ clientId: 7, amount: m('10'), direction: 'debit' });
    expect(triples(debit)).toEqual([
      ['client_wallet', 10, 0],
      ['adjustments', 0, 10],
    ]);
    expect(debit.lines.map((line) => [line.account, line.credit.toWire(), line.debit.toWire()])).toEqual(
      credit.lines.map((line) => [line.account, line.debit.toWire(), line.credit.toWire()]).reverse(),
    );
  });
});

describe('amounts', () => {
  it('refuse a negative amount and post nothing for zero', () => {
    expect(() => events.order({ clientId: 7, amount: m('-1') })).toThrow(RangeError);
    expect(events.order({ clientId: 7, amount: m('0') }).lines).toEqual([]);
    expect(() => assertBalanced(events.order({ clientId: 7, amount: m('0') }).lines, 'USD')).toThrow();
  });
});
