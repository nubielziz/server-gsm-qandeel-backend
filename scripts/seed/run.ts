// The seed runner: executes the module seeders in dependency order inside one transaction.
// Each Phase 3 feature adds its module's seeder to SEEDERS (mind foreign keys: parents first).
import type { AppConfig } from '../../src/config';
import type { Database } from '../../src/infra/db';
import { seedBilling } from './billing';
import { seedCatalog } from './catalog';
import type { DemoSeed } from './demo-state';
import type { SeedReport } from './helpers';
import { seedIdentity } from './identity';
import { seedMoney } from './money';
import { seedOrders } from './orders';
import { seedPlatform } from './platform';
import { seedSupplierLogs, seedSuppliers } from './suppliers';

/** One module's seeder. */
export interface Seeder {
  readonly module: string;
  run(
    db: Parameters<Parameters<Database['transaction']>[0]>[0],
    demo: DemoSeed,
    config?: AppConfig,
  ): Promise<SeedReport[]>;
}

/**
 * The seeders, in the order they run: identity first (staff are referenced by almost everything), then platform, money, billing
 * (gateways, top-ups and invoices: after the money seed, whose deposit journals they link to) and catalog (which needs the
 * merchant groups), the suppliers with their links (they need the services), then the orders, which need the merchants, the
 * services, the suppliers and the ledger the others seed, and last the supplier call log, whose rows point at orders.
 */
export const SEEDERS: readonly Seeder[] = [
  { module: 'identity', run: seedIdentity },
  { module: 'platform', run: seedPlatform },
  { module: 'money', run: seedMoney },
  { module: 'billing', run: seedBilling },
  { module: 'catalog', run: seedCatalog },
  { module: 'suppliers', run: seedSuppliers },
  { module: 'orders', run: seedOrders },
  { module: 'supplier-logs', run: seedSupplierLogs },
];

/**
 * Runs every seeder in one transaction: either the whole demo is there afterwards, or nothing changed.
 *
 * Why: the brief wants `db:seed` to be idempotent; rows that already exist are skipped, so a second run reports zero
 * inserts and leaves the database as it was.
 *
 * @param db the Drizzle database
 * @param demo the loaded frontend demo state
 * @param config the application configuration; the catalog seeder needs it for the encrypted inventory codes and leaves them out without it
 * @returns the reports of all seeders, in order
 */
export async function runSeed(
  db: Database,
  demo: DemoSeed,
  config?: AppConfig,
): Promise<Array<SeedReport & { module: string }>> {
  return db.transaction(async (tx) => {
    const reports: Array<SeedReport & { module: string }> = [];
    for (const seeder of SEEDERS) {
      for (const report of await seeder.run(tx, demo, config)) reports.push({ module: seeder.module, ...report });
    }
    return reports;
  });
}
