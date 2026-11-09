// Unit tests of the shared money reference data (decision 024): the 12 system accounts and the base currency row.
import { describe, expect, it } from 'bun:test';
import type { LedgerAccountKind } from '../db/schema';
import { BASE_CURRENCY } from './accounts';
import {
  BASE_CURRENCY_DEFINITION,
  PER_OWNER_ACCOUNT_KINDS,
  SYSTEM_LEDGER_ACCOUNT_KINDS,
  systemLedgerAccountRows,
} from './reference-data';

describe('the system ledger accounts', () => {
  it("are the map's 11 plus owner_capital, none of them per owner", () => {
    const expected: LedgerAccountKind[] = [
      'adjustments',
      'bank',
      'chargeback_loss',
      'cogs',
      'commission_expense',
      'customer_funds',
      'fee_income',
      'gateway_clearing',
      'gateway_fees',
      'owner_capital',
      'revenue',
      'vat_payable',
    ];
    expect([...SYSTEM_LEDGER_ACCOUNT_KINDS].sort()).toEqual(expected);
    expect(SYSTEM_LEDGER_ACCOUNT_KINDS).toHaveLength(12);
    for (const kind of PER_OWNER_ACCOUNT_KINDS) expect(SYSTEM_LEDGER_ACCOUNT_KINDS).not.toContain(kind);
  });

  it('become one USD row each', () => {
    const rows = systemLedgerAccountRows();
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.currency === BASE_CURRENCY)).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual([...SYSTEM_LEDGER_ACCOUNT_KINDS]);
  });
});

describe('the base currency row', () => {
  it('is USD at rate 1 with no markup, active, shown on the storefront', () => {
    expect(BASE_CURRENCY_DEFINITION).toEqual({
      code: 'USD',
      name: 'US dollar',
      rateToBase: '1.00000000',
      markupPercent: '0.0000',
      charmRounding: false,
      isStorefront: true,
      decimals: 2,
      isActive: true,
    });
  });
});
