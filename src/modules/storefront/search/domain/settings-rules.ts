// The rules of the console's search settings (feature 29, plan sections 4.6 and 5.1): what a synonym, a pin rule and a hidden term must
// look like once cleaned. Pure: each function returns the cleaned value or the field errors, the use case turns them into a 422.
import { MAX_QUERY_LENGTH, normaliseText } from './normalise';

/** One refused field: its wire name (dotted for list items), a code and a message. */
export interface RuleProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** A synonym once cleaned. */
export interface CleanSynonym {
  readonly kind: 'multi' | 'one_way';
  readonly root: string | null;
  readonly terms: string[];
}

/** The longest cleaned synonym term. */
export const MAX_SYNONYM_TERM = 60;

/**
 * Cleans and checks a synonym.
 *
 * Why: plan section 4.6: 2-20 normalised, distinct terms of 1-60 characters; a `one_way` synonym needs its root (the word that expands),
 * a `multi` one has none. Terms are cleaned like a query (`AT&T` becomes `att`) so they match what the engine indexes.
 *
 * @param input the kind, the root and the terms as sent
 * @returns the cleaned synonym, or the problems
 */
export function cleanSynonym(input: {
  readonly kind: 'multi' | 'one_way';
  readonly root?: string | null | undefined;
  readonly terms: readonly string[];
}): { readonly ok: true; readonly value: CleanSynonym } | { readonly ok: false; readonly problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const terms: string[] = [];
  input.terms.forEach((term, index) => {
    const clean = normaliseText(term);
    if (clean === '') problems.push({ field: `terms.${index}`, code: 'empty', message: 'Enter a word or a phrase.' });
    else if (clean.length > MAX_SYNONYM_TERM) {
      problems.push({
        field: `terms.${index}`,
        code: 'too_long',
        message: `Use at most ${MAX_SYNONYM_TERM} characters.`,
      });
    } else if (terms.includes(clean)) {
      problems.push({ field: `terms.${index}`, code: 'duplicate', message: 'This term is already in the list.' });
    } else terms.push(clean);
  });
  let root: string | null = null;
  if (input.kind === 'one_way') {
    root = normaliseText(input.root ?? '');
    if (root === '')
      problems.push({ field: 'root', code: 'required', message: 'Enter the word that expands to the terms.' });
    else if (root.length > MAX_SYNONYM_TERM) {
      problems.push({ field: 'root', code: 'too_long', message: `Use at most ${MAX_SYNONYM_TERM} characters.` });
    } else if (terms.includes(root)) {
      problems.push({ field: 'root', code: 'duplicate', message: 'The root is one of the terms.' });
    }
    if (root === '') root = null;
  }
  if (problems.length === 0 && (terms.length < 2 || terms.length > 20)) {
    problems.push({ field: 'terms', code: 'count', message: 'Use 2 to 20 terms.' });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { kind: input.kind, root, terms } };
}

/** A pin rule once cleaned. */
export interface CleanPin {
  readonly query: string;
  readonly pinned: Array<{ serviceId: number; position: number }>;
  readonly hidden: number[];
}

/**
 * Cleans and checks the query, the pinned services and the hidden services of a pin rule.
 *
 * Why: plan section 4.6: the query is cleaned like a search (1-100 characters), at most 10 pinned services with distinct positions
 * 1-10, at most 50 hidden, and a service is never both pinned and hidden. Whether each service has a switched-on English page is the
 * use case's check (it needs Postgres).
 *
 * @param input the query, pinned and hidden services as sent
 * @returns the cleaned rule, or the problems
 */
export function cleanPin(input: {
  readonly query: string;
  readonly pinned: ReadonlyArray<{ readonly serviceId: number; readonly position: number }>;
  readonly hidden: readonly number[];
}): { readonly ok: true; readonly value: CleanPin } | { readonly ok: false; readonly problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const query = normaliseText(input.query).slice(0, MAX_QUERY_LENGTH * 2);
  if (query === '') problems.push({ field: 'query', code: 'empty', message: 'Enter the search words.' });
  else if (query.length > MAX_QUERY_LENGTH) {
    problems.push({ field: 'query', code: 'too_long', message: `Use at most ${MAX_QUERY_LENGTH} characters.` });
  }
  const seenServices = new Set<number>();
  const seenPositions = new Set<number>();
  input.pinned.forEach((pin, index) => {
    if (seenServices.has(pin.serviceId)) {
      problems.push({
        field: `pinned.${index}.serviceId`,
        code: 'duplicate',
        message: 'This service is pinned twice.',
      });
    }
    if (seenPositions.has(pin.position)) {
      problems.push({
        field: `pinned.${index}.position`,
        code: 'duplicate',
        message: 'Two services share this position.',
      });
    }
    seenServices.add(pin.serviceId);
    seenPositions.add(pin.position);
  });
  const hidden = new Set<number>();
  input.hidden.forEach((serviceId, index) => {
    if (hidden.has(serviceId))
      problems.push({ field: `hidden.${index}`, code: 'duplicate', message: 'This service is hidden twice.' });
    else if (seenServices.has(serviceId)) {
      problems.push({ field: `hidden.${index}`, code: 'pinned', message: 'A service cannot be pinned and hidden.' });
    }
    hidden.add(serviceId);
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      query,
      pinned: [...input.pinned]
        .sort((a, b) => a.position - b.position)
        .map(({ serviceId, position }) => ({ serviceId, position })),
      hidden: [...hidden],
    },
  };
}

/**
 * Tells whether a pin rule applies to a query.
 *
 * Why: the console's preview marks the services a rule keeps out of a query; the engine applies the same meaning: `exact` is the whole
 * query, `contains` the rule's words inside the query as whole words.
 *
 * @param rule the rule's cleaned query and match
 * @param query the cleaned query being previewed
 * @returns true when the rule applies
 */
export function ruleApplies(
  rule: { readonly query: string; readonly match: 'exact' | 'contains' },
  query: string,
): boolean {
  return rule.match === 'exact' ? query === rule.query : ` ${query} `.includes(` ${rule.query} `);
}

/**
 * Cleans a hidden term.
 *
 * @param term the term as sent
 * @returns the normalised term (1-64 characters), or the problem
 */
export function cleanHiddenTerm(
  term: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problems: RuleProblem[] } {
  const clean = normaliseText(term);
  if (clean === '')
    return { ok: false, problems: [{ field: 'term', code: 'empty', message: 'Enter the search words.' }] };
  if (clean.length > 64)
    return { ok: false, problems: [{ field: 'term', code: 'too_long', message: 'Use at most 64 characters.' }] };
  return { ok: true, value: clean };
}
