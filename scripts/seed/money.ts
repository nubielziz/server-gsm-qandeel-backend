// Seeder of the money module: the demo currencies and the system ledger accounts of decision 024.
// Currencies mirror the frontend's settings mocks (src/features/settings/mocks/seedPayments.ts `currencyRows`).
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { type DemoSeed, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/** The base currency of the ledger (decision 011). */
export const BASE_CURRENCY = 'USD';

/** Display names the frontend mock gives the demo currencies. */
const CURRENCY_NAMES: Record<string, string> = {
  USD: 'US dollar',
  GBP: 'Pound sterling',
  EUR: 'Euro',
  SEK: 'Swedish krona',
  CAD: 'Canadian dollar',
  AED: 'UAE dirham',
  SAR: 'Saudi riyal',
};

/** A currency of the demo seed (`settings.currencies`). */
interface DemoCurrency {
  code: string;
  rate: number;
  markup: number;
  updated: number;
  shown: boolean;
  charm: boolean;
}

/** Account kinds that exist once per owner (merchant or supplier); every other kind is a system account. */
const PER_OWNER_KINDS = new Set<string>(['client_wallet', 'client_hold', 'supplier_prepaid']);

/**
 * Seeds the currencies and the system ledger accounts.
 *
 * Why: every ledger account references a currency, so the demo currencies come first. The 12 system accounts (the
 * map's 11 plus `owner_capital`, decision 024) must exist before the first posting; per-owner accounts are created
 * inside the transaction that first needs them, and opening balances are posted by the money feature, not seeded here.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 * @throws {Error} when the demo has no base currency
 */
export async function seedMoney(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const demoCurrencies = (demo.state.settings as { currencies?: DemoCurrency[] } | undefined)?.currencies ?? [];
  if (!demoCurrencies.some((currency) => currency.code === BASE_CURRENCY)) {
    throw new Error(`The demo state has no ${BASE_CURRENCY} currency, the base currency of the ledger.`);
  }
  const currencies = await insertRows(
    db,
    s.currencies,
    demoCurrencies.map((currency, index) => ({
      id: index + 1,
      code: currency.code,
      name: CURRENCY_NAMES[currency.code] ?? currency.code,
      rateToBase: currency.rate.toFixed(8),
      rateUpdatedAt: toDate(currency.updated)!,
      markupPercent: toMoney(currency.markup),
      charmRounding: currency.charm,
      isStorefront: currency.shown,
      decimals: 2,
      isActive: true,
      createdAt: toDate(currency.updated)!,
    })),
  );

  const accounts = await insertRows(
    db,
    s.ledgerAccounts,
    s.LEDGER_ACCOUNT_KINDS.filter((kind) => !PER_OWNER_KINDS.has(kind)).map((kind) => ({
      kind,
      currency: BASE_CURRENCY,
    })),
  );

  for (const table of [s.currencies, s.ledgerAccounts]) await syncIdentity(db, table);
  return [currencies, accounts];
}
