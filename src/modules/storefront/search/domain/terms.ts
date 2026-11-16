// The terms collection of the storefront search (feature 29, plan section 4.4): phrase completion. One document per normalised phrase,
// built in full from the indexed titles, the facet values, the enabled synonyms and the popular queries. Pure.
import { createHash } from 'node:crypto';
import type { CollectionField, CollectionSchema } from '../../../../infra/search';
import { cleanDisplay, normaliseText } from './normalise';

/**
 * The version of the terms schema: any change of a field, a type or a collection option bumps it.
 *
 * Why: plan section 3.3: the terms alias carries the version like the services alias.
 */
export const TERMS_SCHEMA_VERSION = 1;

/**
 * Where a phrase comes from, highest priority first.
 *
 * Why: plan section 4.4: one document per phrase, whose kind is the highest of its sources (a brand that is also a title phrase is a
 * brand); the site labels completions by kind.
 */
export const TERM_KINDS = ['brand', 'carrier', 'category', 'country', 'title', 'synonym', 'query'] as const;

/** One value of {@link TERM_KINDS}. */
export type TermKind = (typeof TERM_KINDS)[number];

/** One document of the terms collection. */
export interface TermDocument {
  /** sha1 of `q`. */
  readonly id: string;
  /** The normalised phrase. */
  readonly q: string;
  readonly kind: TermKind;
  readonly weight: number;
  /** How many indexed services hold the phrase (0 for a synonym or query phrase no service holds). */
  readonly services: number;
  /** Characters of `q` (ties of the completion search: the shorter phrase first). */
  readonly length: number;
}

/** The fields of the terms collection. */
export const TERM_FIELDS: readonly CollectionField[] = [
  { name: 'q', type: 'string' },
  { name: 'kind', type: 'string', facet: true },
  { name: 'weight', type: 'int32' },
  { name: 'services', type: 'int32' },
  { name: 'length', type: 'int32' },
];

/**
 * The schema of a new terms collection.
 *
 * @param name the collection name (`<prefix>terms_v<N>_<stamp>`)
 * @returns the schema for `POST /collections`
 */
export function termsSchema(name: string): CollectionSchema {
  return { name, fields: TERM_FIELDS, default_sorting_field: 'weight' };
}

/**
 * Words a completion never starts or ends with (`unlock for`, `the iphone`).
 *
 * Why: plan section 4.4: such phrases are noise in a suggestion list.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'with',
  'via',
  'by',
  'in',
  'on',
  'or',
  'all',
  'any',
  'only',
  'from',
]);

/** The largest weight Typesense's int32 holds. */
export const MAX_WEIGHT = 2_147_483_647;
/** The longest phrase kept. */
export const MAX_PHRASE_LENGTH = 100;
/** The most words of a phrase. */
export const MAX_PHRASE_WORDS = 4;

const SEGMENT_BREAK = /[()[\]{}|,;:/]| [-–—] /;

/**
 * Tells whether a normalised phrase may be a completion: at least two characters, at least one letter, at most
 * {@link MAX_PHRASE_LENGTH} characters.
 *
 * @param phrase a normalised phrase
 * @returns false for one character, digits only, or too long
 */
export function isPhrase(phrase: string): boolean {
  return phrase.length >= 2 && phrase.length <= MAX_PHRASE_LENGTH && /\p{L}/u.test(phrase);
}

/**
 * The phrases of a display title: every window of 1-4 words inside a segment.
 *
 * Why: plan section 4.4: the title is cut into segments at brackets, `| , ; : /` and ` - ` before it is normalised, so
 * `Samsung FRP (1-24 hours)` gives `samsung frp` and `1-24 hours` and never `frp 1-24`; a phrase that starts or ends with a stop word
 * is left out.
 *
 * @param title the display title
 * @returns the phrases, deduplicated, in reading order
 */
export function titlePhrases(title: string): string[] {
  const phrases = new Set<string>();
  for (const segment of cleanDisplay(title).split(SEGMENT_BREAK)) {
    const words = normaliseText(segment)
      .split(' ')
      .filter((word) => word !== '');
    for (let start = 0; start < words.length; start += 1) {
      for (let size = 1; size <= MAX_PHRASE_WORDS && start + size <= words.length; size += 1) {
        const window = words.slice(start, start + size);
        if (STOP_WORDS.has(window[0]!) || STOP_WORDS.has(window[window.length - 1]!)) continue;
        const phrase = window.join(' ');
        if (isPhrase(phrase)) phrases.add(phrase);
      }
    }
  }
  return [...phrases];
}

/** What the terms build knows about one indexed service. */
export interface TermService {
  /** The display title. */
  readonly title: string;
  readonly popularity: number;
  readonly brand: string;
  readonly carrier: string;
  readonly networks: readonly string[];
  readonly categoryName: string;
  /** The English name of the listing's country, or `''`. */
  readonly countryName: string;
}

/** A popular query that passed the counting rules, with its 30-day visitor count. */
export interface TermQuery {
  readonly term: string;
  readonly visitors: number;
}

/** One enabled synonym. */
export interface TermSynonym {
  readonly terms: readonly string[];
  readonly root: string | null;
}

/** Everything one terms build reads. */
export interface TermsInput {
  readonly services: readonly TermService[];
  readonly synonyms: readonly TermSynonym[];
  /** Queries already eligible (see {@link isPopularQuery}). */
  readonly queries: readonly TermQuery[];
}

interface Entry {
  kind: TermKind;
  weight: number;
  services: number;
}

const rank = (kind: TermKind) => TERM_KINDS.indexOf(kind);
const capped = (value: number) => Math.min(MAX_WEIGHT, Math.max(0, Math.floor(value)));

/**
 * Builds every document of the terms collection.
 *
 * Why: plan section 4.4. One document per phrase: its weight is the highest of its sources and its kind the highest by
 * {@link TERM_KINDS}. Weights: a title phrase sums `popularity + 1` over the services that hold it; a facet value (brand, carrier
 * and network labels, category names, country English names, never the code) is its service count x 10; a synonym phrase takes the
 * weight of the best term of its group that the catalog holds, or 10; a popular query is its 30-day visitor count x 10.
 *
 * @param input the indexed services, the enabled synonyms and the eligible popular queries
 * @returns the documents, sorted by phrase
 */
export function buildTerms(input: TermsInput): TermDocument[] {
  const entries = new Map<string, Entry>();
  const offer = (phrase: string, kind: TermKind, weight: number, services: number) => {
    if (!isPhrase(phrase)) return;
    const entry = entries.get(phrase);
    if (!entry) {
      entries.set(phrase, { kind, weight: capped(weight), services });
      return;
    }
    if (rank(kind) < rank(entry.kind)) entry.kind = kind;
    entry.weight = Math.max(entry.weight, capped(weight));
    entry.services = Math.max(entry.services, services);
  };

  const titles = new Map<string, { weight: number; services: number }>();
  const facets = new Map<string, { kind: TermKind; services: number }>();
  const facet = (value: string, kind: TermKind, seen: Set<string>) => {
    const phrase = normaliseText(value);
    const key = `${kind}:${phrase}`;
    if (phrase === '' || seen.has(key)) return;
    seen.add(key);
    const current = facets.get(key) ?? { kind, services: 0 };
    current.services += 1;
    facets.set(key, current);
  };
  for (const service of input.services) {
    for (const phrase of titlePhrases(service.title)) {
      const current = titles.get(phrase) ?? { weight: 0, services: 0 };
      current.weight = capped(current.weight + Math.max(0, service.popularity) + 1);
      current.services += 1;
      titles.set(phrase, current);
    }
    const seen = new Set<string>();
    facet(service.brand, 'brand', seen);
    facet(service.carrier, 'carrier', seen);
    for (const network of service.networks) facet(network, 'carrier', seen);
    facet(service.categoryName, 'category', seen);
    facet(service.countryName, 'country', seen);
  }
  for (const [phrase, { weight, services }] of titles) offer(phrase, 'title', weight, services);
  for (const [key, { kind, services }] of facets) offer(key.slice(kind.length + 1), kind, services * 10, services);

  for (const synonym of input.synonyms) {
    const phrases = [...synonym.terms, ...(synonym.root ? [synonym.root] : [])]
      .map((term) => normaliseText(term))
      .filter(isPhrase);
    const known = phrases.map((phrase) => entries.get(phrase)?.weight ?? 0);
    const best = Math.max(10, ...known);
    for (const phrase of phrases) offer(phrase, 'synonym', best, entries.get(phrase)?.services ?? 0);
  }
  for (const query of input.queries) {
    const phrase = normaliseText(query.term);
    offer(phrase, 'query', query.visitors * 10, entries.get(phrase)?.services ?? 0);
  }

  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([q, entry]) => ({
      id: termId(q),
      q,
      kind: entry.kind,
      weight: entry.weight,
      services: entry.services,
      length: q.length,
    }));
}

/**
 * The id of a phrase's document.
 *
 * @param q the normalised phrase
 * @returns sha1 of the phrase, hex
 */
export function termId(q: string): string {
  return createHash('sha1').update(q).digest('hex');
}

/** What the daily counts say about one searched term over 30 days. */
export interface PopularCandidate {
  readonly term: string;
  /** Distinct visitors summed over the days (the weight of the query). */
  readonly visitors: number;
  /** Days with at least {@link POPULAR_MIN_VISITORS} distinct visitors. */
  readonly busyDays: number;
  readonly searches: number;
  readonly zeroResults: number;
}

/** Distinct visitors a day must have to count (5). */
export const POPULAR_MIN_VISITORS = 5;
/** Days with that many visitors a term needs within 30 days (3). */
export const POPULAR_MIN_DAYS = 3;

/**
 * Tells whether a searched term becomes a popular query.
 *
 * Why: plan section 4.4 and owner question 4: at least 5 different visitors on each of at least 3 days in 30 days, fewer than half of
 * its searches without results, not hidden by staff, 1-4 words, and every word a word the catalog holds (the index vocabulary), so an
 * injected phrase (`cheap unlock scam site`) never reaches the completions.
 *
 * @param candidate the term and its 30-day figures
 * @param vocabulary the index vocabulary (see `vocabulary.ts`)
 * @param hidden the terms staff hid
 * @returns true when the term is a popular query
 */
export function isPopularQuery(
  candidate: PopularCandidate,
  vocabulary: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): boolean {
  const term = normaliseText(candidate.term);
  if (!isPhrase(term) || hidden.has(term)) return false;
  if (candidate.busyDays < POPULAR_MIN_DAYS) return false;
  if (candidate.searches <= 0 || candidate.zeroResults * 2 >= candidate.searches) return false;
  const words = term.split(' ');
  if (words.length > MAX_PHRASE_WORDS) return false;
  return words.every((word) => vocabulary.has(word));
}

/**
 * The UTC day of a moment as the Redis counter keys write it.
 *
 * Why: plan section 5.6: the counters and the visitor estimates are kept per UTC day (`gsm:{env}:storefront:search-terms:{yyyymmdd}`).
 *
 * @param at the moment
 * @returns `yyyymmdd`
 */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * The UTC day of a moment as `search_terms_daily.day` holds it.
 *
 * @param at the moment
 * @returns `yyyy-mm-dd`
 */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}
