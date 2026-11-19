// CategoryNameCleanup: gives the categories that exist the clean names new ones get (feature 31, the final review's override of plan 31
// section 3.5): one pass, asked for once by migration 0046 through the outbox, run by the worker (job `category_names_clean`).
import { Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { cleanGroupName, IMPORTED_CATEGORY_NAME } from '../domain/category-name';
import {
  categoryNameTaken,
  categoryNamesAfter,
  lockCategoryRow,
  updateCategoryRow,
} from '../infra/category.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { CatalogSignals } from './catalog-signals';

/** The outbox event migration 0046 writes once: "clean the names of the categories that exist". */
export const CATEGORY_NAMES_CLEAN_EVENT = 'catalog.category_names_clean';

/** The job that event becomes on the `maintenance` queue. */
export const CATEGORY_NAMES_CLEAN_JOB = 'category_names_clean';

/** Categories read in one page of the pass. */
const CATEGORY_PAGE = 200;

/** What one pass did. */
export interface CategoryNameCleanupResult {
  /** The categories it read. */
  readonly checked: number;
  /** The categories it renamed. */
  readonly renamed: number;
  /** The categories it left as they are, because another of the same type already has the clean name. */
  readonly collisions: number;
}

/** What became of one category whose name is not clean. */
type RenameOutcome = 'renamed' | 'collision' | 'unchanged';

/**
 * The clean name of a category, or `null` when the pass must leave it alone.
 *
 * Why: `cleanGroupName` gives `Imported` for a name with nothing left after the cleaning (a name written only in Arabic script, as one
 * of the owner's categories is). Such a name is not a supplier's code to tidy but words a person chose: staff rename it if they want.
 *
 * @param name the stored name
 * @returns the name to store, or `null` for "keep it as it is"
 */
export function cleanedCategoryName(name: string): string | null {
  const clean = cleanGroupName(name);
  if (clean === name) return null;
  if (clean === IMPORTED_CATEGORY_NAME) return null;
  return clean;
}

/**
 * Cleans the names of the categories that already exist.
 *
 * Why: the public menu shows category names, and every category Quick add made before feature 31 carries the supplier's group text as it
 * came (`AT&amp;T`, emoji, direction marks). The importer cleans only the categories it creates, and the owner's 254 all exist, so the
 * shop would go live with the raw names. The final review overruled plan 31 section 3.5 here. The importer keeps working after a rename:
 * it looks a group up by its raw text, then by the cleaned name, which now finds the renamed category.
 *
 * A name that would be left with no text at all (written only in Arabic script) keeps its name. A name that another category of the
 * same type already has (ignoring case) is left alone: merging two categories is a decision for
 * staff, and the importer keeps sending the raw group to the raw category. Each rename is its own transaction, under the category row
 * lock a staff edit takes, so a pass never holds up the catalog; a repeat finds nothing to do.
 *
 * Side effects: per renamed category, updates `service_categories.name`, writes the `catalog.category_changed` outbox event (the search
 * index re-reads its services), one `audit_logs` row by `system` (`edited category`, with both names) and moves the catalog price version
 * after the commit (merchant price lists show the name).
 *
 * @see docs/queues.md (maintenance, `category_names_clean`)
 */
@Injectable()
export class CategoryNameCleanup {
  private readonly logger = new Logger(CategoryNameCleanup.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly signals: CatalogSignals,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Walks every category, in id order, and cleans the names that need it.
   *
   * @returns how many categories it read, renamed and left because of a collision
   */
  async run(): Promise<CategoryNameCleanupResult> {
    let checked = 0;
    let renamed = 0;
    let collisions = 0;
    let afterId = 0;
    for (;;) {
      const page = await categoryNamesAfter(this.db.db, afterId, CATEGORY_PAGE);
      if (page.length === 0) break;
      for (const category of page) {
        afterId = category.id;
        checked += 1;
        if (cleanedCategoryName(category.name) === null) continue;
        const outcome = await this.rename(category.id);
        if (outcome === 'renamed') renamed += 1;
        if (outcome === 'collision') {
          collisions += 1;
          this.logger.warn(`Category ${category.id} keeps its name: another category has the clean one.`);
        }
      }
    }
    return { checked, renamed, collisions };
  }

  /** One category, in its own transaction; the name is judged again under the row lock. */
  private async rename(categoryId: number): Promise<RenameOutcome> {
    try {
      return await this.db.runInTransaction(async (work): Promise<RenameOutcome> => {
        const { tx } = work;
        const category = await lockCategoryRow(tx, categoryId);
        if (category === undefined) return 'unchanged';
        const name = cleanedCategoryName(category.name);
        if (name === null) return 'unchanged';
        if (await categoryNameTaken(tx, category.type, name, categoryId)) return 'collision';
        await updateCategoryRow(tx, categoryId, { name });
        // What a staff rename does: the search index re-reads the services, and cached price lists start over.
        await this.signals.categoryChanged(tx, categoryId);
        this.priceVersion.bumpAfterCommit(work);
        await this.audit.record(tx, {
          action: 'edited category',
          entityType: 'category',
          entityId: categoryId,
          entityLabel: name,
          before: { name: category.name },
          after: { name },
        });
        return 'renamed';
      });
    } catch (error) {
      // The check above reads without a lock: a category made under the clean name a moment ago is the same collision.
      if (isUniqueViolation(error, 'service_categories_name_uq')) return 'collision';
      throw error;
    }
  }
}
