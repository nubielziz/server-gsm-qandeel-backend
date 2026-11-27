// CategoryOrderService: the use case of `POST /admin/service-categories/order` (decision 078): the stored order of the categories
// (the console's groups) that the console's Group view sets by dragging and that the merchant catalog, the price list and the Dhru
// service list follow (decision 063).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { lockCategoryPositions, writeCategoryPositions } from '../infra/category.repository';
import { CatalogPriceVersion } from './catalog-price-version';

/** One category and the position staff give it. */
export interface CategoryOrderItem {
  readonly id: number;
  readonly sort: number;
}

/** What the order answers. */
export interface CategoryOrderResult {
  /** How many categories changed position (a category already at its position is not counted). */
  readonly updated: number;
}

/** The most categories whose old and new positions are copied into the audit entry (the counts are always there). */
const AUDIT_DETAIL_LIMIT = 200;

/**
 * Finds the items that name a category twice.
 *
 * @param items the items in the order they were sent
 * @returns the index of every item whose id appeared earlier in the list
 */
export function repeatedCategoryItems(items: readonly CategoryOrderItem[]): number[] {
  const seen = new Set<number>();
  const repeated: number[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.id)) repeated.push(index);
    seen.add(item.id);
  });
  return repeated;
}

/**
 * Stores the order of categories.
 *
 * Why: the console's Group view reorders groups by dragging; one call replaces one `PATCH /admin/service-categories/:id` per moved
 * group, so a drag is saved all or none and is one entry in the audit log (decision 078). The position of a category is what the
 * merchant catalog, the price list and the Dhru service list sort groups by (decision 063).
 *
 * Side effects: updates `service_categories.sort` of the categories that changed and writes one `audit_logs` entry (entity `category`,
 * `changed the order of`) in the same transaction; moves the catalog price version once after the commit when a position changed, so
 * cached price lists start over. It writes no `catalog.category_changed` event: the search index holds a category's name and id, never
 * its position, so no indexed fact changes (decision 038, decision 078).
 *
 * @see docs/decisions/078-group-order-route-and-api-key-edits.md
 */
@Injectable()
export class CategoryOrderService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Sets the position of some categories.
   *
   * @param items the categories and their positions (1 to 500, validated by the contract)
   * @returns how many categories changed position
   * @throws {AppError} `VALIDATION_FAILED` (422 on `items.N.id` for a category listed twice or unknown; every problem comes back
   *   together and nothing is saved)
   */
  async apply(items: readonly CategoryOrderItem[]): Promise<CategoryOrderResult> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      // Lock first, then judge and write: the positions read are the ones nobody can change until this transaction ends.
      const current = new Map(
        (
          await lockCategoryPositions(
            tx,
            items.map((item) => item.id),
          )
        ).map((row) => [row.id, row]),
      );
      const repeated = new Set(repeatedCategoryItems(items));
      const errors = items.flatMap((item, index) => {
        if (repeated.has(index)) {
          return [{ field: `items.${index}.id`, code: 'duplicate', message: 'This category is listed twice.' }];
        }
        if (!current.has(item.id)) {
          return [{ field: `items.${index}.id`, code: 'unknown', message: `No category has the id ${item.id}.` }];
        }
        return [];
      });
      if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });

      const changedIds = new Set(await writeCategoryPositions(tx, items));
      const changed = items.filter((item) => changedIds.has(item.id));
      // The merchant catalog, the price list and the Dhru list read the category position, so a cached list is stale once one moved.
      if (changed.length > 0) this.priceVersion.bumpAfterCommit(work);
      const shown = changed.slice(0, AUDIT_DETAIL_LIMIT);
      // A name is not unique across types, so the id goes into the key; the list reads "Carrier unlock (#4): 2".
      const keyOf = (id: number) => `${current.get(id)!.name} (#${id})`;
      await this.audit.record(tx, {
        action: 'changed the order of',
        entityType: 'category',
        entityLabel: `${items.length} ${items.length === 1 ? 'category' : 'categories'}`,
        before: {
          categories: items.length,
          changed: changed.length,
          sorts: Object.fromEntries(shown.map((item) => [keyOf(item.id), current.get(item.id)!.sort])),
        },
        after: {
          categories: items.length,
          changed: changed.length,
          sorts: Object.fromEntries(shown.map((item) => [keyOf(item.id), item.sort])),
        },
      });
      return { updated: changed.length };
    });
  }
}
