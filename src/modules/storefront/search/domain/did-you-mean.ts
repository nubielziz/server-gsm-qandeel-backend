// "Did you mean": the corrected query a results page offers when a word of the query matched nothing (feature 29, plan section 5.4).
// Pure: it reads the matched tokens of the engine's top hits and the enabled synonym words, never the engine itself.
import type { SearchHit } from '../../../../infra/search';
import { hasDigit, normaliseText } from './normalise';

/** The hit shape the rule reads: the highlight tokens (and whether a pin put the hit there). */
export type HighlightedHit = Pick<SearchHit<unknown>, 'highlights' | 'curated'>;

/** How many of the top hits must all hold the replacement word. */
export const AGREEING_HITS = 3;
/** The edit distance allowed for a word of this length or longer (7). */
export const LONG_WORD = 7;

/**
 * Folds a word the way the engine tokenises it: lower case, letters and digits only.
 *
 * @param word a word or a matched token
 * @returns the folded word (`AT&T` gives `att`, `T-Mobile` gives `tmobile`)
 */
export function fold(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The edit distance of two words with transpositions of neighbours counted as one edit (optimal string alignment).
 *
 * @param a one word
 * @param b another word
 * @returns the number of insertions, deletions, substitutions and neighbour swaps between them
 */
export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[rows - 1]![cols - 1]!;
}

/**
 * The folded matched tokens of one hit.
 *
 * @param hit a search hit with its highlights
 * @returns every matched token of every highlighted field (strings and lists alike), folded
 */
export function matchedTokensOf(hit: HighlightedHit): Set<string> {
  const tokens = new Set<string>();
  for (const highlight of hit.highlights ?? []) {
    for (const entry of highlight.matched_tokens ?? []) {
      for (const token of Array.isArray(entry) ? entry : [entry]) {
        const folded = fold(String(token));
        if (folded !== '') tokens.add(folded);
      }
    }
  }
  return tokens;
}

/**
 * The positions of query words that sit in a run within one typo of a multi-word synonym phrase.
 *
 * @param words the folded query words
 * @param phrases the folded words of each multi-word synonym term
 * @returns the covered positions
 */
function coveredBySynonymPhrase(words: readonly string[], phrases: ReadonlyArray<readonly string[]>): Set<number> {
  const covered = new Set<number>();
  for (const phrase of phrases) {
    if (phrase.length < 2) continue;
    for (let start = 0; start + phrase.length <= words.length; start += 1) {
      const near = phrase.every((word, offset) => damerauLevenshtein(words[start + offset]!, word) <= 1);
      if (near) for (let offset = 0; offset < phrase.length; offset += 1) covered.add(start + offset);
    }
  }
  return covered;
}

/** What {@link didYouMean} reads. */
export interface DidYouMeanInput {
  /** The normalised query. */
  readonly query: string;
  /** The top hits of the main search, in order, with their highlights. */
  readonly hits: readonly HighlightedHit[];
  /** How many documents matched in all (the top `min(3, found)` hits decide). */
  readonly found: number;
  /** Every word of every enabled synonym term (folded): a word inside one is never unknown. */
  readonly synonymWords: ReadonlySet<string>;
  /**
   * The words of every multi-word enabled synonym term (`['blacklist', 'check']`). A run of query words within one typo of such a phrase
   * is a synonym the visitor typed with a slip, which the engine understands; it is never "corrected".
   */
  readonly synonymPhrases?: ReadonlyArray<readonly string[]>;
  /** When false the last word of the query is still being typed and is never checked (suggest: the input does not end with a space). */
  readonly lastWordComplete: boolean;
}

/**
 * Corrects the words of a query that no hit explains.
 *
 * Why: plan section 5.4. The checked words are the complete query words; a word with a digit is a model code and is never corrected.
 * A word `w` is unknown when no hit's matched tokens hold it exactly or as a prefix, and no enabled synonym term holds it. Its
 * replacement is the matched token shared by all of the top `min(3, found)` hits whose distance to `w` is at most 1 (2 when `w` has 7
 * letters or more); with several candidates the closest wins, then the alphabetically first. The corrected query is the query with
 * each unknown word replaced; `null` when nothing was replaced.
 *
 * @param input the query, the hits and the synonyms
 * @returns the corrected query, or `null`
 */
export function didYouMean(input: DidYouMeanInput): string | null {
  const words = normaliseText(input.query)
    .split(' ')
    .filter((word) => word !== '');
  const checked = input.lastWordComplete ? words.length : words.length - 1;
  // A hit with no highlighted token matched through a field the highlight leaves out (the summary, the networks): it neither agrees
  // nor disagrees with a replacement, so it does not count among the hits that must share one.
  const top = input.hits
    .filter((hit) => hit.curated !== true)
    .slice(0, Math.min(AGREEING_HITS, input.found))
    .filter((hit) => matchedTokensOf(hit).size > 0);
  if (top.length === 0) return null;
  const perHit = top.map(matchedTokensOf);
  const covered = coveredBySynonymPhrase(words.map(fold), input.synonymPhrases ?? []);
  const everything = new Set(perHit.flatMap((tokens) => [...tokens]));
  let changed = false;
  const corrected = words.map((word, index) => {
    if (index >= checked || hasDigit(word) || covered.has(index)) return word;
    const folded = fold(word);
    if (folded === '' || input.synonymWords.has(folded)) return word;
    for (const token of everything) if (token.startsWith(folded)) return word;
    const allowed = folded.length >= LONG_WORD ? 2 : 1;
    const shared = [...perHit[0]!].filter((token) => perHit.every((tokens) => tokens.has(token)));
    const candidates = shared
      .map((token) => ({ token, distance: damerauLevenshtein(folded, token) }))
      .filter((entry) => entry.distance > 0 && entry.distance <= allowed)
      .sort((a, b) => a.distance - b.distance || (a.token < b.token ? -1 : 1));
    if (candidates.length === 0) return word;
    changed = true;
    return candidates[0]!.token;
  });
  return changed ? corrected.join(' ') : null;
}
