// PricingResolveService: the use case of GET /admin/pricing/resolve (map domain B, stage 4): the price of one service for one
// merchant with the trace, and the same service priced for every merchant group.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { PriceStep } from '../domain/price-resolution';
import { merchantOf } from '../infra/foreign-reads.repository';
import { PriceResolver } from './price-resolver';

/** The resolution as the console reads it. */
export interface ResolutionView {
  readonly price: string;
  readonly rawPrice: string;
  readonly floor: string;
  readonly clamped: boolean;
  readonly source: 'client' | 'group' | 'base';
  readonly cost: string;
  readonly minProfit: string;
  readonly margin: string;
  readonly marginPct: string;
  readonly steps: PriceStep[];
  readonly otherGroups: Array<{ group: { id: number; name: string }; price: string; clamped: boolean }>;
}

/**
 * Resolves one price for the admin price resolver tab.
 *
 * Why: the console no longer prices in the browser; it draws what the server resolved (M98). The answer is the one resolver's
 * (catalog-4), so it matches what an order would be charged now; `otherGroups` is the same service for every merchant group
 * without a client override, drawn as the "Same service, other groups" table.
 *
 * Side effects: none (reads only).
 *
 * @see docs/contract/endpoints/catalog.md (GET /admin/pricing/resolve)
 */
@Injectable()
export class PricingResolveService {
  constructor(
    private readonly db: DbService,
    private readonly resolver: PriceResolver,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Resolves a price for a merchant.
   *
   * @param serviceId the service
   * @param clientId the merchant
   * @returns the price, the raw price, the floor, the margin, the steps and the price for every merchant group
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived service, or unknown merchant)
   */
  async resolve(serviceId: number, clientId: number): Promise<ResolutionView> {
    const db = this.db.db;
    const merchant = await merchantOf(db, clientId);
    if (!merchant) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
    const context = await this.resolver.context(db, {
      serviceIds: [serviceId],
      clientIds: [clientId],
      at: this.clock.now(),
    });
    const own = context.resolve({ serviceId, groupId: merchant.groupId, clientId });
    if (!own) throw new AppError('NOT_FOUND', { detail: 'No service has this id.' });
    const otherGroups = context.merchantGroups().map((group) => {
      const other = context.resolve({ serviceId, groupId: group.id, clientId: null })!;
      return { group: { id: group.id, name: group.name }, price: other.price.toWire(), clamped: other.clamped };
    });
    return {
      price: own.price.toWire(),
      rawPrice: own.rawPrice.toWire(),
      floor: own.floor.toWire(),
      clamped: own.clamped,
      source: own.source,
      cost: own.cost.toWire(),
      minProfit: own.minProfit.toWire(),
      margin: own.margin.toWire(),
      marginPct: own.marginPct,
      steps: [...own.steps],
      otherGroups,
    };
  }
}
