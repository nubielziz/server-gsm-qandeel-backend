// The base currency and the system ledger accounts as a database holds them, with everything that legitimately differs between a seeded
// and a first-run database left out (ids, dates, balances, versions). Run as a script, it seeds the demo into the test database
// and prints these rows as JSON: the first-run test compares them with the first run's, from a separate process (see that test).
import { eq, isNull } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import type { Database } from '../../src/infra/db';
import { testDb } from './db';

/**
 * Reads the USD row and the 12 system accounts without the fields that differ by design.
 *
 * Why: the demo seed keeps the demo's ids and replays the demo's ledger history; `bun run setup` starts from zero. What must be
 * the same is the definition: code, rate, markup, decimals; kind, currency, owner and overdraft limit of each system account.
 *
 * @param db the test database
 * @returns the rows, accounts sorted by kind
 */
export async function referenceRows(db: Database) {
  return {
    currencies: (await db.select().from(s.currencies).where(eq(s.currencies.code, 'USD'))).map(
      ({ id: _id, rateUpdatedAt: _updated, createdAt: _created, updatedAt: _changed, ...rest }) => rest,
    ),
    accounts: (await db.select().from(s.ledgerAccounts).where(isNull(s.ledgerAccounts.ownerType)))
      .map(({ kind, currency, ownerType, ownerId, overdraftLimit }) => ({
        kind,
        currency,
        ownerType,
        ownerId,
        overdraftLimit,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}

if (import.meta.main) {
  // Loaded only here: the test that imports `referenceRows` should not load the seed code.
  const { loadDemoState } = await import('../../scripts/seed/demo-state');
  const { runSeed } = await import('../../scripts/seed/run');
  const { db, pool } = await testDb();
  try {
    await runSeed(db, await loadDemoState());
    console.log(JSON.stringify(await referenceRows(db)));
  } finally {
    await pool.end();
  }
}
