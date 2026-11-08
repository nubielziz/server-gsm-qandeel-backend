// Helpers for the storefront tests (features 14a and 15): the anti-bot header, currencies, tax windows, a priced and listed service,
// the legal documents a checkout needs and a world for the listing admin tests, plus direct inserts of listings, content pages,
// help articles, legal versions, a storefront customer and a storefront order, straight into the test database.
import { type Database, schema as s } from '../../src/infra/db';
import { TURNSTILE_DUMMY_TOKEN, TURNSTILE_HEADER } from '../../src/infra/turnstile';
import { insertCategory, insertService } from './catalog';
import { insertUsd } from './fixtures';
import { insertOrderRow } from './orders';
import { insertDemoGroups } from './pricing';

/** The headers of a storefront write that passes the anti-bot check (decision 034): the dummy token of the development verifier. */
export const TURNSTILE_HEADERS: Readonly<Record<string, string>> = { [TURNSTILE_HEADER]: TURNSTILE_DUMMY_TOKEN };

/** A header map with the anti-bot token plus anything else. */
export const withTurnstile = (headers: Record<string, string> = {}): Record<string, string> => ({
  ...TURNSTILE_HEADERS,
  ...headers,
});

/** A valid IMEI whose TAC (35389011) is in the demo catalogue (an iPhone 13). */
export const APPLE_IMEI = '353890110000004';
/** A valid IMEI whose TAC (86741205) is not in the catalogue of the tests. */
export const UNKNOWN_TAC_IMEI = '867412050000016';

/** Completes 14 digits with their Luhn check digit. */
export function withLuhn(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    let digit = Number(first14[13 - index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${first14}${(10 - (sum % 10)) % 10}`;
}

/** Inserts a currency (offered by default) and returns its id. */
export async function insertCurrency(
  db: Database,
  values: Partial<typeof s.currencies.$inferInsert> & Pick<typeof s.currencies.$inferInsert, 'code'>,
): Promise<number> {
  const [row] = await db
    .insert(s.currencies)
    .values({ name: values.code, rateToBase: '1', decimals: 2, isStorefront: true, ...values })
    .onConflictDoUpdate({ target: s.currencies.code, set: { ...values } })
    .returning({ id: s.currencies.id });
  return row!.id;
}

/** Inserts a tax window (UK VAT 20 % from the start of 2025 by default). */
export async function insertTaxWindow(
  db: Database,
  values: Partial<typeof s.taxRates.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.taxRates)
    .values({
      country: 'GB',
      ratePercent: '20',
      taxType: 'vat',
      appliesTo: 'digital_services',
      label: 'UK VAT',
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      ...values,
    })
    .returning({ id: s.taxRates.id });
  return row!.id;
}

/** Inserts a service listing in English (switched on) and returns its id. */
export async function insertListing(
  db: Database,
  serviceId: number,
  values: Partial<typeof s.serviceListings.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.serviceListings)
    .values({
      serviceId,
      locale: 'en',
      slug: `listing-${crypto.randomUUID().slice(0, 8)}`,
      publicTitle: 'A service',
      isListed: true,
      ...values,
    })
    .returning({ id: s.serviceListings.id });
  return row!.id;
}

/** Inserts a current legal document version and returns its id. */
export async function insertLegal(
  db: Database,
  values: Partial<typeof s.legalDocuments.$inferInsert> & Pick<typeof s.legalDocuments.$inferInsert, 'type'>,
): Promise<number> {
  const [row] = await db
    .insert(s.legalDocuments)
    .values({
      version: '1.0',
      locale: 'en',
      bodyMd: 'The text.',
      isCurrent: true,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      ...values,
    })
    .returning({ id: s.legalDocuments.id });
  return row!.id;
}

/** What {@link storefrontWorld} builds. */
export interface StorefrontWorld {
  readonly db: Database;
  readonly groups: { standard: number; wholesale: number; vip: number; retail: number };
  /** The iCloud check: cost 0.08, base price 0.13, retail price 3.99 (floor 0.14, storefront floor 0.14), listed in English. */
  readonly icloud: { serviceId: number; categoryId: number; listingId: number; slug: string };
  /** The AT&T unlock: cost 13.50, base price 17.28, retail price 25.99, listed in English (a carrier, USA). */
  readonly att: { serviceId: number; listingId: number; slug: string };
}

/**
 * Builds the usual storefront: USD and GBP (1.5 % markup on 0.79), UK VAT 20 %, the four demo groups, two services with a retail
 * price and an English listing each, and the terms, privacy and refund documents.
 *
 * @param db the test database
 * @returns the ids a test needs
 */
export async function storefrontWorld(db: Database): Promise<StorefrontWorld> {
  await insertCurrency(db, { code: 'USD', name: 'US dollar', rateToBase: '1' });
  await insertCurrency(db, { code: 'GBP', name: 'British pound', rateToBase: '0.79', markupPercent: '1.5' });
  await insertTaxWindow(db);
  const groups = await insertDemoGroups(db);
  const apple = await insertCategory(db, { name: 'Apple' });
  const carrier = await insertCategory(db, { name: 'Carrier unlock' });
  const icloudId = await insertService(db, apple, {
    name: 'iCloud Clean / Lost Check',
    code: 'IMEI-ICL-CHK',
    cost: '0.0800',
    effectiveCost: '0.0800',
    basePrice: '0.1300',
    minProfit: null,
    slaMinutes: 2,
    deliveryTime: '2 minutes',
  });
  const attId = await insertService(db, carrier, {
    name: 'AT&T USA Premier Unlock',
    code: 'IMEI-ATT-USA',
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    slaMinutes: 1440,
    deliveryTime: '1 day',
  });
  await db.insert(s.serviceGroupPrices).values([
    { serviceId: icloudId, groupId: groups.retail, price: '3.9900' },
    { serviceId: attId, groupId: groups.retail, price: '25.9900' },
  ]);
  const icloudSlug = 'icloud-clean-lost-check';
  const attSlug = 'att-usa-premier-unlock';
  const icloudListing = await insertListing(db, icloudId, {
    slug: icloudSlug,
    publicTitle: 'iCloud Clean / Lost Check',
    summary: 'Find out if the phone is clean before you buy.',
    brand: 'Apple',
    isFeatured: true,
    sort: 1,
  });
  const attListing = await insertListing(db, attId, {
    slug: attSlug,
    publicTitle: 'AT&T USA Premier Unlock',
    summary: 'Unlock an AT&T iPhone.',
    brand: 'Apple',
    carrier: 'AT&T',
    country: 'US',
    sort: 2,
  });
  await insertLegal(db, { type: 'terms', version: '3.2' });
  await insertLegal(db, { type: 'privacy', version: '2.1' });
  await insertLegal(db, { type: 'refund', version: '1.4' });
  return {
    db,
    groups,
    icloud: { serviceId: icloudId, categoryId: apple, listingId: icloudListing, slug: icloudSlug },
    att: { serviceId: attId, listingId: attListing, slug: attSlug },
  };
}

/**
 * Builds a world for the listing tests: USD, the demo's groups (the last is the retail group) and two services in a category
 * open to every group: the AT&T unlock (cost 13.50, base 17.28, own minimum profit 0.81: storefront floor 19.01) and a cheap
 * check (cost 0.08, base 0.13, no own minimum profit: floor 0.14).
 */
export async function listingWorld(db: Database) {
  await insertUsd(db);
  const groups = await insertDemoGroups(db);
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  const att = await insertService(db, categoryId, {
    name: 'AT&T USA Premier Unlock',
    code: 'IMEI-ATT-USA',
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    slaMinutes: 1440,
  });
  const check = await insertService(db, categoryId, {
    name: 'iCloud Clean / Lost Check',
    code: 'IMEI-ICL-CHK',
    cost: '0.0800',
    effectiveCost: '0.0800',
    basePrice: '0.1300',
    slaMinutes: 5,
  });
  return { groups, categoryId, att, check };
}

/** Inserts a listing (listed in English, not featured by default) and returns its id. */
export async function insertListingRow(
  db: Database,
  serviceId: number,
  values: Partial<typeof s.serviceListings.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.serviceListings)
    .values({
      serviceId,
      locale: 'en',
      slug: `listing-${crypto.randomUUID().slice(0, 8)}`,
      publicTitle: 'A listing',
      ...values,
    })
    .returning({ id: s.serviceListings.id });
  return row!.id;
}

/** Inserts the retail price of a service (the `b2c_retail` group row). */
export async function insertRetailPrice(db: Database, serviceId: number, groupId: number, price: string) {
  await db.insert(s.serviceGroupPrices).values({ serviceId, groupId, price });
}

/** Inserts a content page (a published static page in English by default) and returns it. */
export async function insertPageRow(db: Database, values: Partial<typeof s.contentPages.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.contentPages)
    .values({
      kind: 'static',
      slug: `page-${crypto.randomUUID().slice(0, 8)}`,
      locale: 'en',
      title: 'A page',
      bodyMd: '# A page',
      status: 'published',
      publishedAt: new Date(),
      ...values,
    })
    .returning();
  return row!;
}

/** Inserts a help article (published, English) and returns it. */
export async function insertArticleRow(db: Database, values: Partial<typeof s.helpArticles.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.helpArticles)
    .values({
      category: 'Orders',
      question: 'How long does a carrier unlock take?',
      answerMd: 'Usually one to three days.',
      locale: 'en',
      isPublished: true,
      ...values,
    })
    .returning();
  return row!;
}

/** Inserts a legal version (a draft terms version in English by default) and returns it. */
export async function insertLegalRow(db: Database, values: Partial<typeof s.legalDocuments.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.legalDocuments)
    .values({ type: 'terms', version: '1.0', locale: 'en', bodyMd: '# Terms', ...values })
    .returning();
  return row!;
}

/** Inserts a storefront customer and returns its id. */
export async function insertCustomerRow(db: Database): Promise<number> {
  const [row] = await db
    .insert(s.customers)
    .values({ email: `customer-${crypto.randomUUID().slice(0, 8)}@example.com`, name: 'A customer' })
    .returning({ id: s.customers.id });
  return row!.id;
}

/** Inserts a storefront order (a customer, source `store`) of a service and returns its id. */
export async function insertStoreOrder(
  db: Database,
  serviceId: number,
  customerId: number,
  values: Partial<typeof s.orders.$inferInsert> = {},
): Promise<number> {
  const order = await insertOrderRow(db, { serviceId, customerId, source: 'store', ...values });
  return order.id;
}
