// The assembly of a suggest answer from the engine's three searches (feature 29, plan section 5.2): the ghost text, the completions,
// the service candidates, the filter chips and the highlighted title. Pure: no engine, no database.
import type { FacetCounts, SearchHit, SearchResult } from '../../../../infra/search';
import { countryName, countryNames } from './countries';
import { didYouMean, fold, matchedTokensOf } from './did-you-mean';
import { type FacetValue, facetValues } from './filters';
import { normaliseText } from './normalise';
import type { TermKind } from './terms';

/** The most completions a suggest shows. */
export const MAX_COMPLETIONS = 6;
/** The most filter chips a suggest shows. */
export const MAX_FILTERS = 4;
/** The shortest query word a filter chip is matched with. */
export const MIN_FILTER_WORD = 2;

/** One completion: a phrase that starts with (or is a typo-near match of) what was typed. */
export interface Completion {
  readonly text: string;
  readonly kind: TermKind;
}

/** The document of one terms hit. */
export interface TermHitDocument {
  readonly q: string;
  readonly kind: TermKind;
}

/**
 * The typed text as the completion rules read it: normalised, plus one space when the raw input ends with whitespace and has text.
 *
 * Why: plan section 5.2: `samsung ` (with the space) asks for the next word, `samsung` asks for the end of this one.
 *
 * @param raw what the visitor typed
 * @returns `p`
 */
export function typedPrefix(raw: string): string {
  const normalised = normaliseText(raw);
  return normalised !== '' && /\s$/.test(raw) ? `${normalised} ` : normalised;
}

/**
 * The ghost text: the rest of the word being typed, of the first phrase that starts with `p` and is longer.
 *
 * Why: plan section 5.2 and golden cases 37, 38, 50, 51: `icl` gives `oud`, `iphone 15 p` gives `ro`, `samsung ` gives `frp` (no double
 * space). The rest is cut at the end of the first word that is still unfinished (or at the end of the next word when `p` ends at a word
 * boundary, keeping the leading space), so Tab completes one word at a time.
 *
 * @param p the typed text (see {@link typedPrefix})
 * @param terms the completion search's hits in the engine's order
 * @returns the ghost, or `null` when no phrase continues `p`
 */
export function ghostOf(p: string, terms: readonly TermHitDocument[]): string | null {
  if (p.trim() === '') return null;
  for (const term of terms) {
    if (term.q.length <= p.length || !term.q.startsWith(p)) continue;
    const rest = term.q.slice(p.length);
    const leading = rest.startsWith(' ') ? ' ' : '';
    const word = rest.trimStart().split(' ')[0] ?? '';
    return word === '' ? null : `${leading}${word}`;
  }
  return null;
}

/**
 * The completions: the terms of the engine without the one equal to what was typed, at most six.
 *
 * @param p the typed text
 * @param terms the completion search's hits in the engine's order
 * @returns the completions (one per phrase: the terms collection holds one document per phrase)
 */
export function completionsOf(p: string, terms: readonly TermHitDocument[]): Completion[] {
  const typed = p.trim();
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const term of terms) {
    if (term.q === typed || seen.has(term.q)) continue;
    seen.add(term.q);
    out.push({ text: term.q, kind: term.kind });
    if (out.length === MAX_COMPLETIONS) break;
  }
  return out;
}

/** A service the engine found, with the document tokens that matched (for the highlight). */
export interface Candidate {
  readonly id: number;
  /** Folded tokens of the title fields that matched. */
  readonly tokens: readonly string[];
}

function titleTokens(hit: SearchHit<{ id: string }>): string[] {
  const only = {
    ...hit,
    highlights: (hit.highlights ?? []).filter((h) => h.field === 'title' || h.field === 'title_words'),
  };
  return [...matchedTokensOf(only)];
}

/**
 * The service candidates of a suggest: the hits of the services search, then the nearby hits that are not among them.
 *
 * Why: plan section 5.2: "nearby" is never an id of the services search; the caller keeps the first six that survive the Postgres
 * re-check, so the list holds every candidate.
 *
 * @param services the services search's answer
 * @param nearby the nearby search's answer
 * @returns the ids in order with the tokens that matched their title
 */
export function mergeCandidates(
  services: SearchResult<{ id: string }>,
  nearby: SearchResult<{ id: string }>,
): Candidate[] {
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const hit of [...services.hits, ...nearby.hits]) {
    const id = Number(hit.document.id);
    if (!Number.isSafeInteger(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, tokens: titleTokens(hit) });
  }
  return out;
}

/** The names the filter chips show, read from Postgres (cached): lower-cased key to label. */
export interface FacetLabels {
  readonly brands: ReadonlyMap<string, string>;
  readonly networks: ReadonlyMap<string, string>;
  readonly categories: ReadonlyMap<number, string>;
}

/** The kind of a filter chip. */
export type FilterKind = 'brand' | 'network' | 'country' | 'category';

/** One filter chip of a suggest. */
export interface SuggestFilter {
  readonly kind: FilterKind;
  /** What the list filter takes: the label (brand, network), the country code, or the category id as text. */
  readonly value: string;
  /** `Brand: Samsung`, `Network: Vodafone`, `Country: United Kingdom`, `Category: Apple Services`. */
  readonly label: string;
  readonly count: number;
}

const KIND_ORDER: readonly FilterKind[] = ['brand', 'network', 'country', 'category'];
const KIND_LABEL: Readonly<Record<FilterKind, string>> = {
  brand: 'Brand',
  network: 'Network',
  country: 'Country',
  category: 'Category',
};

function capitalised(text: string): string {
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * Picks the filter chips of a suggest: the facet values whose name starts with a word of the query.
 *
 * Why: plan section 5.2 and golden case 39: `vod` offers `Network: Vodafone`. Names are compared folded (`T-Mobile` is `tmobile`); a
 * country also matches its aliases (`uk` for United Kingdom). Chips come in the order brand, network, country, category and, inside a
 * kind, by count; at most four.
 *
 * @param query the normalised query
 * @param facets the facet counts of the services search
 * @param labels the display names
 * @returns the chips
 */
export function pickFilters(
  query: string,
  facets: readonly FacetCounts[] | undefined,
  labels: FacetLabels,
): SuggestFilter[] {
  const words = normaliseText(query)
    .split(' ')
    .map(fold)
    .filter((word) => word.length >= MIN_FILTER_WORD);
  if (words.length === 0) return [];
  const startsWithWord = (names: readonly string[]) =>
    names.some((name) => {
      const folded = fold(name);
      return words.some((word) => folded.startsWith(word));
    });
  const out: SuggestFilter[] = [];
  const add = (kind: FilterKind, value: string, name: string, count: number, names: readonly string[]) => {
    if (startsWithWord(names)) out.push({ kind, value, label: `${KIND_LABEL[kind]}: ${name}`, count });
  };
  const text = (kind: 'brand' | 'network', values: readonly FacetValue[], map: ReadonlyMap<string, string>) => {
    for (const { value, count } of values) {
      const name = map.get(value) ?? capitalised(value);
      add(kind, name, name, count, [name]);
    }
  };
  text('brand', facetValues(facets, 'brand_key'), labels.brands);
  text('network', facetValues(facets, 'carrier_key'), labels.networks);
  for (const { value, count } of facetValues(facets, 'country')) {
    const display = countryName(value) ?? value;
    add('country', value, display, count, [display, ...countryNames(value)]);
  }
  for (const { value, count } of facetValues(facets, 'category_id')) {
    const id = Number(value);
    const name = labels.categories.get(id);
    if (name !== undefined) add('category', String(id), name, count, [name]);
  }
  return out
    .map((filter, index) => ({ filter, index }))
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.filter.kind) - KIND_ORDER.indexOf(b.filter.kind) ||
        b.filter.count - a.filter.count ||
        a.index - b.index,
    )
    .slice(0, MAX_FILTERS)
    .map(({ filter }) => filter);
}

const HTML: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes text for HTML.
 *
 * @param text any text
 * @returns the text with `& < > " '` replaced
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML[character]!);
}

/**
 * Builds the title with `<mark>` around the words the engine matched.
 *
 * Why: plan section 5.2: the highlight is built by us from the engine's matched tokens over our own escaped title, never from the
 * engine's HTML, so a title can never inject markup. A word is marked when its folded form equals a matched token or starts with one
 * (a prefix match reports the typed prefix); the marked part leaves surrounding punctuation outside (`(<mark>SM-A525F</mark>)`).
 *
 * @param title the title as shown
 * @param tokens the folded matched tokens
 * @returns escaped HTML
 */
export function highlightTitle(title: string, tokens: readonly string[]): string {
  const wanted = tokens.filter((token) => token !== '');
  return title
    .split(/(\s+)/)
    .map((part) => {
      if (part === '' || /^\s+$/.test(part)) return part;
      const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(part);
      const core = match?.[2] ?? '';
      const folded = fold(core);
      if (folded === '' || !wanted.some((token) => folded === token || folded.startsWith(token)))
        return escapeHtml(part);
      return `${escapeHtml(match![1]!)}<mark>${escapeHtml(core)}</mark>${escapeHtml(match![3]!)}`;
    })
    .join('');
}

/** What the three searches of a suggest gave. */
export interface SuggestEngineAnswer {
  readonly terms: SearchResult<TermHitDocument>;
  readonly services: SearchResult<{ id: string }>;
  readonly nearby: SearchResult<{ id: string }>;
}

/** The engine's part of a suggest answer: everything but prices, cards and the Postgres re-check (cached 30 s per typed text). */
export interface EnginePart {
  readonly ghost: string | null;
  readonly completions: Completion[];
  readonly candidates: Candidate[];
  readonly filters: SuggestFilter[];
  readonly didYouMean: string | null;
}

/** What {@link assembleEnginePart} reads besides the answer. */
export interface EnginePartInput {
  /** What the visitor typed, as sent. */
  readonly raw: string;
  readonly answer: SuggestEngineAnswer;
  readonly labels: FacetLabels;
  /** Every folded word of every enabled synonym term. */
  readonly synonymWords: ReadonlySet<string>;
  /** The folded words of every multi-word enabled synonym term. */
  readonly synonymPhrases?: ReadonlyArray<readonly string[]>;
}

/**
 * Assembles the engine's part of a suggest answer.
 *
 * @param input the typed text, the three answers, the labels and the synonym words
 * @returns the ghost, the completions, the candidates, the chips and the "did you mean" of the services search (`null` when it found
 *   nothing: the caller then asks the terms collection)
 */
export function assembleEnginePart(input: EnginePartInput): EnginePart {
  const p = typedPrefix(input.raw);
  const { terms, services, nearby } = input.answer;
  const query = p.trim();
  const termDocuments = terms.hits.map((hit) => hit.document);
  return {
    ghost: ghostOf(p, termDocuments),
    completions: completionsOf(p, termDocuments),
    candidates: mergeCandidates(services, nearby),
    filters: pickFilters(query, services.facet_counts, input.labels),
    didYouMean: didYouMean({
      query,
      hits: services.hits,
      found: services.found,
      synonymWords: input.synonymWords,
      ...(input.synonymPhrases ? { synonymPhrases: input.synonymPhrases } : {}),
      lastWordComplete: p.endsWith(' '),
    }),
  };
}
