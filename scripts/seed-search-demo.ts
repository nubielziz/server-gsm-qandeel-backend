// Demo catalog for trying the storefront search (feature 29) on a development database: the ~60 English services of the search
// golden fixture (test/fixtures/search/catalog.ts: Samsung FRP, iCloud, carrier unlocks, model codes such as SM-A525F, tools), each
// with a retail price and a listed English listing, so the shop header's search box has something to complete and suggest.
//
// Usage (development only; the database of the environment, `gsm` by default):
//   bun scripts/seed-search-demo.ts           adds the demo services (idempotent: a service already added is skipped)
//   bun scripts/seed-search-demo.ts --remove  removes them again (a service with an order is archived instead of deleted)
//
// Every row it adds is marked: service codes start with `DEMO-SEARCH-`, so `--remove` touches nothing else. It writes the same
// outbox event the admin writers write (`catalog.services_changed`), so the worker indexes the services within seconds once it runs.
// Why a script and not the seed: the owner's development data stays as it is; this adds to it on request and can be taken back.
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { loadConfigOrExit } from '../src/config';
import { createDrizzle, createPool, schema as s, type DbExecutor } from '../src/infra/db';
import { databaseUrlFor } from '../src/infra/db/url';
import { deliveryTimeText } from '../src/modules/catalog';
import { FIXTURE, FIXTURE_CATEGORIES } from '../test/fixtures/search/catalog';

/** Fixture rows that exist only to test the ranking (a misspelled title), left out of the demo. */
const SKIP = new Set(['iphone-15-pro-max-unloc-service']);

/** The code prefix that marks every demo service. */
export const DEMO_CODE_PREFIX = 'DEMO-SEARCH-';

const TYPE_LABEL = { imei: 'IMEI', server: 'Server', remote: 'Remote', file: 'File' } as const;
type ServiceType = keyof typeof TYPE_LABEL;

/** A category of the demo: the fixture's name for IMEI services, a suffixed one for the other types (a category has one type). */
function categoryName(key: number, type: ServiceType): string {
  const base = Object.values(FIXTURE_CATEGORIES).find((category) => category.id === key)?.name ?? 'Demo Services';
  return type === 'imei' ? base : `${base} (${TYPE_LABEL[type]})`;
}

/** A plausible retail price (USD) for a demo service, from its type and position: deterministic, never zero. */
function priceOf(type: ServiceType, index: number): { price: string; cost: string; sla: number } {
  const base = { imei: 9.99, server: 19.99, remote: 24.99, file: 14.99 }[type];
  const price = base + (index % 7) * 2.5;
  return { price: price.toFixed(2), cost: (price * 0.6).toFixed(2), sla: type === 'imei' ? 30 + (index % 5) * 30 : 60 };
}

async function events(db: DbExecutor, serviceIds: readonly number[]): Promise<void> {
  for (let start = 0; start < serviceIds.length; start += 50) {
    const chunk = serviceIds.slice(start, start + 50);
    await db.insert(s.outboxEvents).values({
      type: 'catalog.services_changed',
      aggregateType: 'services',
      aggregateId: chunk[0]!,
      payload: { serviceIds: chunk, reason: 'service' },
    });
  }
}

async function add(db: DbExecutor): Promise<string> {
  const [retail] = await db
    .select({ id: s.clientGroups.id })
    .from(s.clientGroups)
    .where(eq(s.clientGroups.kind, 'b2c_retail'))
    .limit(1);
  if (!retail) throw new Error('The database has no b2c_retail client group: run the migrations and the seed first.');

  const existing = new Set(
    (
      await db
        .select({ code: s.services.code })
        .from(s.services)
        .where(like(s.services.code, `${DEMO_CODE_PREFIX}%`))
    ).map((row) => row.code),
  );
  const takenSlugs = new Set(
    (
      await db
        .select({ slug: s.serviceListings.slug })
        .from(s.serviceListings)
        .where(eq(s.serviceListings.locale, 'en'))
    ).map((row) => row.slug),
  );

  const categoryIds = new Map<string, number>();
  const categoryFor = async (key: number, type: ServiceType): Promise<number> => {
    const name = categoryName(key, type);
    const mapKey = `${name}|${type}`;
    const known = categoryIds.get(mapKey);
    if (known !== undefined) return known;
    const [found] = await db
      .select({ id: s.serviceCategories.id })
      .from(s.serviceCategories)
      .where(and(eq(s.serviceCategories.name, name), eq(s.serviceCategories.type, type)))
      .limit(1);
    const id =
      found?.id ??
      (
        await db
          .insert(s.serviceCategories)
          .values({ name, type, allowedGroupIds: [], isActive: true, sort: 900 + categoryIds.size })
          .returning({ id: s.serviceCategories.id })
      )[0]!.id;
    categoryIds.set(mapKey, id);
    return id;
  };

  const added: number[] = [];
  let skipped = 0;
  const now = new Date();
  for (const [index, entry] of FIXTURE.entries()) {
    const source = entry.source;
    const code = `${DEMO_CODE_PREFIX}${String(index + 1).padStart(3, '0')}`;
    if (SKIP.has(entry.slug)) continue;
    if (existing.has(code) || takenSlugs.has(entry.slug)) {
      skipped += 1;
      continue;
    }
    const type = source.type as ServiceType;
    const figures = priceOf(type, index);
    const [service] = await db
      .insert(s.services)
      .values({
        categoryId: await categoryFor(source.categoryId, type),
        type,
        name: source.serviceName,
        deliveryTime: deliveryTimeText(figures.sla),
        status: 'active',
        fulfillment: 'manual',
        basePrice: figures.price,
        cost: figures.cost,
        effectiveCost: figures.cost,
        minProfit: '1.00',
        code,
        slaMinutes: figures.sla,
        allowCancel: type !== 'file',
        allowVerify: type === 'imei',
        verifyWindowH: type === 'imei' ? 72 : 0,
      })
      .returning({ id: s.services.id });
    const serviceId = service!.id;
    await db.insert(s.serviceGroupPrices).values({ serviceId, groupId: retail.id, price: figures.price });
    await db.insert(s.serviceListings).values({
      serviceId,
      locale: 'en',
      slug: entry.slug,
      publicTitle: source.title,
      summary: source.summary,
      etaText: deliveryTimeText(figures.sla),
      brand: source.brand,
      carrier: source.carrier,
      country: source.country,
      isListed: true,
      isFeatured: source.isFeatured,
      listedAt: now,
      sort: 900 + index,
      sales30d: source.sales30d,
    });
    const options = [
      ...source.networks.map((label, n) => ({ serviceId, list: 'network' as const, value: `net-${n + 1}`, label })),
      ...source.models.map((label, n) => ({ serviceId, list: 'model' as const, value: `model-${n + 1}`, label })),
    ];
    if (options.length > 0) await db.insert(s.serviceOptions).values(options);
    added.push(serviceId);
  }
  await events(db, added);
  return `added ${added.length} demo services (${skipped} already there), ${categoryIds.size} categories used; the worker indexes them once it runs`;
}

async function remove(db: DbExecutor): Promise<string> {
  const demo = await db
    .select({ id: s.services.id, categoryId: s.services.categoryId })
    .from(s.services)
    .where(like(s.services.code, `${DEMO_CODE_PREFIX}%`));
  if (demo.length === 0) return 'no demo services to remove';
  const ids = demo.map((row) => row.id);
  const ordered = new Set(
    (await db.select({ id: s.orders.serviceId }).from(s.orders).where(inArray(s.orders.serviceId, ids))).map(
      (row) => row.id,
    ),
  );
  const deletable = ids.filter((id) => !ordered.has(id));
  const archived = ids.filter((id) => ordered.has(id));
  await db.delete(s.serviceListings).where(inArray(s.serviceListings.serviceId, ids));
  await db.delete(s.serviceGroupPrices).where(inArray(s.serviceGroupPrices.serviceId, ids));
  await db.delete(s.serviceOptions).where(inArray(s.serviceOptions.serviceId, ids));
  if (archived.length > 0)
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date() })
      .where(inArray(s.services.id, archived));
  if (deletable.length > 0) await db.delete(s.services).where(inArray(s.services.id, deletable));
  // The demo's own categories go when nothing is left in them.
  const categories = [...new Set(demo.map((row) => row.categoryId))];
  await db.execute(sql`
    delete from service_categories c
    where c.id in (${sql.join(
      categories.map((id) => sql`${id}`),
      sql`, `,
    )})
      and c.sort >= 900
      and not exists (select 1 from services x where x.category_id = c.id)`);
  await events(db, ids);
  return `removed ${deletable.length} demo services${archived.length > 0 ? `, archived ${archived.length} with orders` : ''}; the worker drops them from the index once it runs`;
}

if (import.meta.main) {
  const config = loadConfigOrExit();
  if (config.env === 'production') {
    console.error('Refusing to add demo data in production.');
    process.exit(1);
  }
  const url = databaseUrlFor(config);
  const pool = createPool(url, 2);
  const db = createDrizzle(pool);
  try {
    const message = await db.transaction((tx) => (process.argv.includes('--remove') ? remove(tx) : add(tx)));
    console.log(`${new URL(url).pathname.slice(1)}: ${message}`);
  } finally {
    await pool.end();
  }
}
