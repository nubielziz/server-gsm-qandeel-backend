// The seed runner: executes the module seeders in dependency order inside one transaction.
// Each Phase 3 feature adds its module's seeder to SEEDERS (mind foreign keys: parents first).
import type { AppConfig } from '../../src/config';
import type { Database } from '../../src/infra/db';
import { seedBilling } from './billing';
import { seedCatalog } from './catalog';
import { seedCommissions } from './commissions';
import { seedCustomers } from './customers';
import type { DemoSeed } from './demo-state';
import { seedGrowth } from './growth';
import { seedHealth } from './health';
import type { SeedReport } from './helpers';
import { seedIdentity } from './identity';
import { seedMoney } from './money';
import { seedOrders } from './orders';
import { seedPlatform } from './platform';
import { seedB2c } from './b2c';
import { seedRisk } from './risk';
import { seedStorefront } from './storefront';
import { seedSupport } from './support';
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
 * merchant groups), the customers (the currencies are money's), the suppliers with their links (they need the services), then
 * the orders, which need the merchants, the services, the suppliers and the ledger the others seed, then the commission plans,
 * assignments and accruals (they need the merchants and the orders), the supplier call log, whose rows point at orders, the
 * health checks and job runs (a supplier's check needs the supplier), and last the storefront (retail prices, listings, TAC
 * catalogue, content pages, help articles, legal documents), which needs the services and the retail group, after it the
 * storefront money (orders, payments, refunds and disputes of the customers), which needs the services, the gateways, the ledger
 * and the legal documents, then the support tickets and reply templates (they refer to staff, merchants, customers and orders the
 * others seed; a customer or an order that is not seeded leaves the ticket's requester or order link empty, never an error),
 * the growth pages (the demo's left checkouts with the guest customers of their emails and their marketing consent), which need
 * the currencies and the services (the customers seeder goes first, so an email both know keeps its row), and last the risk
 * rules, blocklist, IMEI checks and data requests (they need the customers, the TAC catalogue and the storefront orders).
 */
export const SEEDERS: readonly Seeder[] = [
  { module: 'identity', run: seedIdentity },
  { module: 'platform', run: seedPlatform },
  { module: 'money', run: seedMoney },
  { module: 'billing', run: seedBilling },
  { module: 'catalog', run: seedCatalog },
  { module: 'customers', run: seedCustomers },
  { module: 'suppliers', run: seedSuppliers },
  { module: 'orders', run: seedOrders },
  { module: 'commissions', run: seedCommissions },
  { module: 'supplier-logs', run: seedSupplierLogs },
  { module: 'health', run: seedHealth },
  { module: 'storefront', run: seedStorefront },
  { module: 'b2c', run: seedB2c },
  { module: 'support', run: seedSupport },
  { module: 'growth', run: seedGrowth },
  { module: 'risk', run: seedRisk },
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
