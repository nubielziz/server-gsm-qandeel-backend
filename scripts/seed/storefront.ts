// Seeder of the storefront module (features 14a and 15): the demo's retail prices (the `b2c_retail` group prices), its 14 service
// listings, its 8 TAC catalogue entries, the landing and content pages, the help articles and the legal documents. Mirrors the
// frontend mocks (src/features/storefront/mocks/seed.ts of the frontend): the same ids, slugs, titles, statuses and versions; the
// texts the demo does not have are short made-up ones, as in the mock. Runs after the catalog seeder.
import { eq } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { deliveryTimeText } from '../../src/modules/catalog';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const DAY_MS = 86_400_000;

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
  seoTitle: boolean;
  seoDesc: boolean;
}
interface DemoTac {
  tac: string;
  brand: string;
  model: string;
  code: string;
  year: number;
}
interface DemoPage {
  title: string;
  slug: string;
  kind: (typeof s.CONTENT_PAGE_KINDS)[number];
  status: (typeof s.CONTENT_PAGE_STATUSES)[number];
  updated: number;
}
interface DemoLegal {
  type: string;
  version: string;
  lang: string;
  effective: number;
  current: boolean;
  needs: boolean;
}
interface DemoHelp {
  cat: string;
  q: string;
  yes: number;
  no: number;
  status: 'published' | 'draft';
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

/** The demo's document names as the type words the API stores. */
const LEGAL_TYPE: Readonly<Record<string, (typeof s.LEGAL_DOCUMENT_TYPES)[number]>> = {
  'Terms of service': 'terms',
  'Privacy policy': 'privacy',
  'Refund policy': 'refund',
  'Cookie policy': 'cookies',
};

const bodyFor = (title: string) => `# ${title}\n\nText for ${title} goes here.`;

/**
 * Seeds the retail prices, listings, TAC catalogue, pages, help articles and legal documents of the demo.
 *
 * Why: the storefront (feature 14a) sells only what staff priced for the retail group and listed, recognises devices by TAC and
 * records consent against the current legal documents; the console's Storefront page (Services on sale, Landing pages, Content
 * and legal, Help centre) and the public content routes (feature 15) show the same rows. Listings keep the ids 1 to 14 (one
 * English listing per IMEI service, as the mock); a listing the demo marks locked is stored switched off (the lock itself is
 * derived, B53). Pages take the landing pages first and then the content pages. The legal documents are the demo's six versions
 * plus one draft refund policy (1.5) so that Publish has something to publish (the demo has none; the mock adds it too).
 * Retail prices are the `b2c_retail` group rows of the demo's `retail` map. The demo's services (and the retail group) must
 * already exist: the identity and catalog seeders run first.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table: retail prices, listings, TAC catalogue, pages, help articles, legal documents
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
  const created = new Date(demo.now - 200 * DAY_MS);

  // The storefront price of a service is the retail group's row of service_group_prices (feature 15 writes it, catalog reads it).
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
          seoTitle: listing.seoTitle ? listing.title : '',
          seoDescription: listing.seoDesc ? `Order ${listing.title} online and track it in your account.` : '',
          createdAt: created,
          updatedAt: created,
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

  // Landing pages first (ids 1 to 14), then the static pages and blog posts: one table, as the mock has it.
  const pageRows = [...demoRows<DemoPage>(demo, 'landing'), ...demoRows<DemoPage>(demo, 'pages')].map((page, index) => {
    const live = page.status !== 'draft';
    return {
      id: index + 1,
      kind: page.kind,
      slug: page.slug,
      locale: 'en',
      title: page.title,
      bodyMd: bodyFor(page.title),
      seoTitle: page.title,
      seoDescription: '',
      status: page.status,
      publishedAt: live ? toDate(page.updated) : null,
      createdAt: new Date(page.updated - 30 * DAY_MS),
      updatedAt: new Date(page.updated),
    };
  });
  const pages = await insertRows(db, s.contentPages, pageRows);
  await syncIdentity(db, s.contentPages);

  const helpRows = demoRows<DemoHelp>(demo, 'help').map((article, index) => ({
    id: index + 1,
    category: article.cat,
    question: article.q,
    answerMd: `Short answer to "${article.q}".`,
    locale: 'en',
    sort: index + 1,
    isPublished: article.status === 'published',
    helpfulYes: article.yes,
    helpfulNo: article.no,
    createdAt: new Date(demo.now - 60 * DAY_MS),
    updatedAt: new Date(demo.now - 10 * DAY_MS),
  }));
  const help = await insertRows(db, s.helpArticles, helpRows);
  await syncIdentity(db, s.helpArticles);

  const legalRows = demoRows<DemoLegal>(demo, 'legal').map((document, index) => ({
    id: index + 1,
    type: LEGAL_TYPE[document.type] ?? ('terms' as const),
    version: document.version,
    locale: document.lang.toLowerCase(),
    bodyMd: bodyFor(`${document.type} v${document.version}`),
    effectiveFrom: toDate(document.effective),
    isCurrent: document.current,
    requiresReacceptance: document.needs,
    createdAt: new Date(document.effective),
    updatedAt: new Date(document.effective),
  }));
  // The demo has no draft version, so one is added for the Publish button to work on.
  legalRows.push({
    id: legalRows.length + 1,
    type: 'refund',
    version: '1.5',
    locale: 'en',
    bodyMd: bodyFor('Refund policy v1.5'),
    effectiveFrom: null,
    isCurrent: false,
    requiresReacceptance: true,
    createdAt: new Date(demo.now - DAY_MS),
    updatedAt: new Date(demo.now - DAY_MS),
  });
  const legal = await insertRows(db, s.legalDocuments, legalRows);
  await syncIdentity(db, s.legalDocuments);

  return [prices, listings, tac, pages, help, legal];
}
