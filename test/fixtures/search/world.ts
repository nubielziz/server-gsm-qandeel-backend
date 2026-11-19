// Builds the golden world in the Typesense node: the fixture catalog plus distractors indexed into a services and a terms collection
// behind aliases, with the owner's synonyms and the fixture's pins, under a name prefix the caller owns (feature 29, slice B2). Shared
// by `test/integration/storefront/search-golden.test.ts` and `test/load/search.ts`; it writes only collections, aliases and sets that start with the prefix.
import type { TypesenseClient } from '@src/infra/search';
import { buildServiceDocument } from '@src/modules/storefront/search/domain/documents';
import { countryName } from '@src/modules/storefront/search/domain/countries';
import {
  SearchNames,
  type ServiceDocument,
  servicesSchema,
} from '@src/modules/storefront/search/domain/services-schema';
import { curationItems, synonymItems } from '@src/modules/storefront/search/domain/set-conversion';
import { type TermDocument, buildTerms, termsSchema } from '@src/modules/storefront/search/domain/terms';
import { FIXTURE, FIXTURE_PINS, FIXTURE_SYNONYMS } from './catalog';
import { generateDistractors } from './generator';

/** What {@link buildGoldenWorld} made. */
export interface GoldenWorld {
  readonly names: SearchNames;
  /** The services alias. */
  readonly services: string;
  /** The terms alias. */
  readonly terms: string;
  readonly documents: readonly ServiceDocument[];
  readonly termDocuments: readonly TermDocument[];
}

/** What {@link buildGoldenWorld} takes. */
export interface GoldenOptions {
  /** How many generated distractors to add to the fixture (default 5 000). */
  readonly distractors?: number;
  readonly seed?: number;
  /** Leave the pins out (the load run measures plain search). */
  readonly withoutPins?: boolean;
  /**
   * What the terms collection is built from: the fixture only (default: the completion cases read a catalog of the fixture's size,
   * where phrase weights are the sums of a few services' sales) or every service (the load run).
   */
  readonly termsFrom?: 'fixture' | 'all';
}

const BATCH = 500;

/**
 * Builds the world: sets, collections, documents and aliases.
 *
 * @param client a client with a key that may write under the prefix (the tests' bootstrap client)
 * @param prefix the name prefix (for example `gsm_29_test_ab12cd_golden_`)
 * @param options the number of distractors and the seed
 * @returns the names and what was indexed
 * @throws {SearchUnavailable} | {SearchRejected} when the node refuses a call; an import line the node refuses
 */
export async function buildGoldenWorld(
  client: TypesenseClient,
  prefix: string,
  options: GoldenOptions = {},
): Promise<GoldenWorld> {
  const names = new SearchNames(prefix);
  await client.putSynonymSet(names.synonymSet, synonymItems(FIXTURE_SYNONYMS));
  await client.putCurationSet(names.curationSet, options.withoutPins ? [] : curationItems(FIXTURE_PINS));
  const sources = [
    ...FIXTURE.map((entry) => entry.source),
    ...generateDistractors({ count: options.distractors ?? 5000, seed: options.seed ?? 7 }),
  ];
  const documents = sources.map((source) => buildServiceDocument(source));
  const at = new Date();
  const servicesName = names.collection('services', at);
  await client.createCollection(
    servicesSchema(servicesName, { synonyms: names.synonymSet, curations: names.curationSet }),
  );
  for (let start = 0; start < documents.length; start += BATCH) {
    const outcome = await client.importJsonl(servicesName, documents.slice(start, start + BATCH), 'upsert');
    if (!outcome.ok)
      throw new Error(`The node refused ${outcome.failed.length} documents: ${JSON.stringify(outcome.failed[0])}`);
  }
  const termDocuments = buildTerms({
    services: (options.termsFrom === 'all' ? sources : sources.slice(0, FIXTURE.length)).map((source) => ({
      title: source.title,
      popularity: source.sales30d,
      brand: source.brand,
      carrier: source.carrier,
      networks: source.networks,
      categoryName: source.categoryName,
      countryName: source.country === '' ? '' : (countryName(source.country) ?? ''),
    })),
    synonyms: FIXTURE_SYNONYMS.map((row) => ({ terms: row.terms, root: row.root })),
    queries: [],
  });
  const termsName = names.collection('terms', at);
  await client.createCollection(termsSchema(termsName));
  for (let start = 0; start < termDocuments.length; start += BATCH) {
    const outcome = await client.importJsonl(termsName, termDocuments.slice(start, start + BATCH), 'upsert');
    if (!outcome.ok)
      throw new Error(`The node refused ${outcome.failed.length} terms: ${JSON.stringify(outcome.failed[0])}`);
  }
  await client.putAlias(names.alias('services'), servicesName);
  await client.putAlias(names.alias('terms'), termsName);
  return { names, services: names.alias('services'), terms: names.alias('terms'), documents, termDocuments };
}

/**
 * Drops everything {@link buildGoldenWorld} made under a prefix.
 *
 * @param client the same client
 * @param prefix the same prefix
 */
export async function dropGoldenWorld(client: TypesenseClient, prefix: string): Promise<void> {
  for (const alias of await client.listAliases(prefix)) await client.deleteAlias(alias.name);
  for (const collection of await client.listCollections(prefix)) await client.dropCollection(collection.name);
  const names = new SearchNames(prefix);
  await client.deleteSynonymSet(names.synonymSet);
  await client.deleteCurationSet(names.curationSet);
}
