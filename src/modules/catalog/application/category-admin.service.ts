// CategoryAdminService: the use cases of the service category routes (map domain B, stage 4): list, show, create, change and
// delete. Rules: a name is unique within its type, a category with live services keeps its type, and a category is deleted only
// when no service row (live or archived) belongs to it.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor, isForeignKeyViolation, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { CatalogPriceVersion } from './catalog-price-version';
import type { ServiceCategory, ServiceType } from '../db/schema';
import {
  type CategoryRow,
  categoryNameTaken,
  countServicesOfCategory,
  deleteCategoryRow,
  deleteCategoryRules,
  existingGroupIds,
  findCategoryRow,
  insertCategoryRow,
  listCategoryRows,
  lockCategoryRow,
  nextCategorySort,
  updateCategoryRow,
} from '../infra/category.repository';

/** A category as the console reads it. */
export interface CategoryView {
  readonly id: number;
  readonly name: string;
  readonly type: ServiceType;
  readonly allowedGroupIds: number[];
  readonly sort: number;
  readonly isActive: boolean;
  readonly serviceCount: number;
}

/** The fields of `POST /admin/service-categories`. */
export interface CreateCategoryInput {
  readonly name: string;
  readonly type: ServiceType;
  readonly allowedGroupIds?: number[] | undefined;
  readonly sort?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/** The fields `PATCH /admin/service-categories/:id` may change. */
export type UpdateCategoryInput = Partial<CreateCategoryInput>;

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const nameTaken = (type: ServiceType) =>
  invalid('name', `A ${type} category with this name already exists.`, 'duplicate');

const snapshot = (category: ServiceCategory) => ({
  name: category.name,
  type: category.type,
  allowedGroupIds: category.allowedGroupIds,
  sort: category.sort,
  isActive: category.isActive,
});

const toView = ({ category, serviceCount }: CategoryRow): CategoryView => ({
  id: category.id,
  name: category.name,
  type: category.type,
  allowedGroupIds: category.allowedGroupIds,
  sort: category.sort,
  isActive: category.isActive,
  serviceCount,
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Manages service categories.
 *
 * Why: categories are the Dhru GROUPNAME and decide which merchant groups see a service (RESOLUTIONS catalog-6, catalog-10 and
 * catalog-13). A service's type always equals its category's type (a composite foreign key), so a type change waits until the
 * live services have moved; archived services follow the change by `ON UPDATE CASCADE`. A name is unique within its type,
 * checked before the write and again from the unique index, so a race answers 422 and never 500.
 *
 * Side effects: writes `service_categories` (and, on delete, the category's `pricing_rules`) and `audit_logs` (entity `category`).
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/service-categories` sections)
 */
@Injectable()
export class CategoryAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Lists categories with their live service counts.
   *
   * @param query the parsed list request
   * @returns the page of categories and the exact total
   */
  async list(query: ParsedListQuery<'sort' | 'name' | 'id'>): Promise<{ rows: CategoryView[]; total: number }> {
    const { rows, total } = await listCategoryRows(this.db.db, query);
    return { rows: rows.map(toView), total };
  }

  /**
   * Shows one category.
   *
   * @param id the category id
   * @returns the category with its live service count
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<CategoryView> {
    const found = await findCategoryRow(this.db.db, id);
    if (!found) throw new AppError('NOT_FOUND', { detail: 'No category has this id.' });
    return toView(found);
  }

  /**
   * Creates a category.
   *
   * @param input the category fields
   * @returns the new category (no services yet)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name` for a repeat within the type, on `allowedGroupIds` for unknown groups)
   */
  async create(input: CreateCategoryInput): Promise<CategoryView> {
    return this.db.runInTransaction(async ({ tx }) => {
      if (await categoryNameTaken(tx, input.type, input.name)) throw nameTaken(input.type);
      const allowedGroupIds = await this.checkedGroupIds(tx, input.allowedGroupIds ?? []);
      let category: ServiceCategory;
      try {
        category = await insertCategoryRow(tx, {
          name: input.name,
          type: input.type,
          allowedGroupIds,
          sort: input.sort ?? (await nextCategorySort(tx)),
          isActive: input.isActive ?? true,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'service_categories_name_uq')) throw nameTaken(input.type);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created category',
        entityType: 'category',
        entityId: category.id,
        entityLabel: category.name,
        after: snapshot(category),
      });
      return toView({ category, serviceCount: 0 });
    });
  }

  /**
   * Changes a category.
   *
   * @param id the category id
   * @param changes the keys to change
   * @returns the updated category with its live service count
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `name` for a repeat within the (new) type, on `type`
   *   while live services are in the category, on `allowedGroupIds` for unknown groups)
   */
  async update(id: number, changes: UpdateCategoryInput): Promise<CategoryView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockCategoryRow(tx, id);
      if (!before) throw new AppError('NOT_FOUND', { detail: 'No category has this id.' });
      // A category's name, switch and allowed groups decide what merchants see, so cached price lists start over.
      this.priceVersion.bumpAfterCommit(work);
      const type = changes.type ?? before.type;
      const name = changes.name ?? before.name;

      if (type !== before.type) {
        const { live } = await countServicesOfCategory(tx, id);
        if (live > 0) {
          throw invalid(
            'type',
            `${plural(live, 'service')} in this category ${live === 1 ? 'is' : 'are'} ${before.type}. Move them first.`,
            'in_use',
          );
        }
      }
      if (
        (type !== before.type || name.toLowerCase() !== before.name.toLowerCase()) &&
        (await categoryNameTaken(tx, type, name, id))
      ) {
        throw nameTaken(type);
      }
      const allowedGroupIds =
        changes.allowedGroupIds === undefined ? undefined : await this.checkedGroupIds(tx, changes.allowedGroupIds);

      let category: ServiceCategory | undefined;
      try {
        category = await updateCategoryRow(tx, id, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.type === undefined ? {} : { type: changes.type }),
          ...(allowedGroupIds === undefined ? {} : { allowedGroupIds }),
          ...(changes.sort === undefined ? {} : { sort: changes.sort }),
          ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'service_categories_name_uq')) throw nameTaken(type);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'edited category',
        entityType: 'category',
        entityId: id,
        entityLabel: category!.name,
        before: snapshot(before),
        after: snapshot(category!),
      });
      const { live } = await countServicesOfCategory(tx, id);
      return toView({ category: category!, serviceCount: live });
    });
  }

  /**
   * Deletes a category that no service belongs to.
   *
   * Why: RESOLUTIONS catalog-6: archived services keep their row for order history and block the delete too, with their own
   * advice (turn the category off). The category's pricing rules go in the same transaction.
   *
   * @param id the category id
   * @throws {AppError} `NOT_FOUND` (404); `CATEGORY_IN_USE` (409: live services, or only archived ones, still belong to it)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const category = await lockCategoryRow(tx, id);
      if (!category) throw new AppError('NOT_FOUND', { detail: 'No category has this id.' });
      this.priceVersion.bumpAfterCommit(work);
      const { live, archived } = await countServicesOfCategory(tx, id);
      if (live > 0) throw inUseByLive(category.name, live);
      if (archived > 0) throw inUseByArchived(category.name, archived);
      const removedRuleIds = await deleteCategoryRules(tx, id);
      try {
        await deleteCategoryRow(tx, id);
      } catch (error) {
        // A service was created in the category between the count and the delete: the foreign key says no.
        if (isForeignKeyViolation(error)) throw inUseByLive(category.name, 1);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'deleted category',
        entityType: 'category',
        entityId: id,
        entityLabel: category.name,
        before: { ...snapshot(category), removedPricingRuleIds: removedRuleIds },
      });
    });
  }

  /** Removes repeats from a group id list and refuses ids that are no group. */
  private async checkedGroupIds(tx: DbExecutor, ids: readonly number[]): Promise<number[]> {
    const unique = [...new Set(ids)];
    const known = new Set(await existingGroupIds(tx, unique));
    const unknown = unique.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw invalid('allowedGroupIds', `Unknown merchant groups: ${unknown.join(', ')}.`, 'unknown');
    }
    return unique;
  }
}

function inUseByLive(name: string, live: number): AppError {
  return new AppError('CATEGORY_IN_USE', {
    detail: `${name} still has ${plural(live, 'service')}. Move them to another category first.`,
  });
}

function inUseByArchived(name: string, archived: number): AppError {
  return new AppError('CATEGORY_IN_USE', {
    detail: `${name} still has ${plural(archived, 'archived service')} kept for order history, so it cannot be deleted. Turn it off instead.`,
  });
}
