// OrderReadService: the read use cases of the order routes (admin list, one order, its timeline; the account's list, one order,
// dashboard of the merchant doors). Reads only: the order status that decisions use is never cached (decision 022).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import type { CustomerContact } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { CapabilityTokenVault } from '../../../infra/crypto';
import { type DbExecutor, DbService } from '../../../infra/db';
import { AccountWallets } from '../../money';
import { actorFactsOf, actorKey } from '../infra/foreign-reads.repository';
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

/** An account's order of a merchant door, with its timeline. */
export interface MerchantOrderDetailView extends MerchantOrderView {
  readonly events: MerchantEventView[];
}

/** The merchant dashboard: the wallet figures of the account's live wallet and its orders of the merchant doors. */
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
 * events), each read for the whole page in one query (no N+1). The buyer of every order is its account (decision 064): the staff row names
 * it with its rank; an account reads only its own orders of the merchant doors (portal, Dhru), and another account's id, or its own store
 * order's id, is `404`.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class OrderReadService {
  constructor(
    private readonly db: DbService,
    private readonly wallets: AccountWallets,
    private readonly vault: CapabilityTokenVault,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the tracking token of a storefront order.
   *
   * Why: a paid checkout shows the buyer the link that follows their order (feature 16); the customers module asks here instead of reading `orders`.
   * Decision 054: the token is revealed from its encrypted copy, or read as issued for an order placed before.
   *
   * @param db the database or a transaction
   * @param orderId the order
   * @returns the token, or `null` for an order that has none
   * @throws {DecryptionError} when the copy cannot be read (its key left the keyring)
   */
  async trackingTokenOf(db: DbExecutor, orderId: number): Promise<string | null> {
    const stored = await trackingTokenOfOrder(db, orderId);
    return stored ? this.vault.reveal('tracking', stored) : null;
  }

  /**
   * Lists a page of orders for staff.
   *
   * @param query the parsed list request
   * @param contact what the caller may see of the buyer's address (decision 047)
   * @returns the page of orders and the exact total
   */
  async listForStaff(
    query: ParsedListQuery<OrderSort>,
    contact: CustomerContact,
  ): Promise<{ rows: StaffOrderView[]; total: number }> {
    const { rows, total } = await listOrderRows(this.db.db, { kind: 'staff' }, query, this.clock.now());
    return { rows: await this.staffViews(rows, contact), total };
  }

  /**
   * Shows one order to staff.
   *
   * @param id the order id
   * @param contact what the caller may see of the buyer's address (decision 047)
   * @returns the order
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id
   */
  async showForStaff(id: number, contact: CustomerContact): Promise<StaffOrderView> {
    const row = await findOrderRow(this.db.db, { kind: 'staff' }, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    return (await this.staffViews([row], contact))[0]!;
  }

  /**
   * Reads the timeline of an order for staff, oldest first.
   *
   * Why: an event written before the accounts merged names its actor `client` or `customer`; the answer resolves it through the map to the
   * account it was, so the console never guesses (decision 064).
   *
   * @param id the order id
   * @returns every event of the order, notes included, each with the account of its actor when it has one
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id
   */
  async eventsForStaff(id: number): Promise<StaffEventView[]> {
    if (!(await findOrder(this.db.db, id))) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    const events = await eventsOfOrder(this.db.db, id);
    const facts = await actorFactsOf(
      this.db.db,
      events.flatMap((event) => (event.actorId === null ? [] : [{ type: event.actorType, id: event.actorId }])),
    );
    return events.map((event) =>
      toStaffEvent(event, event.actorId === null ? undefined : facts.get(actorKey(event.actorType, event.actorId))),
    );
  }

  /**
   * Lists a page of the signed-in account's orders of the merchant doors.
   *
   * @param accountId the signed-in account (a merchant rank)
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async listForMerchant(
    accountId: number,
    query: ParsedListQuery<OrderSort>,
  ): Promise<{ rows: MerchantOrderView[]; total: number }> {
    const now = this.clock.now();
    const { rows, total } = await listOrderRows(this.db.db, { kind: 'merchant', accountId }, query, now);
    return { rows: rows.map((row) => toMerchantOrder(row, now)), total };
  }

  /**
   * Shows one of the account's orders of a merchant door with its timeline.
   *
   * @param accountId the signed-in account
   * @param id the order id
   * @returns the order and the lines of its timeline the merchant may see
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id, another account's order, or the account's own store order
   */
  async showForMerchant(accountId: number, id: number): Promise<MerchantOrderDetailView> {
    const row = await findOrderRow(this.db.db, { kind: 'merchant', accountId }, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    const events = await eventsOfOrder(this.db.db, id, MERCHANT_EVENT_TYPES);
    return { ...toMerchantOrder(row, this.clock.now()), events: events.map(toMerchantEvent) };
  }

  /**
   * Builds the merchant dashboard: the wallet figures, the order counts and the latest orders of the merchant doors.
   *
   * Why: the counts and the latest orders leave out the account's own store orders (paid first in the shop); the wallet is the live wallet of the
   * account (a merchant rank has the wallet and hold pair).
   *
   * @param accountId the signed-in account (a merchant rank)
   * @returns the dashboard (an account that has no wallet yet reads as zeros)
   */
  async dashboard(accountId: number): Promise<MerchantDashboardView> {
    const now = this.clock.now();
    const [views, counts, latest] = await Promise.all([
      this.wallets.viewsOf(this.db.db, [accountId]),
      statusCountsOf(this.db.db, accountId),
      listOrderRows(
        this.db.db,
        { kind: 'merchant', accountId },
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
    const view = views.get(accountId);
    const zero = Money.zero().toWire();
    return {
      wallet: {
        balance: view?.balance ?? zero,
        reserved: view?.reserved ?? zero,
        creditLimit: view?.creditLimit ?? zero,
        available: view?.available ?? zero,
      },
      counts,
      openOrders: counts.pending + counts.processing,
      latestOrders: latest.rows.map((row) => toMerchantOrder(row, now)),
    };
  }

  /** Adds the dispatch counts and the review reasons of a page to its rows, in two queries. */
  private async staffViews(rows: readonly OrderRow[], contact: CustomerContact): Promise<StaffOrderView[]> {
    const ids = rows.map((row) => row.order.id);
    const [attempts, reasons] = await Promise.all([
      attemptsOf(this.db.db, ids),
      reviewReasonsOf(
        this.db.db,
        rows.filter((row) => carriesReason(row.order)).map((row) => row.order.id),
      ),
    ]);
    return rows.map((row) =>
      toStaffOrder(
        row,
        { attempts: attempts.get(row.order.id) ?? 0, reason: reasons.get(row.order.id) ?? null },
        contact,
      ),
    );
  }
}
