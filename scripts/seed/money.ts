// Seeder of the money module: the demo currencies, the system ledger accounts of decision 024, the wallets of the demo
// merchants and the demo's whole ledger history, replayed through postTransaction so the zero-sum and balance rules hold, and
// the demo's tax rates.
// Currencies mirror the frontend's settings mocks (src/features/settings/mocks/seedPayments.ts `currencyRows`); the journals
// are `journals` of the demo state (the console's mock ledger, src/mocks/ledger.ts).
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import {
  type LedgerLine,
  type PostTransactionInput,
  MerchantAccounts,
  creditLine,
  debitLine,
  postTransaction,
} from '../../src/modules/money';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
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

/** A tax rate of the demo seed (`settings.taxes`): country code and name, percent, scheme and start date. */
interface DemoTax {
  readonly cc: string;
  readonly name: string;
  readonly rate: number;
  readonly scheme: string;
  readonly since: number;
}

/**
 * The demo's tax rates as rows, mapped exactly as the frontend mock maps them (`taxRows` of
 * src/features/settings/mocks/seedPayments.ts): one open window per country from its `since` date.
 *
 * @param demo the demo state
 * @returns the rows, ids 1 to n in demo order
 */
function demoTaxRates(demo: DemoSeed) {
  const taxes = (demo.state.settings as { taxes?: DemoTax[] } | undefined)?.taxes ?? [];
  return taxes.map((tax, index) => ({
    id: index + 1,
    country: tax.cc,
    region: '',
    ratePercent: toMoney(tax.rate),
    taxType: tax.rate ? 'vat' : 'none',
    appliesTo: 'digital_services',
    validFrom: toDate(tax.since)!,
    validTo: null,
    label: tax.rate ? `${tax.name} VAT` : `${tax.name}: no tax collected`,
    ossScheme: tax.scheme === 'Not collected' ? '' : tax.scheme,
    createdAt: toDate(tax.since)!,
    updatedAt: toDate(tax.since)!,
  }));
}

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

  const opened = await openMerchantWallets(db, demo);
  const history = await replayJournals(db, demo, opened);
  // Tax rates come last so the reports above keep their order (the seed test reads them by position).
  const taxes = await insertRows(db, s.taxRates, demoTaxRates(demo));
  for (const table of [s.currencies, s.ledgerAccounts, s.ledgerTransactions, s.ledgerEntries, s.taxRates])
    await syncIdentity(db, table);
  return [currencies, { ...accounts, inserted: accounts.inserted + opened.created }, history, taxes];
}

/** A merchant of the demo state (`merchants`). */
interface DemoMerchant {
  id: string;
  credit: number;
}

/** A journal of the demo state (`journals`): the console's mock ledger. */
interface DemoJournal {
  id: string;
  ts: number;
  kind: string;
  memo: string;
  refType: string;
  refId: string;
  mid?: string | null;
  by: string;
  entries: Array<{ acct: string; mid?: string; sid?: string; dr?: number; cr?: number }>;
}

/** The demo merchants that exist in `clients`, with the credit limit their wallet is meant to end with. */
interface OpenedWallets {
  /** Merchant ids (numbers) present in `clients`. */
  readonly present: ReadonlySet<number>;
  /** The limit to leave on each wallet when the history is replayed. */
  readonly limits: ReadonlyMap<number, string>;
  /** Merchants of the demo that the identity seed has not created. */
  readonly missing: readonly string[];
  /** How many wallet and hold accounts were new. */
  readonly created: number;
}

async function countAccounts(db: DbExecutor): Promise<number> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(s.ledgerAccounts);
  return row?.total ?? 0;
}

/**
 * Opens the wallet and hold of every demo merchant that exists, through `MerchantAccounts.open`.
 *
 * Why: the merchants are seeded by the identity feature; the wallets are opened with them (resolution identity-platform-1),
 * with the credit limit the demo mocks show. A group that does not allow credit (user rule 2) keeps the limit at zero: the
 * demo's standard group has credit on paper, the rule is the server's.
 */
async function openMerchantWallets(db: DbExecutor, demo: DemoSeed): Promise<OpenedWallets> {
  const merchants = demoRows<DemoMerchant>(demo, 'merchants');
  const groups = await db
    .select({ id: s.clients.id, overdraftAllowed: s.clientGroups.overdraftAllowed })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId));
  const overdraft = new Map(groups.map((row) => [row.id, row.overdraftAllowed]));
  const accounts = new MerchantAccounts();
  const before = await countAccounts(db);
  const present = new Set<number>();
  const limits = new Map<number, string>();
  const missing: string[] = [];
  const refused: string[] = [];
  for (const merchant of merchants) {
    const clientId = demoNumericId(merchant.id);
    const allowed = overdraft.get(clientId);
    if (allowed === undefined) {
      missing.push(merchant.id);
      continue;
    }
    const creditLimit = allowed ? toMoney(merchant.credit) : '0.0000';
    if (!allowed && merchant.credit > 0) refused.push(merchant.id);
    await accounts.open(db, { clientId, currency: BASE_CURRENCY, creditLimit, overdraftAllowed: allowed });
    present.add(clientId);
    limits.set(clientId, creditLimit);
  }
  if (missing.length > 0) {
    console.log(
      `  money     skipped ${missing.length} demo merchants that are not in clients yet: ${missing.join(', ')}`,
    );
  }
  if (refused.length > 0) {
    console.log(
      `  money     credit limit left at 0 for ${refused.join(', ')}: their group does not allow credit (user rule 2)`,
    );
  }
  return { present, limits, missing, created: (await countAccounts(db)) - before };
}

/** The staff member behind a journal's author name, or `null` for the system. */
function authorOf(demo: DemoSeed): (by: string) => { type: 'staff' | 'system'; id: number | null } {
  const staffIds = new Map(
    demoRows<{ id: string; name: string }>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]),
  );
  return (by) => {
    const id = staffIds.get(by);
    return id === undefined ? { type: 'system', id: null } : { type: 'staff', id };
  };
}

/** The stored reference of a demo journal: `ORD-48100` is order 48100, `opening` and `gateway` have no record (0). */
function referenceOf(journal: DemoJournal): Pick<PostTransactionInput, 'refType' | 'refId'> {
  const digits = /(\d+)$/.exec(journal.refId);
  const refId = digits ? Number(digits[1]) : 0;
  switch (journal.refType) {
    case 'system':
      return { refType: 'system', refId: 0 };
    case 'withdrawal':
      // Withdrawals are a later phase (`withdrawal_requests`); until then the merchant is the record, as for an adjustment.
      return { refType: 'client', refId: journal.mid ? demoNumericId(journal.mid) : refId };
    case 'order':
    case 'payment':
    case 'accrual':
    case 'supplier':
      return { refType: journal.refType, refId };
    default:
      throw new Error(`Demo journal ${journal.id} has the unknown reference type "${journal.refType}".`);
  }
}

/** The lines of a demo journal; the demo writes `dr` and `cr` per entry and an owner as `mid` or `sid`. */
function linesOf(journal: DemoJournal): LedgerLine[] {
  return journal.entries.flatMap((entry) => {
    const account = {
      kind: entry.acct as LedgerLine['account']['kind'],
      ...(entry.mid ? { ownerType: 'client' as const, ownerId: demoNumericId(entry.mid) } : {}),
      ...(entry.sid ? { ownerType: 'supplier' as const, ownerId: demoNumericId(entry.sid) } : {}),
    };
    return [
      ...debitLine(account, Money.of(toMoney(entry.dr ?? 0))),
      ...creditLine(account, Money.of(toMoney(entry.cr ?? 0))),
    ];
  });
}

/**
 * Replays the demo's journals through `postTransaction`, in the order and at the time the demo recorded them.
 *
 * Why: seed = frontend mocks (decision 014): the console's Ledger, statements and order trails show the demo's history from
 * the real ledger. Each journal has the idempotency key `seed:<demo id>`, so running the seed again posts nothing. A journal
 * that names a merchant who is not in `clients` yet is skipped (one log line); the identity seed runs first and creates all
 * twenty. A fresh database numbers the journals as the demo does (`JRN-00025` is journal 25) when none is skipped. The demo's
 * wallets dip below the limits of the real groups, so the limits are lifted while the history is posted and set back after it
 * (a limit below the credit in use is allowed, user rule 2).
 */
async function replayJournals(db: DbExecutor, demo: DemoSeed, wallets: OpenedWallets): Promise<SeedReport> {
  const author = authorOf(demo);
  const walletOf = and(eq(s.ledgerAccounts.kind, 'client_wallet'), eq(s.ledgerAccounts.ownerType, 'client'));
  // Journals posted by an earlier run are known by their key: a repeat run touches nothing, not even the wallet limits.
  const done = new Set(
    (
      await db
        .select({ key: s.ledgerTransactions.idempotencyKey })
        .from(s.ledgerTransactions)
        .where(like(s.ledgerTransactions.idempotencyKey, 'seed:%'))
    ).map((row) => row.key),
  );
  let existing = 0;
  let skipped = 0;
  const pending: DemoJournal[] = [];
  for (const journal of demoRows<DemoJournal>(demo, 'journals')) {
    const owners = journal.entries.flatMap((entry) => (entry.mid ? [demoNumericId(entry.mid)] : []));
    if (owners.some((clientId) => !wallets.present.has(clientId))) skipped++;
    else if (done.has(`seed:${journal.id}`)) existing++;
    else pending.push(journal);
  }

  // The demo's wallets dip below the limits of the real groups: lift them while the history is posted, set them back after.
  const lifted = [...wallets.present];
  if (pending.length > 0 && lifted.length > 0) {
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '99999999999999.0000' })
      .where(and(walletOf, inArray(s.ledgerAccounts.ownerId, lifted)));
  }
  for (const journal of pending) {
    await postTransaction(
      db,
      {
        kind: journal.kind,
        ...referenceOf(journal),
        idempotencyKey: `seed:${journal.id}`,
        currency: BASE_CURRENCY,
        lines: linesOf(journal),
        memo: journal.memo,
        createdBy: author(journal.by),
      },
      // The demo keeps fractions of a millisecond; the database keeps whole ones.
      new Date(Math.round(journal.ts)),
    );
  }
  if (pending.length > 0) {
    for (const [clientId, limit] of wallets.limits) {
      await db
        .update(s.ledgerAccounts)
        .set({ overdraftLimit: limit })
        .where(and(walletOf, eq(s.ledgerAccounts.ownerId, clientId)));
    }
  }
  if (skipped > 0) console.log(`  money     skipped ${skipped} journals of merchants that are not in clients yet`);
  return { table: 'ledger_transactions', inserted: pending.length, existing };
}
