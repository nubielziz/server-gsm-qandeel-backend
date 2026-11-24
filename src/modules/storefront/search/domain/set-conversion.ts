// Conversion of the search synonyms table into the Typesense synonym set (feature 29, plan section 4.6 and step 0). Pure. Decision 068
// retired the pins and their curation set.
import type { SynonymItem } from '../../../../infra/search';

/** A row of `search_synonyms` as the conversion reads it. */
export interface SynonymRow {
  readonly id: number;
  readonly kind: 'multi' | 'one_way';
  readonly root: string | null;
  readonly terms: readonly string[];
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
