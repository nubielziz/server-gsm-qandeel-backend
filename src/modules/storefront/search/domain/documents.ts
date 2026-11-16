// The services documents of the storefront search (feature 29, plan section 4.1-4.3): one public, English, price-free document per
// searchable service, built from Postgres facts, with the hash the reconcile compares. Pure.
import { createHash } from 'node:crypto';
import { countryNames } from './countries';
import { cleanDisplay, cleanFact, extractCodes, normaliseText, typoSafe, wordWindows } from './normalise';
import type { ServiceDocument } from './services-schema';

/** The most network labels per document. */
export const MAX_NETWORKS = 50;
/** The most model labels per document. */
export const MAX_MODELS = 200;
/** The longest summary indexed. */
export const MAX_SUMMARY = 300;

/**
 * What Postgres says about one searchable service: its English listing, the catalog facts the shop may show, its option labels and
 * whether it is in stock.
 *
 * Why: decision 038: a document carries nothing else; `serviceName` (the internal name, never shown) only gives its model codes
 * (owner question 15).
 */
export interface DocumentSource {
  readonly serviceId: number;
  readonly type: string;
  /** The internal service name: only its model codes are indexed. */
  readonly serviceName: string;
  readonly categoryId: number;
  readonly categoryName: string;
  /** The English listing. */
  readonly title: string;
  readonly summary: string;
  readonly brand: string;
  readonly carrier: string;
  /** ISO-2, or `''`. */
  readonly country: string;
  readonly isFeatured: boolean;
  readonly sort: number;
  readonly sales30d: number;
  /** First publication of the English listing; `createdAt` stands in when it was never set. */
  readonly listedAt: Date | null;
  readonly createdAt: Date;
  /** Labels of the `network` option list. */
  readonly networks: readonly string[];
  /** Labels of the `model` option list. */
  readonly models: readonly string[];
  readonly inStock: boolean;
}

const unique = (values: readonly string[], max: number): string[] =>
  [...new Set(values.filter((value) => value !== ''))].slice(0, max);

/**
 * The hash of a document: sha1 of its fields in a fixed order (every field but `hash`).
 *
 * Why: plan section 4.5: the reconcile exports `id,hash` from the index and compares them with the hashes of the documents Postgres
 * gives now; any difference becomes a `search_sync` job.
 *
 * @param document the document without its hash
 * @returns the hex sha1
 */
export function documentHash(document: Omit<ServiceDocument, 'hash'>): string {
  const ordered = Object.keys(document)
    .sort()
    .map((key) => [key, (document as Record<string, unknown>)[key]]);
  return createHash('sha1').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Builds the document of one searchable service.
 *
 * Why: plan section 4.2-4.3 with the step 0 rule: `title` keeps the shown title (searched with no typos); every field searched with
 * typos (`title_words`, `summary`, `brand`, `carrier`, `networks`, `country_names`, `category`) holds no token with a digit, and the
 * codes are read from the title, the internal name, the model labels, the brand, the carrier, the network labels and the category.
 * Empty optional fields are left out.
 *
 * @param source the service's facts from Postgres
 * @returns the document with its hash
 */
export function buildServiceDocument(source: DocumentSource): ServiceDocument {
  const title = cleanDisplay(source.title);
  const brand = cleanFact(source.brand);
  const carrier = cleanFact(source.carrier);
  const country = source.country.trim().toUpperCase();
  const networks = unique(
    source.networks.map((label) => typoSafe(normaliseText(label))),
    MAX_NETWORKS,
  );
  const models = unique(
    source.models.map((label) => normaliseText(label)),
    MAX_MODELS,
  );
  const codes = extractCodes([
    title,
    source.serviceName,
    ...source.models,
    brand,
    carrier,
    ...source.networks,
    source.categoryName,
  ]);
  const joins = wordWindows(title);
  const titleWords = typoSafe(normaliseText(title));
  const summary = typoSafe(cleanDisplay(source.summary).slice(0, MAX_SUMMARY));
  const brandSafe = typoSafe(brand);
  const carrierSafe = typoSafe(carrier);
  const names = unique(countryNames(country).map(typoSafe), 20);
  const listedAt = source.listedAt ?? source.createdAt;

  const document: Omit<ServiceDocument, 'hash'> = {
    id: String(source.serviceId),
    title,
    ...(titleWords === '' ? {} : { title_words: titleWords }),
    title_sort: normaliseText(title),
    ...(summary === '' ? {} : { summary }),
    ...(brandSafe === '' ? {} : { brand: brandSafe }),
    ...(carrierSafe === '' ? {} : { carrier: carrierSafe }),
    ...(brand === '' ? {} : { brand_key: brand.toLowerCase() }),
    ...(carrier === '' ? {} : { carrier_key: carrier.toLowerCase() }),
    ...(country === '' ? {} : { country }),
    ...(names.length === 0 ? {} : { country_names: names }),
    ...(networks.length === 0 ? {} : { networks }),
    category: typoSafe(cleanDisplay(source.categoryName)),
    category_id: source.categoryId,
    type: source.type,
    ...(codes.length === 0 ? {} : { codes }),
    ...(joins.length === 0 ? {} : { joins }),
    ...(models.length === 0 ? {} : { models }),
    popularity: Math.max(0, Math.min(2_147_483_647, Math.floor(source.sales30d))),
    featured: source.isFeatured,
    in_stock: source.inStock,
    sort: Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.floor(source.sort))),
    listed_at: Math.floor(listedAt.getTime() / 1000),
  };
  return { ...document, hash: documentHash(document) };
}
