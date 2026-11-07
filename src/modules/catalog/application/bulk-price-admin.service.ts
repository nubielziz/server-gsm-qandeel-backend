// BulkPriceAdminService: the use cases of the bulk price change (POST /admin/services/bulk-price/preview and /apply, map domain
// B, stage 4): the new base price of every service in a category or a ticked set, shown first and then written.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService, schema as s } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type BulkChangeType, bulkNewPrice, readBulkAmount } from '../domain/bulk-price';
import { findCategoryRow } from '../infra/category.repository';
import { type ServiceRow, findServiceRowsInScope, lockLiveServicesInScope } from '../infra/service.repository';
import { CatalogPriceVersion } from './catalog-price-version';

/** The body of the preview and the apply. */
export interface BulkPriceInput {
  readonly categoryId?: number | undefined;
  readonly serviceIds?: readonly number[] | undefined;
  readonly change: { readonly type: BulkChangeType; readonly value: string };
}

/** One service of the plan. */
export interface BulkPriceLine {
  readonly serviceId: number;
  readonly name: string;
  readonly code: string;
  readonly oldPrice: string;
  readonly newPrice: string;
  readonly floorPrice: string;
  readonly belowFloor: boolean;
}

/** What the preview answers. */
export interface BulkPricePreview {
  readonly lines: BulkPriceLine[];
  readonly belowFloor: number;
}

/** What the apply answers. */
export interface BulkPriceResult {
  readonly updated: number;
  readonly belowFloor: number;
}

/** The most services whose old and new prices are copied into the audit entry (the count is always there). */
const AUDIT_DETAIL_LIMIT = 200;

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

type Scope = { readonly serviceIds: readonly number[] } | { readonly categoryId: number };

/**
 * Changes the base prices of many services at once.
 *
 * Why: staff raise or lower a whole category by a percentage or an amount (RULES services 2, M100). The preview saves nothing and
 * works out each new price, the floor of each service and whether the new price falls under it. The apply recomputes from the
 * current prices inside its transaction (the preview is not a token), saves every new price, those under the floor included (the
 * accepted exception of RESOLUTIONS catalog-12: the floor still applies at order time, where an order pays `max(price, floor)`),
 * clears `cost_was` of every repriced service (catalog-14) and writes one audit entry. No merchant is involved, so the floor
 * uses the rules for every group only (catalog-1).
 *
 * Side effects (apply): updates `services.base_price` and `cost_was`, writes `audit_logs` (entity `service`, `changed prices
 * of`), moves the catalog price version after the commit.
 *
 * @see docs/contract/endpoints/catalog.md (the bulk price sections)
 */
@Injectable()
export class BulkPriceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Shows what a bulk change would do. Nothing is saved.
   *
   * @param input a category or service ids, and the change
   * @returns one line per service and the number of lines under the floor
   * @throws {AppError} `VALIDATION_FAILED` (422 on `amount` for a zero or invalid value or a price that would not be above zero,
   *   on `scope` for no category or ids, or an unknown category)
   */
  async preview(input: BulkPriceInput): Promise<BulkPricePreview> {
    const scope = await this.scopeOf(this.db.db, input);
    const { lines } = await this.plan(this.db.db, scope, input);
    return { lines, belowFloor: lines.filter((line) => line.belowFloor).length };
  }

  /**
   * Saves a bulk change.
   *
   * @param input the same body as the preview
   * @returns how many prices were saved and how many of them are under the floor
   * @throws {AppError} `VALIDATION_FAILED` (422, as the preview)
   */
  async apply(input: BulkPriceInput): Promise<BulkPriceResult> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const scope = await this.scopeOf(tx, input);
      // Lock first, then read: the plan is worked out from the prices nobody can change until this transaction ends.
      await lockLiveServicesInScope(tx, scope);
      const { lines } = await this.plan(tx, scope, input);
      const belowFloor = lines.filter((line) => line.belowFloor).length;
      if (lines.length > 0) {
        await tx.execute(sql`
          update ${s.services} as target
          set base_price = changed.price, cost_was = null, updated_at = now()
          from (values ${sql.join(
            lines.map((line) => sql`(${line.serviceId}::bigint, ${line.newPrice}::numeric)`),
            sql`, `,
          )}) as changed(id, price)
          where target.id = changed.id`);
        this.priceVersion.bumpAfterCommit(work);
      }
      const shown = lines.slice(0, AUDIT_DETAIL_LIMIT);
      await this.audit.record(tx, {
        action: 'changed prices of',
        entityType: 'service',
        entityLabel: await this.labelOf(tx, scope, lines.length),
        before: {
          change: input.change,
          services: lines.length,
          basePrices: Object.fromEntries(shown.map((line) => [line.code, line.oldPrice])),
        },
        after: {
          services: lines.length,
          belowFloor,
          basePrices: Object.fromEntries(shown.map((line) => [line.code, line.newPrice])),
        },
      });
      return { updated: lines.length, belowFloor };
    });
  }

  /** Reads the scope of the body: ticked services win over a category (as the demo's dialog sends them). */
  private async scopeOf(db: DbExecutor, input: BulkPriceInput): Promise<Scope> {
    if (input.serviceIds !== undefined && input.serviceIds.length > 0)
      return { serviceIds: [...new Set(input.serviceIds)] };
    if (input.categoryId === undefined) throw invalid('scope', 'Choose a category or tick some services.');
    if (!(await findCategoryRow(db, input.categoryId))) throw invalid('scope', 'That category does not exist.');
    return { categoryId: input.categoryId };
  }

  /** Works out every new price from the current ones; refuses a bad amount or a price that would not be above zero. */
  private async plan(db: DbExecutor, scope: Scope, input: BulkPriceInput): Promise<{ lines: BulkPriceLine[] }> {
    const amount = readBulkAmount(input.change.value);
    if ('problem' in amount) throw invalid('amount', amount.problem);
    const rows: ServiceRow[] = await findServiceRowsInScope(db, scope, this.clock.now());
    const lines = rows.map((row): BulkPriceLine => {
      const next = bulkNewPrice(Money.of(row.service.basePrice), input.change.type, amount.value);
      if (!next.isPositive()) throw invalid('amount', `The change would make ${row.service.name} free.`);
      return {
        serviceId: row.service.id,
        name: row.service.name,
        code: row.service.code,
        oldPrice: row.service.basePrice,
        newPrice: next.toWire(),
        floorPrice: row.floorPrice,
        belowFloor: next.cmp(Money.of(row.floorPrice)) < 0,
      };
    });
    return { lines };
  }

  private async labelOf(db: DbExecutor, scope: Scope, count: number): Promise<string> {
    if ('categoryId' in scope) {
      const category = await findCategoryRow(db, scope.categoryId);
      return `${count} ${count === 1 ? 'service' : 'services'} in ${category?.category.name ?? 'a category'}`;
    }
    return `${count} ${count === 1 ? 'service' : 'services'}`;
  }
}
