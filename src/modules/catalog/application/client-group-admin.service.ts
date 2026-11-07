// ClientGroupAdminService: the use cases of the merchant group routes (map domain B, stage 4): list, show, create, change and
// delete. The rules: one default group at all times, a group name is unique, the storefront retail group is protected, and a
// group stops allowing overdraft only while none of its merchants has credit (user rule 2).
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor, isUniqueViolation, isForeignKeyViolation } from '../../../infra/db';
import { MerchantGroupMembers } from '../../identity';
import { MerchantWallets } from '../../money';
import { AuditService } from '../../platform';
import type { ClientGroup } from '../db/schema';
import {
  clearDefaultMark,
  deleteGroupPrices,
  deleteGroupRow,
  deletePricingRulesOfGroup,
  dropGroupFromCategories,
  findGroupRow,
  groupNameTaken,
  insertGroupRow,
  listGroupRows,
  lockGroupRow,
  nextGroupSort,
  updateGroupRow,
} from '../infra/group.repository';
import { RETAIL_GROUP_KIND } from './client-group-directory';

/** Advisory lock key of the default mark: changing which group is the default is one change at a time. */
const DEFAULT_MARK_LOCK_KEY = 7_204_001;

/** A group as the console reads it. */
export interface GroupView {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly discountPercent: string;
  readonly isDefault: boolean;
  readonly earnThreshold: string;
  readonly depositLimit: string;
  readonly overdraftAllowed: boolean;
  readonly sort: number;
  readonly createdAt: string;
  /** Left out for the storefront retail group: no merchant joins it. */
  readonly merchantCount?: number;
}

/** The fields of `POST /admin/client-groups` (the optional ones default to 0 or false). */
export interface CreateGroupInput {
  readonly name: string;
  readonly discountPercent?: string | undefined;
  readonly earnThreshold?: string | undefined;
  readonly depositLimit?: string | undefined;
  readonly overdraftAllowed?: boolean | undefined;
  readonly isDefault?: boolean | undefined;
}

/** The fields `PATCH /admin/client-groups/:id` may change. */
export type UpdateGroupInput = Partial<CreateGroupInput>;

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const nameTaken = () => invalid('name', 'A group with this name already exists.', 'duplicate');

/** A percent as the database stores it: four decimals (`'4'` is `'4.0000'`). */
const percentText = (percent: string): string => new Decimal(percent).toFixed(4);

const snapshot = (group: ClientGroup) => ({
  name: group.name,
  discountPercent: group.discountPercent,
  isDefault: group.isDefault,
  earnThreshold: group.earnThreshold,
  depositLimit: group.depositLimit,
  overdraftAllowed: group.overdraftAllowed,
});

const toView = (group: ClientGroup, merchants: number | undefined): GroupView => ({
  id: group.id,
  name: group.name,
  kind: group.kind,
  discountPercent: group.discountPercent,
  isDefault: group.isDefault,
  earnThreshold: group.earnThreshold,
  depositLimit: group.depositLimit,
  overdraftAllowed: group.overdraftAllowed,
  sort: group.sort,
  createdAt: group.createdAt.toISOString(),
  ...(group.kind === RETAIL_GROUP_KIND || merchants === undefined ? {} : { merchantCount: merchants }),
});

/**
 * Manages merchant groups.
 *
 * Why: the groups price the catalog (discount), decide who is promoted (earn threshold), cap deposits and say whether credit is
 * allowed (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-5 and catalog-17). A default group must always exist, because
 * merchants register and are invited into it: making another group the default moves the mark in one transaction, and the
 * default group cannot be deleted or unmarked. Group rows are locked `FOR UPDATE` while they change; the code that moves a
 * merchant into a group or sets a credit limit takes `FOR SHARE` on the same row, so user rule 2 holds under concurrency.
 *
 * Side effects: writes `client_groups` (and, on delete, `service_group_prices`, `pricing_rules` and
 * `service_categories.allowed_group_ids`) and `audit_logs` (entity `client_group`).
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/client-groups` sections)
 */
@Injectable()
export class ClientGroupAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly members: MerchantGroupMembers,
    private readonly wallets: MerchantWallets,
  ) {}

  /**
   * Lists groups with their merchant counts.
   *
   * @param query the parsed list request
   * @returns the page of groups and the exact total
   */
  async list(
    query: ParsedListQuery<'sort' | 'name' | 'id' | 'createdAt'>,
  ): Promise<{ rows: GroupView[]; total: number }> {
    const { rows, total } = await listGroupRows(this.db.db, query);
    const counts = await this.members.countByGroup(
      this.db.db,
      rows.map((row) => row.id),
    );
    return { rows: rows.map((row) => toView(row, counts.get(row.id))), total };
  }

  /**
   * Shows one group.
   *
   * @param id the group id
   * @returns the group with its merchant count
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<GroupView> {
    const group = await findGroupRow(this.db.db, id);
    if (!group) throw new AppError('NOT_FOUND', { detail: 'No group has this id.' });
    return this.view(this.db.db, group);
  }

  /**
   * Creates a merchant group (kind `b2b`, last in the order).
   *
   * @param input the group fields
   * @returns the new group (no merchants yet)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name` for a repeated name)
   */
  async create(input: CreateGroupInput): Promise<GroupView> {
    return this.db.runInTransaction(async ({ tx }) => {
      if (input.isDefault) await this.lockDefaultMark(tx);
      if (await groupNameTaken(tx, input.name)) throw nameTaken();
      if (input.isDefault) await clearDefaultMark(tx);
      let group: ClientGroup;
      try {
        group = await insertGroupRow(tx, {
          name: input.name,
          kind: 'b2b',
          discountPercent: percentText(input.discountPercent ?? '0'),
          isDefault: input.isDefault ?? false,
          earnThreshold: input.earnThreshold ?? '0.0000',
          depositLimit: input.depositLimit ?? '0.0000',
          overdraftAllowed: input.overdraftAllowed ?? false,
          sort: await nextGroupSort(tx),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'client_groups_name_uq')) throw nameTaken();
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created client group',
        entityType: 'client_group',
        entityId: group.id,
        entityLabel: group.name,
        after: snapshot(group),
      });
      return toView(group, 0);
    });
  }

  /**
   * Changes a group.
   *
   * @param id the group id
   * @param changes the keys to change
   * @returns the updated group
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `name` for a repeat, on `isDefault` for the storefront
   *   group, on `overdraftAllowed` while a merchant of the group has credit); `DEFAULT_GROUP_REQUIRED` (409: `isDefault: false`
   *   on the default group)
   */
  async update(id: number, changes: UpdateGroupInput): Promise<GroupView> {
    return this.db.runInTransaction(async ({ tx }) => {
      // The advisory lock comes first, then the row lock: every change of the default mark takes them in this order.
      if (changes.isDefault !== undefined) await this.lockDefaultMark(tx);
      const before = await lockGroupRow(tx, id);
      if (!before) throw new AppError('NOT_FOUND', { detail: 'No group has this id.' });

      if (changes.name !== undefined && changes.name.toLowerCase() !== before.name.toLowerCase()) {
        if (await groupNameTaken(tx, changes.name, id)) throw nameTaken();
      }
      if (changes.isDefault === true && !before.isDefault) {
        if (before.kind === RETAIL_GROUP_KIND)
          throw invalid('isDefault', 'The storefront group cannot be the default group.');
        await clearDefaultMark(tx, id);
      } else if (changes.isDefault === false && before.isDefault) {
        throw new AppError('DEFAULT_GROUP_REQUIRED', {
          detail: 'There must always be one default group. Make another group the default instead.',
          errors: [
            { field: 'isDefault', code: 'DEFAULT_GROUP_REQUIRED', message: 'Make another group the default first.' },
          ],
        });
      }
      if (changes.overdraftAllowed === false && before.overdraftAllowed) await this.assertNoCreditHolder(tx, before);

      let after: ClientGroup | undefined;
      try {
        after = await updateGroupRow(tx, id, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.discountPercent === undefined ? {} : { discountPercent: percentText(changes.discountPercent) }),
          ...(changes.earnThreshold === undefined ? {} : { earnThreshold: changes.earnThreshold }),
          ...(changes.depositLimit === undefined ? {} : { depositLimit: changes.depositLimit }),
          ...(changes.overdraftAllowed === undefined ? {} : { overdraftAllowed: changes.overdraftAllowed }),
          ...(changes.isDefault === undefined ? {} : { isDefault: changes.isDefault }),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'client_groups_name_uq')) throw nameTaken();
        throw error;
      }
      const group = after!;
      await this.audit.record(tx, {
        action: 'edited client group',
        entityType: 'client_group',
        entityId: id,
        entityLabel: group.name,
        before: snapshot(before),
        after: snapshot(group),
      });
      return this.view(tx, group);
    });
  }

  /**
   * Deletes a group that no merchant is in, with what hangs on it.
   *
   * Why: RESOLUTIONS catalog-5: the group prices, the pricing rules of the group and the group id inside the allowed groups of
   * categories go in the same transaction (the foreign keys would otherwise answer 500); orders keep their pricing snapshot.
   *
   * @param id the group id
   * @throws {AppError} `NOT_FOUND` (404); `GROUP_IN_USE` (409: the default group, the storefront group, or merchants in it)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const group = await lockGroupRow(tx, id);
      if (!group) throw new AppError('NOT_FOUND', { detail: 'No group has this id.' });
      if (group.kind === RETAIL_GROUP_KIND) {
        throw new AppError('GROUP_IN_USE', {
          detail: 'The storefront retail group is always there and cannot be deleted.',
        });
      }
      if (group.isDefault) {
        throw new AppError('GROUP_IN_USE', {
          detail: 'The default group cannot be deleted. Make another group the default first.',
        });
      }
      const merchants = (await this.members.countByGroup(tx, [id])).get(id) ?? 0;
      if (merchants > 0) throw groupInUse(group.name, merchants);

      const removedPrices = await deleteGroupPrices(tx, id);
      const removedRuleIds = await deletePricingRulesOfGroup(tx, id);
      const categoryIds = await dropGroupFromCategories(tx, id);
      // TODO(feature 8, billing): drop this group id from `payment_gateways.allowed_group_ids` through money's public gateway
      // service in this same transaction (RESOLUTIONS catalog-5). Gateways cannot exist before that feature builds their routes.
      try {
        await deleteGroupRow(tx, id);
      } catch (error) {
        // A merchant joined between the count and the delete: the foreign key from `clients` says no.
        if (isForeignKeyViolation(error)) throw groupInUse(group.name, 1);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'deleted client group',
        entityType: 'client_group',
        entityId: id,
        entityLabel: group.name,
        before: {
          ...snapshot(group),
          removedGroupPrices: removedPrices,
          removedPricingRuleIds: removedRuleIds,
          removedFromCategoryIds: categoryIds,
        },
      });
    });
  }

  private lockDefaultMark(tx: DbExecutor): Promise<unknown> {
    return tx.execute(sql`select pg_advisory_xact_lock(${DEFAULT_MARK_LOCK_KEY})`);
  }

  /** Refuses to stop allowing overdraft while a merchant of the group has a credit limit above zero (user rule 2). */
  private async assertNoCreditHolder(tx: DbExecutor, group: ClientGroup): Promise<void> {
    const holders = await this.wallets.idsWithCreditLimit(tx);
    const inGroup = await this.members.countInGroup(tx, group.id, holders);
    if (inGroup > 0) {
      throw invalid(
        'overdraftAllowed',
        `${inGroup} ${inGroup === 1 ? 'merchant' : 'merchants'} in ${group.name} ${inGroup === 1 ? 'has' : 'have'} a credit limit. Set ${inGroup === 1 ? 'it' : 'them'} to zero first.`,
        'credit_in_use',
      );
    }
  }

  private async view(db: DbExecutor, group: ClientGroup): Promise<GroupView> {
    const counts = await this.members.countByGroup(db, [group.id]);
    return toView(group, counts.get(group.id));
  }
}

function groupInUse(name: string, merchants: number): AppError {
  return new AppError('GROUP_IN_USE', {
    detail: `Move the ${merchants} ${merchants === 1 ? 'merchant' : 'merchants'} in ${name} to another group first.`,
  });
}
