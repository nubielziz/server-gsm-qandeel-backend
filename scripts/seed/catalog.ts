// Seeder of the catalog module: the demo's service categories, services (with their custom fields, option lists and the two
// group prices) and, when a configuration is given, the code inventory of the two digital-code services. Mirrors the frontend
// mocks (src/features/services/mocks/seed.ts): categories come from the services' category names in order of first appearance,
// services keep the demo ids, codes and prices, and the made-up fields, options and codes are the mock's.
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { INVENTORY_CODE_AAD, deliveryTimeText, inventoryCodeHashInput, lastFour } from '../../src/modules/catalog';
import { type DemoSeed, demoNumericId, demoRows, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A service of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoService {
  id: string;
  code: string;
  name: string;
  type: 'IMEI' | 'Server' | 'Remote' | 'File';
  category: string;
  cost: number;
  costWas: number | null;
  price: number;
  minProfit: number;
  sla: number;
  status: 'active' | 'disabled';
  auto: boolean;
}

/** The demo's merchant group keys and the ids the identity seed gives them. */
const GROUP_IDS: Readonly<Record<string, number>> = { std: 1, whl: 2, vip: 3 };

/** Codes for a digital-code service: a made-up but stable pattern, the first few sold, one voided (the mock's `codesFor`). */
function codesFor(serviceId: number, prefix: string, count: number, firstId: number, now: number) {
  const tails = ['A1B2', 'C3D4', 'E5F6', 'G7H8'];
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    serviceId,
    code: `${prefix}-${String(1000 + index)}-${tails[index % tails.length]}`,
    // The demo's orders are not seeded yet (feature 5), so a sold code has no order reference here.
    status: index === count - 1 ? ('void' as const) : index < 4 ? ('sold' as const) : ('available' as const),
    batchRef: index < 8 ? 'B-0001' : 'B-0002',
    createdAt: new Date(now - (count - index) * HOUR_MS),
  }));
}

/**
 * Seeds the categories, services, custom fields, option lists and group prices of the demo, and the inventory codes when
 * `config` is given.
 *
 * Why: the console's Services & pricing page and the later pricing, order and storefront features start from the same 27
 * services. Every service has `effective_cost` equal to its cost (no supplier is seeded yet: feature 6 links them and recomputes).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (encryption keys and token pepper for the inventory codes); without it the
 *   inventory is left out
 * @returns one report per table
 */
export async function seedCatalog(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const demoServices = demoRows<DemoService>(demo, 'services');
  const createdAt = new Date(demo.now - 300 * DAY_MS);

  // Categories in order of first appearance; a category takes the type of its first service.
  const categoryIds = new Map<string, number>();
  // The id is an identity column (`generated always`): `insertRows` writes it with OVERRIDING SYSTEM VALUE to keep the demo ids.
  const categories: Array<typeof s.serviceCategories.$inferInsert & { id: number }> = [];
  for (const service of demoServices) {
    if (categoryIds.has(service.category)) continue;
    const id = categoryIds.size + 1;
    categoryIds.set(service.category, id);
    categories.push({
      id,
      name: service.category,
      type: service.type.toLowerCase() as 'imei' | 'server' | 'remote' | 'file',
      allowedGroupIds: [],
      sort: id,
      isActive: true,
      createdAt,
    });
  }
  const categoryReport = await insertRows(db, s.serviceCategories, categories);
  await syncIdentity(db, s.serviceCategories);

  const serviceReport = await insertRows(
    db,
    s.services,
    demoServices.map((service) => ({
      id: demoNumericId(service.id),
      categoryId: categoryIds.get(service.category)!,
      type: service.type.toLowerCase() as 'imei' | 'server' | 'remote' | 'file',
      name: service.name,
      deliveryTime: deliveryTimeText(service.sla),
      status: service.status,
      fulfillment: service.auto ? ('auto' as const) : ('manual' as const),
      basePrice: toMoney(service.price),
      cost: toMoney(service.cost),
      effectiveCost: toMoney(service.cost),
      costWas: service.costWas === null ? null : toMoney(service.costWas),
      minProfit: toMoney(service.minProfit),
      code: service.code,
      slaMinutes: service.sla,
      createdAt,
    })),
  );
  await syncIdentity(db, s.services);
  const idOfCode = new Map(demoServices.map((service) => [service.code, demoNumericId(service.id)]));

  // The demo's two group service prices (`S.groupPrices`, keys like `vip|IMEI-ATT-USA`).
  const groupPriceRows = Object.entries((demo.state.groupPrices ?? {}) as Record<string, number>).flatMap(
    ([key, price]) => {
      const [group = '', code = ''] = key.split('|');
      const serviceId = idOfCode.get(code);
      const groupId = GROUP_IDS[group];
      return serviceId === undefined || groupId === undefined ? [] : [{ serviceId, groupId, price: toMoney(price) }];
    },
  );
  const groupPrices = await insertRows(db, s.serviceGroupPrices, groupPriceRows);
  await syncIdentity(db, s.serviceGroupPrices);

  // One custom field and one set of option lists, so the console's dialogs have something to show (the mock's).
  const z3x = idOfCode.get('SRV-Z3X-10');
  const att = idOfCode.get('IMEI-ATT-USA');
  const fields = await insertRows(
    db,
    s.serviceFields,
    z3x === undefined
      ? []
      : [
          {
            serviceId: z3x,
            key: 'account',
            label: 'Z3X account',
            fieldType: 'text' as const,
            required: true,
            supplierKey: 'user',
            sort: 0,
            createdAt,
          },
        ],
  );
  await syncIdentity(db, s.serviceFields);
  const options = await insertRows(
    db,
    s.serviceOptions,
    att === undefined
      ? []
      : [
          { serviceId: att, list: 'model' as const, value: 'iphone15', label: 'iPhone 15', createdAt },
          { serviceId: att, list: 'model' as const, value: 'iphone14', label: 'iPhone 14', createdAt },
          {
            serviceId: att,
            list: 'network' as const,
            value: 'att',
            label: 'AT&T USA',
            supplierValue: 'ATT',
            createdAt,
          },
        ],
  );
  await syncIdentity(db, s.serviceOptions);

  const reports = [categoryReport, serviceReport, groupPrices, fields, options];
  if (config) reports.push(await seedInventory(db, demo, config, idOfCode));
  return reports;
}

/** Seeds the stock of the Z3X credits and the UnlockTool licence services; a code is stored encrypted, like an import does. */
async function seedInventory(
  db: DbExecutor,
  demo: DemoSeed,
  config: AppConfig,
  idOfCode: ReadonlyMap<string, number>,
): Promise<SeedReport> {
  const encryption = new EncryptionService(config);
  const tokens = new TokenService(config);
  const z3x = idOfCode.get('SRV-Z3X-10');
  const unlockTool = idOfCode.get('SRV-UT-1D');
  const stock = [
    ...(z3x === undefined ? [] : codesFor(z3x, 'Z3X', 18, 1, demo.now)),
    ...(unlockTool === undefined ? [] : codesFor(unlockTool, 'UT', 12, 19, demo.now)),
  ];
  const report = await insertRows(
    db,
    s.inventoryCodes,
    stock.map((code) => ({
      // Explicit ids (the mock's) make a second run skip the rows; void codes are outside the unique hash index.
      id: code.id,
      serviceId: code.serviceId,
      codeEnc: encryption.encrypt(code.code, INVENTORY_CODE_AAD),
      codeHash: tokens.hash(inventoryCodeHashInput(code.code)),
      codeLast4: lastFour(code.code),
      status: code.status,
      batchRef: code.batchRef,
      createdAt: code.createdAt,
    })),
  );
  await syncIdentity(db, s.inventoryCodes);
  // The next generated batch reference follows the highest seeded one (B-0003), and the sequence never moves backwards.
  await db.execute(sql`
    select setval('inventory_batch_ref_seq', greatest(
      (select last_value from inventory_batch_ref_seq),
      coalesce((select max(substring(batch_ref from '^B-([0-9]+)$')::int) from ${s.inventoryCodes}), 0),
      1))`);
  return report;
}
