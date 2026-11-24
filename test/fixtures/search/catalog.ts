// The fixture catalog of the search golden set (feature 29, slice B2, plan section 8): about 60 English services named after the
// golden table, each with the facts a search document is built from, and the owner's five synonyms (the two pin rules of cases 34 and
// 56 left with decision 068). The slug of a service is the name the golden table expects; its numeric id is its position here (1-based).
import type { DocumentSource } from '@src/modules/storefront/search/domain/documents';

/** One fixture service: the slug the golden table names it by and the facts its document is built from. */
export interface FixtureService {
  readonly slug: string;
  readonly source: DocumentSource;
}

const CREATED = new Date('2026-01-10T09:00:00.000Z');

/** The categories of the fixture (none of their names holds a word a golden query searches for). */
export const FIXTURE_CATEGORIES = {
  samsung: { id: 1, name: 'Samsung Services' },
  apple: { id: 2, name: 'Apple Services' },
  android: { id: 3, name: 'Android Brands' },
  carrier: { id: 4, name: 'Carrier Services' },
  tools: { id: 5, name: 'Phone Tools' },
} as const;

type CategoryKey = keyof typeof FIXTURE_CATEGORIES;

interface Row {
  readonly slug: string;
  readonly title: string;
  readonly category: CategoryKey;
  readonly type?: 'imei' | 'server' | 'remote' | 'file';
  readonly serviceName?: string;
  readonly summary?: string;
  readonly brand?: string;
  readonly carrier?: string;
  readonly country?: string;
  readonly sales?: number;
  readonly featured?: boolean;
  readonly networks?: readonly string[];
  readonly models?: readonly string[];
  readonly inStock?: boolean;
}

const ROWS: readonly Row[] = [
  // The services the golden table names.
  {
    slug: 'samsung-frp-bypass',
    title: 'Samsung FRP Bypass',
    category: 'samsung',
    brand: 'Samsung',
    sales: 300,
    type: 'remote',
    summary: 'Remove the Google lock from a Samsung phone.',
  },
  {
    slug: 'iphone-icloud-removal',
    title: 'iPhone iCloud Removal',
    category: 'apple',
    brand: 'Apple',
    sales: 90,
    type: 'imei',
  },
  {
    slug: 'att-usa-iphone-unlock',
    title: 'AT&T iPhone Unlock',
    category: 'carrier',
    brand: 'Apple',
    carrier: 'AT&T',
    country: 'US',
    sales: 80,
    type: 'imei',
    serviceName: 'AT&amp;T USA iPhone Unlock Premier',
  },
  {
    slug: 'tmobile-usa-unlock',
    title: 'T-Mobile Unlock',
    category: 'carrier',
    carrier: 'T-Mobile',
    country: 'US',
    sales: 70,
    type: 'imei',
    serviceName: 'T-Mobile USA Unlock',
  },
  {
    slug: 'galaxy-a52-unlock-sm-a525f',
    title: 'Samsung Galaxy A52 Unlock (SM-A525F)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 30,
    type: 'imei',
    serviceName: 'Galaxy A52 SM-A525F Network Unlock',
  },
  {
    slug: 'galaxy-a52s-unlock-sm-a528b',
    title: 'Samsung Galaxy A52s Unlock (SM-A528B)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 25,
    type: 'imei',
    serviceName: 'Galaxy A52s SM-A528B Network Unlock',
  },
  {
    slug: 'iphone-15-pro-max-unlock',
    title: 'iPhone 15 Pro Max Unlock',
    category: 'apple',
    brand: 'Apple',
    sales: 110,
    type: 'imei',
    featured: true,
  },
  {
    slug: 'imei-blacklist-check',
    title: 'IMEI Blacklist Check',
    category: 'tools',
    sales: 140,
    type: 'imei',
    summary: 'Find out if a phone is reported lost or stolen.',
  },
  {
    slug: 'samsung-kg-removal',
    title: 'Samsung Knox Guard (KG) Removal',
    category: 'samsung',
    brand: 'Samsung',
    sales: 60,
    type: 'remote',
  },
  {
    slug: 'huawei-frp-reset',
    title: 'Huawei FRP Reset',
    category: 'android',
    brand: 'Huawei',
    sales: 20,
    type: 'remote',
  },
  {
    slug: 'xiaomi-mi-account-removal',
    title: 'Xiaomi Mi Account Removal',
    category: 'android',
    brand: 'Xiaomi',
    sales: 45,
    type: 'remote',
  },
  {
    slug: 'pixel-frp-removal',
    title: 'Google Pixel FRP Removal',
    category: 'android',
    brand: 'Google',
    sales: 15,
    type: 'remote',
  },
  {
    slug: 'vodafone-uk-unlock',
    title: 'Vodafone UK Network Unlock',
    category: 'carrier',
    carrier: 'Vodafone',
    country: 'GB',
    sales: 85,
    type: 'imei',
  },
  {
    slug: 'ee-uk-unlock',
    title: 'EE UK Network Unlock',
    category: 'carrier',
    carrier: 'EE',
    country: 'GB',
    sales: 75,
    type: 'imei',
  },
  {
    slug: 'motorola-unlock-code',
    title: 'Motorola Unlock Code',
    category: 'android',
    brand: 'Motorola',
    sales: 35,
    type: 'imei',
  },
  {
    slug: 'samsung-network-unlock-all-models',
    title: 'Samsung Network Unlock (All Models)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 95,
    type: 'imei',
    models: ['Galaxy S21 (SM-G991B)', 'Galaxy S21+ (SM-G996B)', 'Galaxy S21 Ultra (SM-G998B)', 'Galaxy S22 (SM-S901B)'],
  },
  // The two distractors of cases 54 and 55: popular, but a worse match.
  {
    slug: 'android-account-removal-pro',
    title: 'Android Account Removal Pro',
    category: 'android',
    summary: 'Samsung FRP in minutes, any model.',
    sales: 400,
    type: 'remote',
  },
  {
    slug: 'iphone-15-pro-max-unloc-service',
    title: 'iPhne 15 Pro Max Unlock Service',
    category: 'apple',
    brand: 'Apple',
    sales: 380,
    type: 'imei',
  },
  // Neighbours: the same brands, other jobs. None holds a reserved combination of the generator.
  {
    slug: 'samsung-mdm-removal',
    title: 'Samsung MDM Removal',
    category: 'samsung',
    brand: 'Samsung',
    sales: 50,
    type: 'remote',
  },
  {
    slug: 'samsung-imei-repair',
    title: 'Samsung IMEI Repair',
    category: 'samsung',
    brand: 'Samsung',
    sales: 28,
    type: 'remote',
  },
  {
    slug: 'galaxy-s23-network-unlock',
    title: 'Samsung Galaxy S23 Network Unlock',
    category: 'samsung',
    brand: 'Samsung',
    sales: 55,
    type: 'imei',
    serviceName: 'Galaxy S23 SM-S911B Network Unlock',
  },
  {
    slug: 'galaxy-a53-network-unlock',
    title: 'Samsung Galaxy A53 Network Unlock (SM-A536B)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 22,
    type: 'imei',
  },
  {
    slug: 'galaxy-a51-network-unlock',
    title: 'Samsung Galaxy A51 Network Unlock (SM-A515F)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 18,
    type: 'imei',
  },
  {
    slug: 'galaxy-a14-network-unlock',
    title: 'Samsung Galaxy A14 Network Unlock (SM-A145F)',
    category: 'samsung',
    brand: 'Samsung',
    sales: 16,
    type: 'imei',
  },
  {
    slug: 'samsung-firmware-download',
    title: 'Samsung Firmware Download',
    category: 'samsung',
    brand: 'Samsung',
    sales: 12,
    type: 'file',
  },
  {
    slug: 'samsung-mobile-unlock-code',
    title: 'Samsung Mobile Unlock Code',
    category: 'samsung',
    brand: 'Samsung',
    sales: 33,
    type: 'imei',
  },
  {
    slug: 'iphone-14-network-unlock',
    title: 'iPhone 14 Network Check',
    category: 'apple',
    brand: 'Apple',
    sales: 40,
    type: 'imei',
  },
  {
    slug: 'iphone-mdm-bypass',
    title: 'iPhone MDM Bypass',
    category: 'apple',
    brand: 'Apple',
    sales: 48,
    type: 'remote',
  },
  {
    slug: 'iphone-warranty-check',
    title: 'Apple Warranty and Activation Check',
    category: 'apple',
    brand: 'Apple',
    sales: 42,
    type: 'imei',
  },
  {
    slug: 'iphone-carrier-check',
    title: 'iPhone Carrier and SIM-Lock Check',
    category: 'apple',
    brand: 'Apple',
    sales: 38,
    type: 'imei',
  },
  {
    slug: 'iphone-13-find-my-check',
    title: 'iPhone 13 Find My Status Check',
    category: 'apple',
    brand: 'Apple',
    sales: 21,
    type: 'imei',
  },
  {
    slug: 'ipad-passcode-removal',
    title: 'iPad Passcode Removal',
    category: 'apple',
    brand: 'Apple',
    sales: 10,
    type: 'remote',
  },
  {
    slug: 'oppo-frp-remove',
    title: 'Oppo FRP Remove for Android',
    category: 'android',
    brand: 'Oppo',
    sales: 26,
    type: 'remote',
  },
  {
    slug: 'vivo-frp-remove',
    title: 'Vivo FRP Remove (1-24 hours)',
    category: 'android',
    brand: 'Vivo',
    sales: 24,
    type: 'remote',
  },
  {
    slug: 'realme-frp-remove',
    title: 'Realme FRP Remove',
    category: 'android',
    brand: 'Realme',
    sales: 19,
    type: 'remote',
  },
  {
    slug: 'xiaomi-bootloader-unlock',
    title: 'Xiaomi Bootloader Unlock',
    category: 'android',
    brand: 'Xiaomi',
    sales: 65,
    type: 'remote',
  },
  {
    slug: 'xiaomi-imei-repair',
    title: 'Xiaomi IMEI Repair',
    category: 'android',
    brand: 'Xiaomi',
    sales: 14,
    type: 'remote',
  },
  {
    slug: 'huawei-id-removal',
    title: 'Huawei ID Removal',
    category: 'android',
    brand: 'Huawei',
    sales: 17,
    type: 'remote',
  },
  {
    slug: 'lg-network-unlock',
    title: 'LG Network Unlock Code',
    category: 'android',
    brand: 'LG',
    sales: 13,
    type: 'imei',
  },
  {
    slug: 'sony-xperia-unlock',
    title: 'Sony Xperia Bootloader Unlock',
    category: 'android',
    brand: 'Sony',
    sales: 11,
    type: 'server',
  },
  {
    slug: 'nokia-unlock-code',
    title: 'Nokia Unlock Code',
    category: 'android',
    brand: 'Nokia',
    sales: 9,
    type: 'imei',
  },
  {
    slug: 'oneplus-bootloader',
    title: 'OnePlus Bootloader Unlock Token',
    category: 'android',
    brand: 'OnePlus',
    sales: 23,
    type: 'server',
  },
  {
    slug: 'tecno-frp-remove',
    title: 'Tecno Infinix FRP Remove',
    category: 'android',
    brand: 'Tecno',
    sales: 29,
    type: 'remote',
  },
  {
    slug: 'motorola-bootloader',
    title: 'Motorola Bootloader Unlock Data',
    category: 'android',
    brand: 'Motorola',
    sales: 8,
    type: 'server',
  },
  {
    slug: 'verizon-usa-unlock',
    title: 'Verizon USA Network Unlock',
    category: 'carrier',
    carrier: 'Verizon',
    country: 'US',
    sales: 52,
    type: 'imei',
  },
  {
    slug: 'sprint-usa-unlock',
    title: 'Sprint USA Network Unlock',
    category: 'carrier',
    carrier: 'Sprint',
    country: 'US',
    sales: 27,
    type: 'imei',
  },
  {
    slug: 'o2-ireland-unlock',
    title: 'O2 Ireland Network Unlock',
    category: 'carrier',
    carrier: 'O2',
    country: 'IE',
    sales: 44,
    type: 'imei',
  },
  {
    slug: 'three-ireland-unlock',
    title: 'Three Ireland Network Unlock',
    category: 'carrier',
    carrier: 'Three',
    country: 'IE',
    sales: 36,
    type: 'imei',
  },
  {
    slug: 'orange-france-unlock',
    title: 'Orange France Network Unlock',
    category: 'carrier',
    carrier: 'Orange',
    country: 'FR',
    sales: 20,
    type: 'imei',
  },
  {
    slug: 'telus-canada-unlock',
    title: 'Telus Canada Network Unlock',
    category: 'carrier',
    carrier: 'Telus',
    country: 'CA',
    sales: 31,
    type: 'imei',
  },
  {
    slug: 'rogers-canada-unlock',
    title: 'Rogers Canada Network Unlock',
    category: 'carrier',
    carrier: 'Rogers',
    country: 'CA',
    sales: 32,
    type: 'imei',
  },
  {
    slug: 'claro-mexico-unlock',
    title: 'Claro Mexico Network Unlock',
    category: 'carrier',
    carrier: 'Claro',
    country: 'MX',
    sales: 15,
    type: 'imei',
  },
  { slug: 'sim-lock-status-check', title: 'SIM Lock Status Check', category: 'tools', sales: 46, type: 'imei' },
  { slug: 'phone-model-lookup', title: 'Phone Model Lookup by IMEI', category: 'tools', sales: 34, type: 'imei' },
  {
    slug: 'samsung-warranty-lookup',
    title: 'Samsung Warranty Lookup',
    category: 'tools',
    brand: 'Samsung',
    sales: 37,
    type: 'imei',
  },
  { slug: 'dhru-credits-topup', title: 'Dhru Fusion Credits Top Up', category: 'tools', sales: 5, type: 'server' },
  { slug: 'z3x-box-activation', title: 'Z3X Box Activation', category: 'tools', sales: 7, type: 'server' },
  { slug: 'unlocktool-credits', title: 'UnlockTool License Credits', category: 'tools', sales: 6, type: 'server' },
  { slug: 'chimera-tool-credits', title: 'Chimera Tool Credits', category: 'tools', sales: 4, type: 'server' },
  {
    slug: 'blackberry-unlock-code',
    title: 'BlackBerry Unlock Code',
    category: 'android',
    brand: 'BlackBerry',
    sales: 3,
    type: 'imei',
  },
  { slug: 'htc-unlock-code', title: 'HTC Unlock Code', category: 'android', brand: 'HTC', sales: 2, type: 'imei' },
];

/** The fixture services in id order (the id of the first is 1). */
export const FIXTURE: readonly FixtureService[] = ROWS.map((row, index) => ({
  slug: row.slug,
  source: {
    serviceId: index + 1,
    type: row.type ?? 'imei',
    serviceName: row.serviceName ?? row.title,
    categoryId: FIXTURE_CATEGORIES[row.category].id,
    categoryName: FIXTURE_CATEGORIES[row.category].name,
    title: row.title,
    summary: row.summary ?? '',
    brand: row.brand ?? '',
    carrier: row.carrier ?? '',
    country: row.country ?? '',
    isFeatured: row.featured ?? false,
    sort: index,
    sales30d: row.sales ?? 1,
    listedAt: null,
    createdAt: CREATED,
    networks: row.networks ?? [],
    models: row.models ?? [],
    inStock: row.inStock ?? false,
  },
}));

/** The numeric id of a fixture service by its slug. */
const IDS = new Map(FIXTURE.map((entry) => [entry.slug, entry.source.serviceId]));

/**
 * The id of a fixture service.
 *
 * @param slug the slug the golden table names
 * @returns its service id
 * @throws {Error} for a slug the fixture does not hold
 */
export function fixtureId(slug: string): number {
  const id = IDS.get(slug);
  if (id === undefined) throw new Error(`The fixture has no service "${slug}".`);
  return id;
}

/**
 * The slug of a fixture service.
 *
 * @param id the numeric id (a distractor has none)
 * @returns the slug, or the id as text for a generated distractor
 */
export function fixtureSlug(id: number | string): string {
  return FIXTURE.find((entry) => String(entry.source.serviceId) === String(id))?.slug ?? String(id);
}

/** The highest `sales30d` of the fixture (distractors reach 10 times it). */
export const FIXTURE_MAX_SALES = Math.max(...FIXTURE.map((entry) => entry.source.sales30d));

/** The owner's five synonyms (plan section 4.6), in the shape `synonymItems` takes. */
export const FIXTURE_SYNONYMS: ReadonlyArray<{
  readonly id: number;
  readonly kind: 'multi';
  readonly root: null;
  readonly terms: string[];
  readonly isEnabled: true;
}> = [
  ['frp', 'google account lock', 'frp lock'],
  ['icloud', 'activation lock', 'icloud lock'],
  ['unlock', 'network unlock', 'carrier unlock', 'sim unlock'],
  ['imei check', 'blacklist check', 'gsma check', 'clean check'],
  ['kg lock', 'knox guard', 'knox guard lock'],
].map((terms, index) => ({ id: index + 1, kind: 'multi' as const, root: null, terms, isEnabled: true as const }));
