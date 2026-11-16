// Conversion of the search settings tables into Typesense sets (feature 29, plan section 4.6 and step 0): enabled synonyms into the
// synonym set, enabled pins into the curation set. Pure.
import type { CurationItem, SynonymItem } from '../../../../infra/search';

/** A row of `search_synonyms` as the conversion reads it. */
export interface SynonymRow {
  readonly id: number;
  readonly kind: 'multi' | 'one_way';
  readonly root: string | null;
  readonly terms: readonly string[];
  readonly isEnabled: boolean;
}

/** A row of `search_pins` as the conversion reads it. */
export interface PinRow {
  readonly id: number;
  readonly query: string;
  readonly match: 'exact' | 'contains';
  readonly pinned: ReadonlyArray<{ readonly serviceId: number; readonly position: number }>;
  readonly hidden: readonly number[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly isEnabled: boolean;
}

/**
 * The items of the synonym set: one per enabled synonym, `s<id>`, with `root` for a one-way synonym.
 *
 * @param rows the synonym rows (disabled ones are left out)
 * @returns the items, in id order
 */
export function synonymItems(rows: readonly SynonymRow[]): SynonymItem[] {
  return [...rows]
    .filter((row) => row.isEnabled && row.terms.length > 0)
    .sort((a, b) => a.id - b.id)
    .map((row) =>
      row.kind === 'one_way' && row.root
        ? { id: `s${row.id}`, root: row.root, synonyms: [...row.terms] }
        : { id: `s${row.id}`, synonyms: [...row.terms] },
    );
}

const unixSeconds = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * The items of the curation set: one per enabled pin, `p<id>`.
 *
 * Why: plan section 4.6 and step 0: `remove_matched_tokens: false` keeps every query word for the organic part (without it Typesense
 * would search only the words left after the rule's words), and `filter_curated_hits: true` on every rule makes the page filters apply
 * to pinned hits too (a rule's own value wins over the search parameter, so a pin never bypasses a filter). The time window goes to
 * `effective_from_ts` / `effective_to_ts`.
 *
 * @param rows the pin rows (disabled ones are left out)
 * @returns the items, in id order
 */
export function curationItems(rows: readonly PinRow[]): CurationItem[] {
  return [...rows]
    .filter((row) => row.isEnabled)
    .sort((a, b) => a.id - b.id)
    .map((row) => ({
      id: `p${row.id}`,
      rule: { query: row.query, match: row.match },
      includes: [...row.pinned]
        .sort((a, b) => a.position - b.position)
        .map((pin) => ({ id: String(pin.serviceId), position: pin.position })),
      excludes: row.hidden.map((serviceId) => ({ id: String(serviceId) })),
      filter_curated_hits: true,
      remove_matched_tokens: false,
      ...(row.startsAt === null ? {} : { effective_from_ts: unixSeconds(row.startsAt) }),
      ...(row.endsAt === null ? {} : { effective_to_ts: unixSeconds(row.endsAt) }),
    }));
}
