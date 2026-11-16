// The index vocabulary of the storefront search (feature 29, plan section 4.4): every word the indexed catalog holds. A popular query
// is kept only when each of its words is one of them. Pure.
import { extractCodes, normaliseText } from './normalise';

/** The texts of one indexed service that feed the vocabulary. */
export interface VocabularySource {
  readonly title: string;
  readonly brand: string;
  readonly carrier: string;
  readonly networks: readonly string[];
  readonly categoryName: string;
  /** Country names and aliases (normalised). */
  readonly countryNames: readonly string[];
  /** The model codes of the document. */
  readonly codes: readonly string[];
}

/**
 * Builds the vocabulary: the words of indexed titles, brands, carriers, networks, country names, categories, code words and enabled
 * synonym terms.
 *
 * Why: plan section 4.4: words found only through a typo are not in it, so a query becomes popular only with words the catalog really
 * holds, whatever visitors type.
 *
 * @param services the indexed services' texts
 * @param synonymTerms the terms (and roots) of every enabled synonym
 * @returns the set of normalised words
 */
export function buildVocabulary(services: readonly VocabularySource[], synonymTerms: readonly string[]): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => {
    for (const word of normaliseText(text).split(' ')) if (word !== '') words.add(word);
  };
  for (const service of services) {
    add(service.title);
    add(service.brand);
    add(service.carrier);
    add(service.categoryName);
    for (const network of service.networks) add(network);
    for (const name of service.countryNames) add(name);
    for (const code of service.codes) add(code);
    for (const code of extractCodes([service.title])) add(code);
  }
  for (const term of synonymTerms) add(term);
  return words;
}
