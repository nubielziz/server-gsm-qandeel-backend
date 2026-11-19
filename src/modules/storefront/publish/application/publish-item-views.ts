// The wire rows of a publish run (feature 31, plan 31 section 5.2): the rows of a list, or one row after an edit, joined with the label of
// their rule. One function so the list and the edit answer the same `PublishItem`.
import type { DbExecutor } from '../../../../infra/db';
import { ruleLabelsOf } from '../../../catalog';
import { type PublishItemView, itemView } from '../domain/publish-view';
import type { ItemRow } from '../infra/publish-read.repository';

/**
 * Turns joined rows into the `PublishItem` the console reads.
 *
 * Why: plan 31 section 5.2: the rule's name is read live and survives the rule's deletion (the catalog keeps the deleted row), one read
 * for the whole page.
 *
 * @param db the database or a transaction
 * @param rows the rows with their service, category and listing facts
 * @returns the wire rows, in the order of `rows`
 */
export async function itemViewsOf(db: DbExecutor, rows: readonly ItemRow[]): Promise<PublishItemView[]> {
  const labels = await ruleLabelsOf(
    db,
    rows.flatMap((row) => (row.item.ruleId === null ? [] : [row.item.ruleId])),
  );
  return rows.map((row) =>
    itemView({
      item: row.item,
      service: row.service,
      listingListed: row.listingListed,
      ruleLabel: row.item.ruleId === null ? null : (labels.get(row.item.ruleId) ?? null),
    }),
  );
}
