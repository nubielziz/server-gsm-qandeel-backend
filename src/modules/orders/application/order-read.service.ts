// OrderReadService: the read use cases of the order routes (admin list, one order, its timeline; the merchant's list, one order,
// dashboard). Reads only: the order status that decisions use is never cached (decision 022).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { MerchantWallets } from '../../money';
import { actorKey, actorNamesOf } from '../infra/foreign-reads.repository';
import { attemptsOf, eventsOfOrder, findOrder, reviewReasonsOf } from '../infra/order.repository';
import { type OrderRow, type OrderSort, findOrderRow, listOrderRows } from '../infra/order-read.repository';
import { statusCountsOf } from '../infra/order-stats.repository';
import { trackingTokenOfOrder } from '../infra/tracking.repository';
import {
  MERCHANT_EVENT_TYPES,
  type MerchantEventView,
  type MerchantOrderView,
  type StaffEventView,
  type StaffOrderView,
  carriesReason,
  toMerchantEvent,
  toMerchantOrder,
  toStaffEvent,
  toStaffOrder,
} from './order-views';

/** A merchant's order with its timeline. */
export interface MerchantOrderDetailView extends MerchantOrderView {
  readonly events: MerchantEventView[];
}

/** The merchant dashboard. */
export interface MerchantDashboardView {
  readonly wallet: { balance: string; reserved: string; creditLimit: string; available: string };
  readonly counts: { pending: number; processing: number; completed: number; rejected: number };
  readonly openOrders: number;
  readonly latestOrders: MerchantOrderView[];
}

/** How many orders the dashboard lists. */
export const DASHBOARD_LATEST = 5;

/**
 * Serves the order reads.
 *
 * Why: one read model for the console and the portal (the brief): the same joins and filters, a different view. The staff view
 * adds the derived `queue`, the `reviewReason` of the event that opened the queue and `attempts` (the number of `dispatch`
 * events), each read for the whole page in one query (no N+1). A merchant reads only its own orders; another merchant's id is `404`.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class OrderReadService {
  constructor(
    private readonly db: DbService,
    private readonly wallets: MerchantWallets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the tracking token of a storefront order.
   *
   * Why: a paid checkout shows the buyer the link that follows their order (feature 16); the customers module asks here instead of reading `orders`.
   *
   * @param db the database or a transaction
   * @param orderId the order
   * @returns the token, or `null` for an order that has none
   */
  trackingTokenOf(db: DbExecutor, orderId: number): Promise<string | null> {
    return trackingTokenOfOrder(db, orderId);
  }

  /**
   * Lists a page of orders for staff.
   *
   * @param query the parsed list request
   * @returns the page of orders and the exact total
   */
  async listForStaff(query: ParsedListQuery<OrderSort>): Promise<{ rows: StaffOrderView[]; total: number }> {
    const { rows, total } = await listOrderRows(this.db.db, { kind: 'staff' }, query, this.clock.now());
    return { rows: await this.staffViews(rows), total };
  }

  /**
   * Shows one order to staff.
   *
   * @param id the order id
   * @returns the order
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id
   */
  async showForStaff(id: number): Promise<StaffOrderView> {
    const row = await findOrderRow(this.db.db, { kind: 'staff' }, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    return (await this.staffViews([row]))[0]!;
  }

  /**
   * Reads the timeline of an order for staff, oldest first.
   *
   * @param id the order id
   * @returns every event of the order, notes included
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id
   */
  async eventsForStaff(id: number): Promise<StaffEventView[]> {
    if (!(await findOrder(this.db.db, id))) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    const events = await eventsOfOrder(this.db.db, id);
    const names = await actorNamesOf(
      this.db.db,
      events.flatMap((event) => (event.actorId === null ? [] : [{ type: event.actorType, id: event.actorId }])),
    );
    return events.map((event) =>
      toStaffEvent(event, event.actorId === null ? undefined : names.get(actorKey(event.actorType, event.actorId))),
    );
  }

  /**
   * Lists a page of the signed-in merchant's orders.
   *
   * @param clientId the merchant
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async listForMerchant(
    clientId: number,
    query: ParsedListQuery<OrderSort>,
  ): Promise<{ rows: MerchantOrderView[]; total: number }> {
    const now = this.clock.now();
    const { rows, total } = await listOrderRows(this.db.db, { kind: 'merchant', clientId }, query, now);
    return { rows: rows.map((row) => toMerchantOrder(row, now)), total };
  }

  /**
   * Shows one of the merchant's orders with its timeline.
   *
   * @param clientId the merchant
   * @param id the order id
   * @returns the order and the lines of its timeline the merchant may see
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id or another merchant's order
   */
  async showForMerchant(clientId: number, id: number): Promise<MerchantOrderDetailView> {
    const row = await findOrderRow(this.db.db, { kind: 'merchant', clientId }, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    const events = await eventsOfOrder(this.db.db, id, MERCHANT_EVENT_TYPES);
    return { ...toMerchantOrder(row, this.clock.now()), events: events.map(toMerchantEvent) };
  }

  /**
   * Builds the merchant dashboard: the wallet figures, the order counts and the latest orders.
   *
   * @param clientId the merchant
   * @returns the dashboard
   */
  async dashboard(clientId: number): Promise<MerchantDashboardView> {
    const now = this.clock.now();
    const [views, counts, latest] = await Promise.all([
      this.wallets.viewsOf(this.db.db, [clientId]),
      statusCountsOf(this.db.db, clientId),
      listOrderRows(
        this.db.db,
        { kind: 'merchant', clientId },
        {
          range: { start: 0, end: DASHBOARD_LATEST, limit: DASHBOARD_LATEST },
          sort: [{ field: 'createdAt', order: 'desc' }],
          filters: [],
          search: undefined,
          extra: {},
        },
        now,
      ),
    ]);
    return {
      wallet: views.get(clientId)!,
      counts,
      openOrders: counts.pending + counts.processing,
      latestOrders: latest.rows.map((row) => toMerchantOrder(row, now)),
    };
  }

  /** Adds the dispatch counts and the review reasons of a page to its rows, in two queries. */
  private async staffViews(rows: readonly OrderRow[]): Promise<StaffOrderView[]> {
    const ids = rows.map((row) => row.order.id);
    const [attempts, reasons] = await Promise.all([
      attemptsOf(this.db.db, ids),
      reviewReasonsOf(
        this.db.db,
        rows.filter((row) => carriesReason(row.order)).map((row) => row.order.id),
      ),
    ]);
    return rows.map((row) =>
      toStaffOrder(row, { attempts: attempts.get(row.order.id) ?? 0, reason: reasons.get(row.order.id) ?? null }),
    );
  }
}
