// The seed runner: executes the module seeders in dependency order inside one transaction.
// Each Phase 3 feature adds its module's seeder to SEEDERS (mind foreign keys: parents first).
import type { Database } from '../../src/infra/db';
import type { DemoSeed } from './demo-state';
import type { SeedReport } from './helpers';
import { seedIdentity } from './identity';
import { seedMoney } from './money';
import { seedPlatform } from './platform';

/** One module's seeder. */
export interface Seeder {
  readonly module: string;
  run(db: Parameters<Parameters<Database['transaction']>[0]>[0], demo: DemoSeed): Promise<SeedReport[]>;
}

/** The seeders, in the order they run: identity first (staff are referenced by almost everything), then platform, money. */
export const SEEDERS: readonly Seeder[] = [
  { module: 'identity', run: seedIdentity },
  { module: 'platform', run: seedPlatform },
  { module: 'money', run: seedMoney },
];

/**
 * Runs every seeder in one transaction: either the whole demo is there afterwards, or nothing changed.
 *
 * Why: the brief wants `db:seed` to be idempotent; rows that already exist are skipped, so a second run reports zero
 * inserts and leaves the database as it was.
 *
 * @param db the Drizzle database
 * @param demo the loaded frontend demo state
 * @returns the reports of all seeders, in order
 */
export async function runSeed(db: Database, demo: DemoSeed): Promise<Array<SeedReport & { module: string }>> {
  return db.transaction(async (tx) => {
    const reports: Array<SeedReport & { module: string }> = [];
    for (const seeder of SEEDERS) {
      for (const report of await seeder.run(tx, demo)) reports.push({ module: seeder.module, ...report });
    }
    return reports;
  });
}
