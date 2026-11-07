// SupplierReader: builds the wire views of suppliers (the list row and the detail) from the supplier row, the call figures, the
// order counts and the links. One place for the figures every supplier route answers with (resolutions orders-suppliers-4, -5, -7, -13,
// -16, -20); the system health view of feature 9 uses the same computations.
import { Inject, Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, type DbExecutor } from '../../../infra/db';
import { OrderSupplierMoves } from '../../orders';
import type { Supplier } from '../db/schema';
import { linkUnitCost } from '../domain/link-selection';
import { isLowBalance, runwayDays, successRate, supplierHealth, toPageHealth } from '../domain/supplier-health';
import { chainsOf, linksOfSupplier } from '../infra/supplier-catalogue.repository';
import { type SupplierListField, findSupplier, listSupplierRows } from '../infra/supplier.repository';
import { callFigures, hourlyHistory, latestChecks } from '../infra/supplier-stats.repository';

const DAY_MS = 86_400_000;

/** A supplier as the suppliers page reads it (`Supplier` of the console). */
export interface SupplierView {
  readonly id: number;
  readonly name: string;
  readonly driver: Supplier['driver'];
  readonly baseUrl: string;
  readonly username: string;
  readonly currency: string;
  readonly creditRate: string;
  readonly status: Supplier['status'];
  readonly apiKeyHint: string | null;
  readonly balance: string;
  readonly balanceCheckedAt: string | null;
  readonly lowBalanceAlert: string;
  readonly maxConcurrency: number;
  readonly rateLimitPerMin: number;
  readonly timeoutMs: number;
  readonly createdAt: string;
  readonly health: 'up' | 'degraded' | 'down';
  readonly successRate1h: number | null;
  readonly successRate24h: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly openOrders: number;
  readonly reviewOrders: number;
  readonly lowBalance: boolean;
  readonly runwayDays: number | null;
}

/** One service linked to a supplier, with its whole chain (the detail's `links`). */
export interface SupplierLinkView {
  readonly serviceId: number;
  readonly serviceName: string;
  readonly serviceCode: string | null;
  readonly serviceStatus: string;
  readonly supplierServiceId: number;
  readonly supplierServiceName: string;
  readonly priority: number;
  readonly cost: string;
  readonly slaMinutes: number | null;
  readonly chain: Array<{
    readonly priority: number;
    readonly supplierId: number;
    readonly supplierName: string;
    readonly supplierServiceId: number;
    readonly supplierServiceName: string;
  }>;
}

/** The supplier detail: the row plus the 24-hour history and the links. */
export interface SupplierDetailView extends SupplierView {
  readonly history: Array<{ readonly at: string; readonly successRate: number; readonly medianMs: number }>;
  readonly links: SupplierLinkView[];
}

/**
 * Reads suppliers for the console.
 *
 * Why: orders-suppliers-5, -7, -16, -20 and B22: health, success rates, latency, open counts and the runway are not columns; they are
 * computed from `supplier_api_logs`, the latest periodic check, the supplier's orders (through the orders module) and the balance.
 * The key is never read (`apiKeyHint` is the stored hint).
 *
 * Side effects: reads only.
 */
@Injectable()
export class SupplierReader {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists suppliers with their figures.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(query: ParsedListQuery<SupplierListField>): Promise<{ rows: SupplierView[]; total: number }> {
    const { rows, total } = await listSupplierRows(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Reads one supplier with its history and links.
   *
   * @param id the supplier id
   * @param db the database or the transaction of the change that just wrote it
   * @returns the detail, or `undefined` when there is no such supplier
   */
  async detail(id: number, db: DbExecutor = this.db.db): Promise<SupplierDetailView | undefined> {
    const supplier = await findSupplier(db, id);
    if (!supplier) return undefined;
    const [[view], history, links] = await Promise.all([
      this.views(db, [supplier]),
      hourlyHistory(db, id, this.clock.now()),
      this.links(db, supplier),
    ]);
    return {
      ...view!,
      history: history.map((point) => ({
        at: point.at.toISOString(),
        successRate: point.successRate,
        medianMs: point.medianMs,
      })),
      links,
    };
  }

  /** The list rows of some suppliers: three batched aggregates, no query per supplier. */
  private async views(db: DbExecutor, suppliers: readonly Supplier[]): Promise<SupplierView[]> {
    const ids = suppliers.map((supplier) => supplier.id);
    const now = this.clock.now();
    const [figures, checks, counts, spend] = await Promise.all([
      callFigures(db, ids, now),
      latestChecks(db, ids, now),
      this.orders.openCounts(db, ids),
      this.orders.spendSince(db, ids, new Date(now.getTime() - 7 * DAY_MS)),
    ]);
    return suppliers.map((supplier) => {
      const figure = figures.get(supplier.id);
      const runway = runwayDays({
        balance: supplier.balance,
        creditRate: supplier.creditRate,
        weeklySpend: spend.get(supplier.id) ?? '0.0000',
      });
      return {
        id: supplier.id,
        name: supplier.name,
        driver: supplier.driver,
        baseUrl: supplier.baseUrl,
        username: supplier.username,
        currency: supplier.currency,
        creditRate: supplier.creditRate,
        status: supplier.status,
        apiKeyHint: supplier.apiKeyHint,
        balance: supplier.balance,
        balanceCheckedAt: supplier.balanceCheckedAt?.toISOString() ?? null,
        lowBalanceAlert: supplier.lowBalanceAlert,
        maxConcurrency: supplier.maxConcurrency,
        rateLimitPerMin: supplier.rateLimitPerMin,
        timeoutMs: supplier.timeoutMs,
        createdAt: supplier.createdAt.toISOString(),
        health: toPageHealth(
          supplierHealth({
            status: supplier.status,
            check: checks.get(supplier.id) ?? null,
            calls: figure?.last15 ?? { total: 0, errors: 0, timeouts: 0 },
          }),
        ),
        successRate1h: figure ? successRate(figure.ok1h, figure.total1h) : null,
        successRate24h: figure ? successRate(figure.ok24h, figure.total24h) : null,
        p50Ms: figure?.p50Ms ?? null,
        p95Ms: figure?.p95Ms ?? null,
        openOrders: counts.get(supplier.id)?.open ?? 0,
        reviewOrders: counts.get(supplier.id)?.review ?? 0,
        lowBalance: isLowBalance({
          balance: supplier.balance,
          lowBalanceAlert: supplier.lowBalanceAlert,
          runwayDays: runway,
        }),
        runwayDays: runway,
      };
    });
  }

  /** The services linked to a supplier, each with its whole ordered chain. */
  private async links(db: DbExecutor, supplier: Supplier): Promise<SupplierLinkView[]> {
    const rows = await linksOfSupplier(db, supplier.id);
    const chains = await chainsOf(db, [...new Set(rows.map((row) => row.serviceId))]);
    return rows.map((row) => ({
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      serviceCode: row.serviceCode,
      serviceStatus: row.serviceStatus,
      supplierServiceId: row.supplierServiceId,
      supplierServiceName: row.supplierServiceName,
      priority: row.priority,
      cost: linkUnitCost({ credit: row.credit, creditRate: supplier.creditRate }).toWire(),
      slaMinutes: row.slaMinutes,
      chain: chains.filter((step) => step.serviceId === row.serviceId).map(({ serviceId: _service, ...step }) => step),
    }));
  }
}
