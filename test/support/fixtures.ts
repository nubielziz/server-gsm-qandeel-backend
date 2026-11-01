// Minimal valid rows for database tests: just enough parents to satisfy the foreign keys and NOT NULL columns.
// Each helper inserts with the Drizzle schema, so a schema change that breaks a fixture shows up at type-check.
import { type Database, schema as s } from '../../src/infra/db';

/** Inserts USD (the base currency) when it is not there yet. */
export async function insertUsd(db: Database): Promise<void> {
  await db
    .insert(s.currencies)
    .values({ code: 'USD', name: 'US dollar', rateToBase: '1', decimals: 2 })
    .onConflictDoNothing();
}

/** Two ledger accounts in USD: a bank account (debit-normal) and a revenue account (credit-normal). */
export async function insertLedgerAccounts(db: Database): Promise<{ bank: number; revenue: number }> {
  await insertUsd(db);
  const rows = await db
    .insert(s.ledgerAccounts)
    .values([
      { kind: 'bank', currency: 'USD' },
      { kind: 'revenue', currency: 'USD' },
    ])
    .returning({ id: s.ledgerAccounts.id });
  return { bank: rows[0]!.id, revenue: rows[1]!.id };
}

/** A ledger transaction header with a fresh idempotency key; returns its id. */
export async function insertLedgerTransaction(
  db: Database,
  idempotencyKey = `test:${crypto.randomUUID()}`,
): Promise<number> {
  const [row] = await db
    .insert(s.ledgerTransactions)
    .values({ kind: 'deposit', refType: 'system', idempotencyKey, createdByType: 'system' })
    .returning({ id: s.ledgerTransactions.id });
  return row!.id;
}

/** The parents an order needs: a merchant (with its group), a service (with its category) and USD. */
export async function insertOrderParents(db: Database): Promise<{ clientId: number; serviceId: number }> {
  await insertUsd(db);
  const [group] = await db
    .insert(s.clientGroups)
    .values({ name: 'Standard', isDefault: true })
    .returning({ id: s.clientGroups.id });
  const [client] = await db
    .insert(s.clients)
    .values({
      username: 'merchant',
      email: 'merchant@example.com',
      name: 'Merchant',
      groupId: group!.id,
      referralCode: 'REF-1',
    })
    .returning({ id: s.clients.id });
  const [category] = await db
    .insert(s.serviceCategories)
    .values({ name: 'Apple', type: 'imei' })
    .returning({ id: s.serviceCategories.id });
  const [service] = await db
    .insert(s.services)
    .values({
      categoryId: category!.id,
      type: 'imei',
      name: 'iCloud check',
      fulfillment: 'auto',
      priceMode: 'fixed',
      basePrice: '10.0000',
      duplicateRule: 'allow',
      code: 'IMEI-ICL-CHK',
      slaMinutes: 120,
    })
    .returning({ id: s.services.id });
  return { clientId: client!.id, serviceId: service!.id };
}

/** Values every order needs besides its buyer and service. */
export const ORDER_DEFAULTS = {
  type: 'imei',
  source: 'dhru',
  unitPrice: '1.0000',
  totalPrice: '1.0000',
  currency: 'USD',
} as const;

/** A B2B order for the given merchant and service; returns its id. */
export async function insertOrder(db: Database, parents: { clientId: number; serviceId: number }): Promise<number> {
  const [row] = await db
    .insert(s.orders)
    .values({ ...ORDER_DEFAULTS, clientId: parents.clientId, serviceId: parents.serviceId })
    .returning({ id: s.orders.id });
  return row!.id;
}
