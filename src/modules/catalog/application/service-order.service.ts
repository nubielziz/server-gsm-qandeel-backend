// ServiceOrderService: the use case of `POST /admin/services/order` (decision 063): the stored order of services that the console's
// price page sets and that the merchant lists, the price export and the Dhru service list follow.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { lockServicePositions, writeServicePositions } from '../infra/service.repository';
import { CatalogPriceVersion } from './catalog-price-version';

/** One service and the position staff give it. */
export interface ServiceOrderItem {
  readonly id: number;
  readonly sort: number;
}

/** What the order answers. */
export interface ServiceOrderResult {
  /** How many services changed position (a service already at its position is not counted). */
  readonly updated: number;
}

/** The most services whose old and new positions are copied into the audit entry (the counts are always there). */
const AUDIT_DETAIL_LIMIT = 200;

/**
 * Finds the items that name a service twice.
 *
 * @param items the items in the order they were sent
 * @returns the index of every item whose id appeared earlier in the list
 */
export function repeatedItems(items: readonly ServiceOrderItem[]): number[] {
  const seen = new Set<number>();
  const repeated: number[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.id)) repeated.push(index);
    seen.add(item.id);
  });
  return repeated;
}

/**
 * Stores the order of services.
 *
 * Why: services had no position, so the merchant catalog, the price list and the Dhru service list could only show them by name
 * (decision 063). Staff set a number per service on the console's price page; the lists read services by category position, then
 * this number, then the name, so services that were never numbered keep their name order.
 *
 * Side effects: updates `services.sort` of the services that changed and writes one `audit_logs` entry (entity `service`, `changed
 * the order of`) in the same transaction; moves the catalog price version after the commit, so cached price lists start over.
 *
 * @see docs/decisions/063-price-grid-and-service-order.md
 */
@Injectable()
export class ServiceOrderService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Sets the position of some services.
   *
   * @param items the services and their positions (1 to 500, validated by the contract)
   * @returns how many services changed position
   * @throws {AppError} `VALIDATION_FAILED` (422 on `items.N.id` for a service listed twice, unknown or archived; every problem
   *   comes back together and nothing is saved)
   */
  async apply(items: readonly ServiceOrderItem[]): Promise<ServiceOrderResult> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      // Lock first, then judge and write: the positions read are the ones nobody can change until this transaction ends.
      const current = new Map(
        (
          await lockServicePositions(
            tx,
            items.map((item) => item.id),
          )
        ).map((row) => [row.id, row]),
      );
      const repeated = new Set(repeatedItems(items));
      const errors = items.flatMap((item, index) => {
        if (repeated.has(index)) {
          return [{ field: `items.${index}.id`, code: 'duplicate', message: 'This service is listed twice.' }];
        }
        if (!current.has(item.id)) {
          return [{ field: `items.${index}.id`, code: 'unknown', message: `No service has the id ${item.id}.` }];
        }
        return [];
      });
      if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });

      const changedIds = new Set(await writeServicePositions(tx, items));
      const changed = items.filter((item) => changedIds.has(item.id));
      if (changed.length > 0) this.priceVersion.bumpAfterCommit(work);
      const shown = changed.slice(0, AUDIT_DETAIL_LIMIT);
      await this.audit.record(tx, {
        action: 'changed the order of',
        entityType: 'service',
        entityLabel: `${items.length} ${items.length === 1 ? 'service' : 'services'}`,
        before: {
          services: items.length,
          changed: changed.length,
          sorts: Object.fromEntries(shown.map((item) => [current.get(item.id)!.code, current.get(item.id)!.sort])),
        },
        after: {
          services: items.length,
          changed: changed.length,
          sorts: Object.fromEntries(shown.map((item) => [current.get(item.id)!.code, item.sort])),
        },
      });
      return { updated: changed.length };
    });
  }
}
