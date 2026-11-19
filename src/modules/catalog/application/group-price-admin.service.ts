// GroupPriceAdminService: the replace-all use case of the group prices of a service (PUT /admin/services/:id/group-prices, map
// domain B, stage 4): the whole set is checked against the floor of each group, then replaces the old one in one transaction.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type GroupFloor, groupPriceProblems, keepStoredRetailRow, retailRowUntouched } from '../domain/group-prices';
import {
  listGroupPriceRows,
  lockGroupsShared,
  lockLiveService,
  replaceGroupPriceRows,
} from '../infra/service.repository';
import { RETAIL_GROUP_KIND } from './client-group-directory';
import { CatalogPriceVersion } from './catalog-price-version';
import { CatalogSignals } from './catalog-signals';
import { PriceResolver } from './price-resolver';
import { RetailPrices } from './retail-prices';

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

/** What a save knows about the dialog it came from. */
export interface GroupPriceSaveOptions {
  /** The retail price the dialog loaded (`null`: it loaded none); left out by a caller that does not say. */
  readonly retailPriceSeen?: string | null | undefined;
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
 * Decision 040 (feature 31): this is the second writer of the retail row (beside `RetailPrices.set`), with its own floor check
 * (`groupPriceProblems`, the same `storefrontFloor`). A retail price it changes or removes is a person's choice, so the service
 * stops following the rules; a retail price it re-sends unchanged keeps following. The dialog sends every box back, also one it filled
 * minutes ago, so it also says what it loaded (`retailPriceSeen`): a retail box left at that figure changes nothing, and the stored row
 * stays with its follow row, even if a follow pass moved the price or a publish set one meanwhile. A figure staff did change is theirs.
 *
 * Side effects: deletes and inserts `service_group_prices`, deletes the service's `retail_price_follows` row when the retail
 * price changed or is gone, writes `audit_logs` (entity `service`), moves the catalog price version after the commit.
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
    private readonly signals: CatalogSignals,
    private readonly retail: RetailPrices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Replaces the whole set of group prices.
   *
   * @param serviceId the service id
   * @param prices the new set (empty removes every fixed group price)
   * @param options what the dialog loaded, when it says
   * @returns the saved prices by group id
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `prices.N.groupId` for an unknown or
   *   repeated group, on `prices.N.price` for a price under the floor of its group or the storefront floor)
   */
  async replace(
    serviceId: number,
    prices: readonly GroupPriceInput[],
    options: GroupPriceSaveOptions = {},
  ): Promise<GroupPriceView[]> {
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

      const before = await listGroupPriceRows(tx, serviceId);
      const retailGroupId = await this.retail.retailGroupId(tx);
      const parsed = prices.map((row) => ({ groupId: row.groupId, price: Money.of(row.price) }));
      const seen = options.retailPriceSeen;
      // Under the service lock, so `before` is the price this save keeps.
      const retailKept =
        seen !== undefined &&
        retailGroupId !== undefined &&
        retailRowUntouched(parsed, retailGroupId, seen === null ? null : Money.of(seen));
      const problems = groupPriceProblems(
        parsed,
        new Map([...groups].map(([id, group]) => [id, { isRetail: group.kind === RETAIL_GROUP_KIND }])),
        floors,
        Money.of(service.basePrice),
        retailKept ? retailGroupId : undefined,
      );
      if (problems.length > 0) {
        const errors: FieldError[] = problems.map((problem) => ({
          field: problem.field,
          code: 'invalid',
          message: problem.message,
        }));
        throw new AppError('VALIDATION_FAILED', { errors });
      }

      const storedRetail = before.find((row) => row.groupId === retailGroupId);
      const rows = retailKept
        ? keepStoredRetailRow(
            prices,
            retailGroupId,
            storedRetail === undefined ? undefined : { groupId: storedRetail.groupId, price: storedRetail.price },
          )
        : prices;
      let saved;
      try {
        saved = await replaceGroupPriceRows(tx, serviceId, rows);
      } catch (error) {
        // The checks above catch a repeated group; this is the database's own backstop for the same rule.
        if (isUniqueViolation(error, 'service_group_prices_uq')) {
          throw new AppError('VALIDATION_FAILED', {
            errors: [{ field: 'prices', code: 'duplicate', message: 'Listed twice' }],
          });
        }
        throw error;
      }
      // Lock order: the service row (above), then the price rows, then the follow row.
      const retailOf = (rows: readonly { groupId: number; price: string }[]) => {
        const row = rows.find((one) => one.groupId === retailGroupId);
        return row ? Money.of(row.price) : null;
      };
      await this.retail.afterGroupReplace(tx, serviceId, retailOf(before), retailOf(saved));
      this.priceVersion.bumpAfterCommit(work);
      // Every call (feature 29): a set without the retail row takes the service off the shop's search.
      await this.signals.servicesChanged(tx, [serviceId], 'price');
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
