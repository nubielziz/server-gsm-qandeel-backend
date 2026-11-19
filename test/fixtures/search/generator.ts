// The generator of distractor services (feature 29, slice B2, plan section 8): realistic English names, seeded, with sales up to 10
// times the fixture's, so a golden case or a load run has thousands of services that share words with the queries but are not the
// service the case expects. Shared by `test/integration/storefront/search-golden.test.ts` and `test/load/search.ts`.
//
// Reserved combinations: a distractor never holds all the words of one entry of {@link RESERVED}: those words belong together only in
// the fixture's hand-written services (a generated "Samsung FRP Bypass 2" at 10 times the sales is not a worse match for the query
// `samsung frp`, it is a second right answer, and a golden set cannot tell two right answers apart). Everything else is allowed.
import type { DocumentSource } from '@src/modules/storefront/search/domain/documents';
import { normaliseText } from '@src/modules/storefront/search/domain/normalise';
import { FIXTURE_CATEGORIES, FIXTURE_MAX_SALES } from './catalog';

/** The word sets only the fixture's own services hold together. */
export const RESERVED: ReadonlyArray<readonly string[]> = [
  ['samsung', 'frp'],
  ['google', 'account'],
  ['icloud'],
  ['activation', 'lock'],
  ['iphone', 'unlock'],
  ['iphone', '15'],
  ['att'],
  ['tmobile'],
  ['vodafone'],
  ['ee'],
  ['imei', 'check'],
  ['blacklist'],
  ['gsma'],
  ['clean', 'check'],
  ['knox'],
  ['kg'],
  ['xiaomi', 'account'],
  ['huawei', 'frp'],
  ['frp', 'bypass'],
  ['pixel'],
  ['a52'],
  ['a52s'],
  ['sma525f'],
  ['sma528b'],
  ['sm-a525f'],
  ['sm-a528b'],
  ['sm-g99'],
  ['uk', 'unlock'],
  ['united', 'kingdom'],
  ['usa', 'iphone'],
];

/**
 * Tells whether a title holds all the words of a reserved combination.
 *
 * @param title a generated title
 * @returns true when the generator must not emit it
 */
export function isReserved(title: string): boolean {
  const words = normaliseText(title).replace(/-/g, '').split(' ');
  const raw = normaliseText(title).split(' ');
  return RESERVED.some((entry) => entry.every((word) => words.includes(word.replace(/-/g, '')) || raw.includes(word)));
}

/** A seeded pseudo-random source (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS: ReadonlyArray<readonly [string, number]> = [
  ['Samsung', 26],
  ['Apple', 14],
  ['Huawei', 8],
  ['Xiaomi', 8],
  ['Oppo', 6],
  ['Vivo', 6],
  ['Realme', 4],
  ['Motorola', 4],
  ['Nokia', 3],
  ['LG', 3],
  ['Sony', 3],
  ['OnePlus', 3],
  ['Tecno', 3],
  ['Infinix', 3],
  ['ZTE', 2],
  ['Alcatel', 2],
  ['Lenovo', 2],
  ['Honor', 2],
  ['HTC', 1],
  ['Asus', 1],
];

const SERVICES = [
  'Bootloader Unlock',
  'Network Unlock Code',
  'Mobile Unlock Code',
  'IMEI Repair',
  'Firmware Download',
  'MDM Removal',
  'Account Removal',
  'Security Patch Update',
  'Root Service',
  'Flash Service Remote',
  'Remote Repair Session',
  'Screen Lock Removal',
  'Factory Reset Service',
  'Software Activation',
  'Warranty Status Lookup',
  'Region Change Service',
  'Dual SIM Fix',
  'Baseband Repair',
];

const APPLE_SERVICES = [
  'MDM Bypass',
  'Activation Status Check',
  'Warranty Check',
  'Passcode Removal Remote',
  'Carrier Status Check',
  'Find My Status Check',
  'Battery Health Report',
  'Serial Number Lookup',
  'Replacement Status Check',
  'Region Lock Check',
];

const FRP_BRANDS = [
  'Oppo',
  'Vivo',
  'Realme',
  'Motorola',
  'Nokia',
  'LG',
  'Sony',
  'Tecno',
  'Infinix',
  'ZTE',
  'Alcatel',
  'Lenovo',
  'Honor',
  'Asus',
];

const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ['Verizon', 'US'],
  ['Sprint', 'US'],
  ['Cricket', 'US'],
  ['MetroPCS', 'US'],
  ['Rogers', 'CA'],
  ['Telus', 'CA'],
  ['Bell', 'CA'],
  ['O2', 'GB'],
  ['Three', 'GB'],
  ['Orange', 'FR'],
  ['SFR', 'FR'],
  ['Movistar', 'ES'],
  ['Telekom', 'DE'],
  ['TIM', 'IT'],
  ['Claro', 'MX'],
  ['Telcel', 'MX'],
  ['Vivo Brasil', 'BR'],
  ['Optus', 'AU'],
  ['Telstra', 'AU'],
  ['Swisscom', 'CH'],
];

const COUNTRY_WORDS: Readonly<Record<string, string>> = {
  US: 'USA',
  CA: 'Canada',
  FR: 'France',
  ES: 'Spain',
  DE: 'Germany',
  IT: 'Italy',
  MX: 'Mexico',
  BR: 'Brazil',
  AU: 'Australia',
  CH: 'Switzerland',
  GB: 'UK',
};

const SUMMARY_PARTS = [
  'Works with any model of the brand.',
  'Delivered after the order is processed.',
  'Needs the IMEI of the phone.',
  'Done remotely, no cable needed.',
  'Results are sent to your email.',
  'Supports the newest software versions.',
];

const IPHONES = ['11', '12', '13', '14', '16'];
const IPHONE_VARIANTS = ['', ' Pro', ' Pro Max', ' Plus', ' Mini'];
const GALAXY_LINES = ['A', 'M', 'F', 'S', 'N'];
const SUFFIX_LETTERS = ['B', 'F', 'U', 'N', 'E'];

/** What {@link generateDistractors} takes. */
export interface GeneratorOptions {
  /** How many services. */
  readonly count: number;
  /** The seed: the same seed gives the same services. */
  readonly seed: number;
  /** The id of the first service (default 100 000, far above the fixture's). */
  readonly firstId?: number;
  /** The highest `sales30d` (default 10 times the fixture's highest). */
  readonly maxSales?: number;
}

/**
 * Generates distractor services.
 *
 * @param options how many, from which seed
 * @returns the services as document sources, ids ascending; none holds a reserved combination
 */
export function generateDistractors(options: GeneratorOptions): DocumentSource[] {
  const random = seeded(options.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const weighted = (): string => {
    const total = BRANDS.reduce((sum, [, weight]) => sum + weight, 0);
    let at = random() * total;
    for (const [brand, weight] of BRANDS) {
      at -= weight;
      if (at < 0) return brand;
    }
    return 'Samsung';
  };
  const modelCode = (): string => {
    for (;;) {
      const line = pick(GALAXY_LINES);
      const number = String(100 + Math.floor(random() * 900));
      const code = `SM-${line}${number}${pick(SUFFIX_LETTERS)}`;
      const lower = code.toLowerCase();
      if (!lower.startsWith('sm-a52') && !lower.startsWith('sm-g99')) return code;
    }
  };
  const maxSales = options.maxSales ?? FIXTURE_MAX_SALES * 10;
  const out: DocumentSource[] = [];
  const firstId = options.firstId ?? 100_000;
  const base = new Date('2026-02-01T09:00:00.000Z');
  while (out.length < options.count) {
    const family = random();
    let title: string;
    let brand = '';
    let carrier = '';
    let country = '';
    let category: keyof typeof FIXTURE_CATEGORIES;
    let type: DocumentSource['type'] = 'imei';
    let models: string[] = [];
    if (family < 0.45) {
      brand = weighted();
      const service = brand === 'Apple' ? pick(APPLE_SERVICES) : pick(SERVICES);
      const device =
        brand === 'Apple'
          ? `iPhone ${pick(IPHONES)}${pick(IPHONE_VARIANTS)}`
          : brand === 'Samsung'
            ? `Galaxy ${pick(GALAXY_LINES)}${10 + Math.floor(random() * 90)}`
            : '';
      const code = brand === 'Samsung' && random() < 0.6 ? ` (${modelCode()})` : '';
      title = [brand === 'Apple' ? '' : brand, device, service]
        .filter((part) => part !== '')
        .join(' ')
        .concat(code);
      category = brand === 'Samsung' ? 'samsung' : brand === 'Apple' ? 'apple' : 'android';
      type = random() < 0.5 ? 'remote' : 'imei';
      if (brand === 'Samsung' && random() < 0.15) models = [modelCode(), modelCode()].map((c) => `Galaxy (${c})`);
    } else if (family < 0.6) {
      brand = pick(FRP_BRANDS);
      title = `${brand} FRP ${pick(['Remove', 'Reset', 'Remote Removal', 'Unlock Service'])}`;
      category = 'android';
      type = 'remote';
    } else if (family < 0.85) {
      const [name, code] = pick(CARRIERS);
      carrier = name;
      country = code;
      title =
        `${name} ${COUNTRY_WORDS[code] ?? ''} ${pick(['Network Unlock', 'Unlock Code', 'SIM Unlock Service', 'Premium Unlock'])}`.replace(
          /\s+/g,
          ' ',
        );
      category = 'carrier';
    } else {
      title = `${pick(['Z3X', 'Octoplus', 'Miracle', 'Sigma', 'UMT', 'Chimera', 'Avengers'])} ${pick(['Box', 'Dongle', 'Pack'])} ${pick(['Activation', 'Credits', 'License Renewal'])}`;
      category = 'tools';
      type = 'server';
    }
    if (isReserved(title)) continue;
    const index = out.length;
    // Sales follow a long tail: most services sell little, a few sell up to the ceiling.
    const sales = Math.floor(maxSales * random() ** 3);
    out.push({
      serviceId: firstId + index,
      type,
      serviceName: title,
      categoryId: FIXTURE_CATEGORIES[category].id,
      categoryName: FIXTURE_CATEGORIES[category].name,
      title,
      summary: random() < 0.5 ? pick(SUMMARY_PARTS) : '',
      brand,
      carrier,
      country,
      isFeatured: random() < 0.02,
      sort: index,
      sales30d: sales,
      listedAt: null,
      createdAt: base,
      networks: [],
      models,
      inStock: random() < 0.2,
    });
  }
  return out;
}
