// ServicePriceGridService: the use case of `GET /admin/services/price-grid` (decision 063): one page of services with the cost, the
// base, shop and per-group prices and their margins, for the console's price grid.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { type PermissionHolder, requirePermission } from '../../identity';
import { type PriceGridRow, gridRow } from '../domain/price-grid';
import { supplierChainsOf } from '../infra/foreign-reads.repository';
import { listServiceRows } from '../infra/service.repository';
import { PriceResolver } from './price-resolver';
import { RetailPrices } from './retail-prices';
import { PRICING_READ_PERMISSION } from './service-read-access';

/** The sorts of the price grid: a subset of the service list's. */
export type PriceGridSort = 'name' | 'sort' | 'id';

/**
 * Reads the price grid.
 *
 * Why: the console's price page shows, per service, the cost, the base price, the shop price and one price per merchant group, each
 * with its margin. Before this route that took one read per service, and the group price a merchant pays was nowhere on the wire
 * for many services at once. Every price here is the price resolver's own result (`PricingContext.resolve`, the function orders use),
 * so the grid cannot show a price an order would not charge; the page is one list query, one load of the pricing data for its
 * services, one read of the supplier chains and one of the shop prices: a fixed number of queries, none per cell.
 *
 * Side effects: none (reads only).
 *
 * @see docs/decisions/063-price-grid-and-service-order.md
 */
@Injectable()
export class ServicePriceGridService {
  constructor(
    private readonly db: DbService,
    private readonly resolver: PriceResolver,
    private readonly retail: RetailPrices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads one page of the grid.
   *
   * @param caller the signed-in staff member (the route needs `catalog:read`; the grid also needs `pricing:read`)
   * @param query the parsed list request
   * @returns the rows and the exact total
   * @throws {AppError} `FORBIDDEN` (403) naming `pricing:read` when the caller lacks it
   */
  async list(
    caller: PermissionHolder,
    query: ParsedListQuery<PriceGridSort>,
  ): Promise<{ rows: PriceGridRow[]; total: number }> {
    requirePermission(caller, PRICING_READ_PERMISSION);
    const db = this.db.db;
    const at = this.clock.now();
    // No attention reasons: the grid has no `needsAttention` filter, so none is read.
    const { rows, total } = await listServiceRows(db, query, at, []);
    const ids = rows.map((row) => row.service.id);
    const [context, chains, sources] = await Promise.all([
      this.resolver.context(db, { serviceIds: ids, at }),
      supplierChainsOf(db, ids),
      this.retail.sources(db, ids),
    ]);
    const groups = context.merchantGroupsBySort();
    const grid: PriceGridRow[] = [];
    for (const { service, floorPrice, belowFloor } of rows) {
      const cells = groups.flatMap((group) => {
        const resolution = context.resolve({ serviceId: service.id, groupId: group.id });
        return resolution
          ? [{ groupId: group.id, fixedPrice: context.groupFixedPrice(service.id, group.id), resolution }]
          : [];
      });
      // A service archived between the page and the load is not in the context: it is left out of the page.
      if (context.service(service.id) === undefined) continue;
      const source = sources.get(service.id);
      grid.push(
        gridRow({
          service: {
            id: service.id,
            name: service.name,
            code: service.code,
            status: service.status,
            sort: service.sort,
            categoryId: service.categoryId,
            supplier: chains.get(service.id)?.supplier ?? null,
            effectiveCost: Money.of(service.effectiveCost),
            costChangedFrom: service.costWas === null ? null : Money.of(service.costWas),
            basePrice: Money.of(service.basePrice),
            floorPrice: Money.of(floorPrice),
            belowFloor,
          },
          retail: { price: source?.price ?? null, source: source?.source ?? null },
          groups: cells,
        }),
      );
    }
    return { rows: grid, total };
  }
}
