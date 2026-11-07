// Helpers for the pricing tests (feature 4b): the demo's merchant groups, a service with the demo's AT&T numbers, and direct
// inserts of group prices, client prices and pricing rules.
import { CacheKeys } from '../../src/infra/cache';
import { type Database, schema as s } from '../../src/infra/db';
import { CatalogPriceVersion } from '../../src/modules/catalog';
import type { TestApp } from './app';
import { insertMerchant } from './auth';
import { insertCategory, insertService } from './catalog';

/** The demo's four groups: Standard (default, no discount), Wholesale (4 %), VIP (8 %) and the storefront retail group. */
export async function insertDemoGroups(db: Database) {
  const [standard, wholesale, vip, retail] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, discountPercent: '0', sort: 1 },
      { name: 'Wholesale', discountPercent: '4', sort: 2 },
      { name: 'VIP', discountPercent: '8', sort: 3 },
      { name: 'Storefront retail', kind: 'b2c_retail', sort: 4 },
    ])
    .returning({ id: s.clientGroups.id });
  return { standard: standard!.id, wholesale: wholesale!.id, vip: vip!.id, retail: retail!.id };
}

/** The demo's AT&T unlock: cost 13.50, price 17.28, own minimum profit 0.81 (floor 14.31), in a new Carrier unlock category. */
export async function insertAtt(db: Database, values: Partial<typeof s.services.$inferInsert> = {}) {
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  const serviceId = await insertService(db, categoryId, {
    name: 'AT&T USA Premier Unlock',
    code: 'IMEI-ATT-USA',
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    slaMinutes: 1440,
    ...values,
  });
  return { categoryId, serviceId };
}

/** Inserts a fixed group price. */
export async function insertGroupPrice(db: Database, serviceId: number, groupId: number, price: string) {
  await db.insert(s.serviceGroupPrices).values({ serviceId, groupId, price });
}

/** Inserts a client price and returns its id. */
export async function insertClientPriceRow(
  db: Database,
  serviceId: number,
  clientId: number,
  price: string,
  note = '',
): Promise<number> {
  const [row] = await db
    .insert(s.serviceClientPrices)
    .values({ serviceId, clientId, price, note })
    .returning({ id: s.serviceClientPrices.id });
  return row!.id;
}

/** Inserts a pricing rule (a 2 % discount on a category by default) and returns its id. */
export async function insertRule(
  db: Database,
  values: Partial<typeof s.pricingRules.$inferInsert> & Pick<typeof s.pricingRules.$inferInsert, 'scope'>,
): Promise<number> {
  const [row] = await db
    .insert(s.pricingRules)
    .values({ kind: 'discount', percent: '2', ...values })
    .returning({ id: s.pricingRules.id });
  return row!.id;
}

/** Inserts an active merchant in a group. */
export function insertMerchantIn(db: Database, groupId: number, values: Partial<typeof s.clients.$inferInsert> = {}) {
  return insertMerchant(db, { groupId, ...values });
}

/**
 * Reads the catalog price version as a cache key carries it (`...:v<n>`).
 *
 * Why: a price list cached under a versioned key is emptied when the version moves; tests compare this value before and after
 * a write to see whether the write moved it.
 *
 * @param t the running test app
 * @returns the versioned form of a fixed probe key
 */
export async function catalogVersionOf(t: TestApp): Promise<string> {
  return t.app.get(CatalogPriceVersion).versioned(t.app.get(CacheKeys).settings());
}
