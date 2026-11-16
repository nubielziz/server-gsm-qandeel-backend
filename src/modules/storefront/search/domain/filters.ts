// The filters of a results-page search (feature 29, plan section 5.3): the visitor's selected values turned into a Typesense
// `filter_by`, the facet groups, and the reading of facet counts. Pure.
import type { FacetCounts } from '../../../../infra/search';

/** The facet groups of the results page. */
export const FACET_GROUPS = ['brand', 'network', 'country', 'category', 'type', 'availability'] as const;

/** One facet group of the results page. */
export type FacetGroup = (typeof FACET_GROUPS)[number];

/** The index field each group counts and filters on. */
export const FACET_FIELD: Readonly<Record<FacetGroup, string>> = {
  brand: 'brand_key',
  network: 'carrier_key',
  country: 'country',
  category: 'category_id',
  type: 'type',
  availability: 'in_stock',
};

/** The facets the results page counts. */
export const RESULT_FACETS = FACET_GROUPS.map((group) => FACET_FIELD[group]).join(',');

/** What the visitor selected (each repeatable; empty means no restriction). */
export interface ResultFilters {
  readonly brand: readonly string[];
  readonly network: readonly string[];
  readonly country: readonly string[];
  readonly category: readonly number[];
  readonly type: readonly string[];
  readonly availability: readonly ('in_stock' | 'on_request')[];
  readonly featured?: boolean | undefined;
}

/** No filter at all. */
export const NO_FILTERS: ResultFilters = {
  brand: [],
  network: [],
  country: [],
  category: [],
  type: [],
  availability: [],
};

/** The largest category id the index holds (`category_id` is an int32 field). */
const MAX_CATEGORY_ID = 2_147_483_647;

/**
 * Quotes a text value for `filter_by`.
 *
 * Why: Typesense reads a value in backticks verbatim (commas, colons, brackets, spaces); a backtick cannot be escaped inside one, so it
 * is dropped (no brand or carrier name needs one). The value is cut to 200 characters like every text filter of the list dialect.
 *
 * @param value the text
 * @returns the quoted value
 */
export function quoteFilterValue(value: string): string {
  return `\`${value.replaceAll('`', '').slice(0, 200)}\``;
}

function textClause(field: string, values: readonly string[]): string | null {
  const clean = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value !== '' && value.replaceAll('`', '') !== '')),
  ];
  return clean.length === 0 ? null : `${field}:=[${clean.map(quoteFilterValue).join(',')}]`;
}

/**
 * The groups the visitor selected a value in.
 *
 * @param filters the selection
 * @returns the groups with at least one value (an availability of both values restricts nothing)
 */
export function selectedGroups(filters: ResultFilters): FacetGroup[] {
  return FACET_GROUPS.filter((group) => {
    if (group === 'availability') return filters.availability.length === 1;
    if (group === 'category') return filters.category.length > 0;
    return filters[group].length > 0;
  });
}

/**
 * Builds the `filter_by` of a results search.
 *
 * Why: plan section 5.3: brand and network values are lower-cased (the `*_key` fields are), country codes upper-cased, every text value
 * quoted; the facet counts of one group ignore that group's own selection, so the caller asks for the clauses `except` that group.
 * A category id outside the index's int32 range is dropped (it would make the engine answer 400, which is a refusal of our own
 * request, not a sign of its health); a selection with no id left matches nothing.
 *
 * @param filters the selection
 * @param except a group whose own selection is left out
 * @returns the `filter_by`, or `''` when nothing restricts the search
 */
export function filterBy(filters: ResultFilters, except?: FacetGroup): string {
  const clauses: Array<string | null> = [];
  if (except !== 'brand')
    clauses.push(
      textClause(
        'brand_key',
        filters.brand.map((value) => value.toLowerCase()),
      ),
    );
  if (except !== 'network')
    clauses.push(
      textClause(
        'carrier_key',
        filters.network.map((value) => value.toLowerCase()),
      ),
    );
  if (except !== 'country')
    clauses.push(
      textClause(
        'country',
        filters.country.map((value) => value.toUpperCase()),
      ),
    );
  if (except !== 'category' && filters.category.length > 0) {
    // `category_id` is an int32 field: a larger number makes the engine answer 400. Ids are positive, so a selection with no id in
    // range matches nothing (`[0]`), and never widens the result.
    const ids = [...new Set(filters.category)].filter((id) => Number.isInteger(id) && id >= 1 && id <= MAX_CATEGORY_ID);
    clauses.push(`category_id:=[${(ids.length === 0 ? [0] : ids).join(',')}]`);
  }
  if (except !== 'type') clauses.push(textClause('type', filters.type));
  if (except !== 'availability' && filters.availability.length === 1) {
    clauses.push(`in_stock:=${filters.availability[0] === 'in_stock' ? 'true' : 'false'}`);
  }
  if (filters.featured !== undefined) clauses.push(`featured:=${filters.featured ? 'true' : 'false'}`);
  return clauses.filter((clause): clause is string => clause !== null).join(' && ');
}

/** One value of a facet and how many matches hold it. */
export interface FacetValue {
  readonly value: string;
  readonly count: number;
}

/**
 * Reads the counts of one field from a search answer's `facet_counts`.
 *
 * @param facets the answer's facet list
 * @param field the index field
 * @returns the values with a count above zero, most frequent first (the engine's order)
 */
export function facetValues(facets: readonly FacetCounts[] | undefined, field: string): FacetValue[] {
  const entry = facets?.find((facet) => facet.field_name === field);
  return (entry?.counts ?? [])
    .filter((count) => count.count > 0)
    .map((count) => ({ value: count.value, count: count.count }));
}
