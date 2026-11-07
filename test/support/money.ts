// Helpers for the money tests (feature 3): merchants with opened wallets, postings through the real ledger writer, and reads
// of the ledger tables to assert on. Everything goes through public code (MerchantAccounts, postTransaction), never raw ledger inserts.
import { and, eq, sql } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { type Database, schema as s } from '../../src/infra/db';
import { MerchantAccounts, deposit, postTransaction } from '../../src/modules/money';
import { insertMerchant } from './auth';
import { insertUsd } from './fixtures';

/** A merchant with an opened wallet and hold. */
export interface TestMerchant {
  readonly id: number;
  readonly name: string;
}

/**
 * Creates a merchant in a group that allows credit (or not) and opens its wallet and hold with a credit limit.
 *
 * @param db the test database
 * @param options the display name and the credit limit (default none)
 * @returns the merchant
 */
export async function insertWalletMerchant(
  db: Database,
  options: { name?: string; creditLimit?: string; overdraftAllowed?: boolean } = {},
): Promise<TestMerchant> {
  await insertUsd(db);
  const name = options.name ?? 'Test Merchant';
  const creditLimit = Money.of(options.creditLimit ?? '0').toWire();
  const [group] = await db
    .insert(s.clientGroups)
    .values({
      name: `Group ${crypto.randomUUID()}`,
      overdraftAllowed: options.overdraftAllowed ?? Money.of(creditLimit).isPositive(),
    })
    .returning({ id: s.clientGroups.id });
  const id = await insertMerchant(db, { name, groupId: group!.id });
  await new MerchantAccounts().open(db, {
    clientId: id,
    currency: 'USD',
    creditLimit,
    overdraftAllowed: Money.of(creditLimit).isPositive() || (options.overdraftAllowed ?? false),
  });
  return { id, name };
}

/**
 * Credits a merchant wallet through the `deposit` money event.
 *
 * @param db the test database
 * @param clientId the merchant
 * @param amount the wallet credit, e.g. `'100'`
 * @param key an idempotency key (default unique)
 * @returns the ledger transaction id
 */
export async function fundWallet(db: Database, clientId: number, amount: string, key = `fund:${crypto.randomUUID()}`) {
  const posted = await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...deposit({ clientId, amount: Money.of(amount) }),
        refId: 1,
        idempotencyKey: key,
        currency: 'USD',
        createdBy: { type: 'system', id: null },
      },
      new Date(),
    ),
  );
  return posted.id;
}

/** The stored figures of one account (normal sign). */
export async function accountFigures(
  db: Database,
  kind: string,
  owner?: { type: 'client' | 'supplier'; id: number },
): Promise<{ balance: string; overdraftLimit: string; version: number } | undefined> {
  const [row] = await db
    .select({
      balance: s.ledgerAccounts.balance,
      overdraftLimit: s.ledgerAccounts.overdraftLimit,
      version: s.ledgerAccounts.version,
    })
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.kind, kind as never),
        owner ? eq(s.ledgerAccounts.ownerType, owner.type) : sql`${s.ledgerAccounts.ownerType} is null`,
        owner ? eq(s.ledgerAccounts.ownerId, owner.id) : sql`${s.ledgerAccounts.ownerId} is null`,
      ),
    );
  return row;
}

/** The sum of every ledger entry (must be zero) and how many entries and transactions exist. */
export async function ledgerTotals(db: Database): Promise<{ sum: string; entries: number; transactions: number }> {
  const [row] = await db
    .execute<{ sum: string; entries: number; transactions: number }>(
      sql`select coalesce((select sum(amount) from ledger_entries), 0)::numeric(18,4)::text as sum,
               (select count(*) from ledger_entries)::int as entries,
               (select count(*) from ledger_transactions)::int as transactions`,
    )
    .then((result) => result.rows);
  return row!;
}
