// Seeder of the storefront (feature 14a): the demo's retail prices (the `b2c_retail` group prices), its 14 service listings, its 8 TAC
// catalogue entries and its legal documents, mapped as the frontend mocks map them (src/features/storefront/mocks/seed.ts of the
// frontend): listing ids in order, `model` = the model code and `marketingName` = the name for a TAC, the document types as the API's
// words. The demo has no page text and no legal text, so short texts are made up like the mock does. Runs after the catalog seeder.
import { eq } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { deliveryTimeText } from '../../src/modules/catalog';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

interface DemoService {
  id: string;
  code: string;
  name: string;
  sla: number;
}
interface DemoListing {
  sid: string;
  slug: string;
  title: string;
  listed: boolean;
  featured: boolean;
}
interface DemoTac {
  tac: string;
  brand: string;
  model: string;
  code: string;
  year: number;
}
interface DemoLegal {
  type: string;
  version: string;
  lang: string;
  effective: number;
  current: boolean;
  needs: boolean;
}

/** What the listing filters need to know about a service, by service code: the demo has no such field, so these are the obvious ones. */
const LISTING_FACETS: Readonly<Record<string, { brand?: string; carrier?: string; country?: string }>> = {
  'IMEI-ICL-CHK': { brand: 'Apple' },
  'IMEI-APL-WRN': { brand: 'Apple' },
  'IMEI-SAM-INF': { brand: 'Samsung' },
  'IMEI-ATT-USA': { brand: 'Apple', carrier: 'AT&T', country: 'US' },
  'IMEI-TMO-USA': { brand: 'Apple', carrier: 'T-Mobile', country: 'US' },
  'IMEI-VZW-USA': { brand: 'Apple', carrier: 'Verizon', country: 'US' },
  'IMEI-VOD-UK': { brand: 'Apple', carrier: 'Vodafone', country: 'GB' },
  'IMEI-EE-UK': { brand: 'Apple', carrier: 'EE', country: 'GB' },
  'IMEI-ORG-FR': { brand: 'Apple', carrier: 'Orange', country: 'FR' },
  'IMEI-SAM-KG': { brand: 'Samsung' },
  'IMEI-MDM-PRM': { brand: 'Apple' },
  'IMEI-ICL-LOST': { brand: 'Apple' },
  'IMEI-XIA-MI': { brand: 'Xiaomi' },
};

/** The demo's document names as the API's type words. */
const LEGAL_TYPE: Readonly<Record<string, 'terms' | 'privacy' | 'refund' | 'cookies'>> = {
  'Terms of service': 'terms',
  'Privacy policy': 'privacy',
  'Refund policy': 'refund',
  'Cookie policy': 'cookies',
};

const bodyFor = (title: string) => `# ${title}\n\nText for ${title} goes here.`;

/**
 * Seeds the retail prices, listings, TAC catalogue and legal documents of the demo.
 *
 * Why: the storefront (feature 14a) sells only what staff priced for the retail group and listed, recognises devices by TAC and
 * records consent against the current legal documents; the console's Storefront page shows the same rows through the admin routes
 * of feature 15. A listing the demo marks locked is stored switched off (the lock itself is derived, B53). The demo has no draft
 * legal version in `S.legal`; the mock adds a Refund policy v1.5 draft for its Publish button, and so does this seed.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedStorefront(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const services = demoRows<DemoService>(demo, 'services');
  const idOfCode = new Map(services.map((service) => [service.code, demoNumericId(service.id)]));
  const byId = new Map(services.map((service) => [demoNumericId(service.id), service]));
  const [retail] = await db
    .select({ id: s.clientGroups.id })
    .from(s.clientGroups)
    .where(eq(s.clientGroups.kind, 'b2c_retail'))
    .limit(1);
  const created = new Date(demo.now - 30 * 86_400_000);

  const retailPrices = Object.entries((demo.state.retail ?? {}) as Record<string, number>).flatMap(([code, price]) => {
    const serviceId = idOfCode.get(code);
    return serviceId === undefined || retail === undefined
      ? []
      : [{ serviceId, groupId: retail.id, price: toMoney(price) }];
  });
  const prices = await insertRows(db, s.serviceGroupPrices, retailPrices);
  await syncIdentity(db, s.serviceGroupPrices);

  const listings = await insertRows(
    db,
    s.serviceListings,
    demoRows<DemoListing>(demo, 'listings').flatMap((listing, index) => {
      const serviceId = demoNumericId(listing.sid);
      const service = byId.get(serviceId);
      if (service === undefined) return [];
      const facets = LISTING_FACETS[service.code] ?? {};
      return [
        {
          id: index + 1,
          serviceId,
          locale: 'en',
          slug: listing.slug,
          publicTitle: listing.title,
          summary: `Delivered in ${deliveryTimeText(service.sla)}.`,
          etaText: deliveryTimeText(service.sla),
          brand: facets.brand ?? '',
          carrier: facets.carrier ?? '',
          country: facets.country ?? '',
          isListed: listing.listed,
          isFeatured: listing.featured,
          sort: index + 1,
          createdAt: created,
        },
      ];
    }),
  );
  await syncIdentity(db, s.serviceListings);

  const tac = await insertRows(
    db,
    s.tacCatalog,
    demoRows<DemoTac>(demo, 'tac').map((entry, index) => ({
      id: index + 1,
      tac: entry.tac,
      brand: entry.brand,
      model: entry.code,
      marketingName: entry.model,
      releaseYear: entry.year,
      source: 'import',
      createdAt: created,
    })),
  );
  await syncIdentity(db, s.tacCatalog);

  const legalRows = demoRows<DemoLegal>(demo, 'legal').map((doc, index) => ({
    id: index + 1,
    type: LEGAL_TYPE[doc.type] ?? ('terms' as const),
    version: doc.version,
    locale: doc.lang.toLowerCase(),
    bodyMd: bodyFor(`${doc.type} v${doc.version}`),
    effectiveFrom: toDate(doc.effective),
    isCurrent: doc.current,
    requiresReacceptance: doc.needs,
    createdAt: toDate(doc.effective) ?? created,
  }));
  legalRows.push({
    id: legalRows.length + 1,
    type: 'refund',
    version: '1.5',
    locale: 'en',
    bodyMd: bodyFor('Refund policy v1.5'),
    effectiveFrom: null,
    isCurrent: false,
    requiresReacceptance: true,
    createdAt: new Date(demo.now - 86_400_000),
  });
  const legal = await insertRows(db, s.legalDocuments, legalRows);
  await syncIdentity(db, s.legalDocuments);

  return [prices, listings, tac, legal];
}
