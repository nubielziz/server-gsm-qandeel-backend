// GroupPriceAdminService: the replace-all use case of the group prices of a service (PUT /admin/services/:id/group-prices, map
// domain B, stage 4): the whole set is checked against the floor of each group, then replaces the old one in one transaction.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type GroupFloor, groupPriceProblems } from '../domain/group-prices';
import {
  listGroupPriceRows,
  lockGroupsShared,
  lockLiveService,
  replaceGroupPriceRows,
} from '../infra/service.repository';
import { RETAIL_GROUP_KIND } from './client-group-directory';
import { CatalogPriceVersion } from './catalog-price-version';
import { PriceResolver } from './price-resolver';

/** One group price as the console sends it (`price` is above zero, checked by the contract). */
export interface GroupPriceInput {
  readonly groupId: number;
  readonly price: string;
}

/** A group price as the console reads it. */
export interface GroupPriceView {
  readonly groupId: number;
  readonly price: string;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No service has this id.' });

/**
 * Replaces the group prices of a service.
 *
 * Why: the console edits the prices of a service for every merchant group (and the storefront's retail price) as one set
 * (RULES services 8, 15). A group left out loses its fixed price. Every row is held to its floor (RESOLUTIONS catalog-12) and the
 * whole set is judged before anything is written, so a half-valid save never lands. The service row is locked, so two saves of the
 * same service cannot interleave, and the groups named are locked `FOR SHARE`, so a group delete cannot slip in between.
 *
 * Side effects: deletes and inserts `service_group_prices`, writes `audit_logs` (entity `service`), moves the catalog price
 * version after the commit.
 *
 * @see docs/contract/endpoints/catalog.md (PUT /admin/services/:id/group-prices)
 */
@Injectable()
export class GroupPriceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly resolver: PriceResolver,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Replaces the whole set of group prices.
   *
   * @param serviceId the service id
   * @param prices the new set (empty removes every fixed group price)
   * @returns the saved prices by group id
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `prices.N.groupId` for an unknown or
   *   repeated group, on `prices.N.price` for a price under the floor of its group or the storefront floor)
   */
  async replace(serviceId: number, prices: readonly GroupPriceInput[]): Promise<GroupPriceView[]> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const service = await lockLiveService(tx, serviceId);
      if (!service) throw notFound();
      const groups = await lockGroupsShared(
        tx,
        prices.map((row) => row.groupId),
      );
      const context = await this.resolver.context(tx, { serviceIds: [serviceId], at: this.clock.now() });
      const floors = new Map<number, GroupFloor>();
      for (const groupId of groups.keys()) floors.set(groupId, context.floor(serviceId, groupId)!);

      const problems = groupPriceProblems(
        prices.map((row) => ({ groupId: row.groupId, price: Money.of(row.price) })),
        new Map([...groups].map(([id, group]) => [id, { isRetail: group.kind === RETAIL_GROUP_KIND }])),
        floors,
        Money.of(service.basePrice),
      );
      if (problems.length > 0) {
        const errors: FieldError[] = problems.map((problem) => ({
          field: problem.field,
          code: 'invalid',
          message: problem.message,
        }));
        throw new AppError('VALIDATION_FAILED', { errors });
      }

      const before = await listGroupPriceRows(tx, serviceId);
      let saved;
      try {
        saved = await replaceGroupPriceRows(tx, serviceId, prices);
      } catch (error) {
        // The checks above catch a repeated group; this is the database's own backstop for the same rule.
        if (isUniqueViolation(error, 'service_group_prices_uq')) {
          throw new AppError('VALIDATION_FAILED', {
            errors: [{ field: 'prices', code: 'duplicate', message: 'Listed twice' }],
          });
        }
        throw error;
      }
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'changed group prices of',
        entityType: 'service',
        entityId: serviceId,
        entityLabel: service.name,
        before: Object.fromEntries(before.map((row) => [`group ${row.groupId}`, row.price])),
        after: Object.fromEntries(saved.map((row) => [`group ${row.groupId}`, row.price])),
      });
      return saved.map((row) => ({ groupId: row.groupId, price: row.price }));
    });
  }
}
