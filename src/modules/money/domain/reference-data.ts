// The money reference data a working system needs before its first posting: the base currency and the 12 system ledger
// accounts (decision 024). One definition for `bun run setup` (first run, P4b) and the development seed, so they cannot drift.
import { LEDGER_ACCOUNT_KINDS, type LedgerAccountKind } from '../db/schema';
import { BASE_CURRENCY } from './accounts';

/**
 * The account kinds that exist once per owner (merchant or supplier); every other kind is a system account.
 *
 * Why: decision 024: per-owner accounts are opened inside the transaction that first needs them, so setup and the seed create
 * only the system ones.
 */
export const PER_OWNER_ACCOUNT_KINDS: ReadonlySet<LedgerAccountKind> = new Set<LedgerAccountKind>([
  'client_wallet',
  'client_hold',
  'supplier_prepaid',
]);

/**
 * The 12 system ledger account kinds: the map's 11 plus `owner_capital` (decision 024).
 *
 * Why: every posting needs these accounts to exist; a fresh database has none until setup or the seed creates them.
 */
export const SYSTEM_LEDGER_ACCOUNT_KINDS: readonly LedgerAccountKind[] = LEDGER_ACCOUNT_KINDS.filter(
  (kind) => !PER_OWNER_ACCOUNT_KINDS.has(kind),
);

/**
 * The base currency as a `currencies` row, without the id and the dates.
 *
 * Why: decision 011 keeps the ledger in USD; every ledger account and every price refers to it. Rate 1, no markup, shown on
 * the storefront, two decimals: the values the demo gives USD and the console shows for the base currency (it cannot be
 * changed or switched off).
 */
export const BASE_CURRENCY_DEFINITION = {
  code: BASE_CURRENCY,
  name: 'US dollar',
  rateToBase: '1.00000000',
  markupPercent: '0.0000',
  charmRounding: false,
  isStorefront: true,
  decimals: 2,
  isActive: true,
} as const;

/**
 * The `ledger_accounts` rows of the system accounts (kind and currency; every other column takes its default: zero balance,
 * no overdraft, no owner).
 *
 * @returns one row per system account kind, in the order of {@link LEDGER_ACCOUNT_KINDS}
 */
export function systemLedgerAccountRows(): Array<{ kind: LedgerAccountKind; currency: string }> {
  return SYSTEM_LEDGER_ACCOUNT_KINDS.map((kind) => ({ kind, currency: BASE_CURRENCY }));
}
