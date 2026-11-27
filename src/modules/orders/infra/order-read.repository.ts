// The order read model (map domain D, routes GET /admin/orders*, GET /client/orders*, the exports and the bulk reply match): one
// select with the joins the console's row needs, translated from the simple-rest query, with an exact count and no N+1. The buyer is
// the account of the order (decision 064): one join to `clients` and one to its rank replace the two buyer joins of before.
import { type SQL, and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, escapeLike, listOrderBy, listWhere } from '../../../infra/db';
import { type RankKind, rankKindOf } from '../../identity';
import { type Order, orders } from '../db/schema';
import type { ShopOrderRow } from '../ports/shop-orders';
import { foreignTables as f } from './foreign-reads.repository';
import { channelSql, everDispatchedSql, merchantDoorSql, pastSlaPredicate, queueSql, shopDoorSql } from './order-sql';

/** An order with the names the console's row shows. */
export interface OrderRow {
  readonly order: Order;
  readonly serviceName: string;
  readonly slaMinutes: number;
  /**
   * True once the order has a `dispatch` event (it was claimed for a supplier call at least once): the merchant's cancel is refused
   * for good, so `canCancel` is false (decision 044).
   */
  readonly everDispatched: boolean;
  /** The service's own rules for the merchant's cancel and verify buttons. */
  readonly allowCancel: boolean;
  readonly allowVerify: boolean;
  readonly verifyWindowH: number;
  readonly categoryName: string | null;
  /** The buyer: its name and address as stored (the view masks the address), and whether it has a login (`false` is a guest row). */
  readonly accountName: string;
  readonly accountEmail: string;
  readonly accountHasAccount: boolean;
  /** The buyer's rank today: its id, its name and its kind. */
  readonly rankId: number;
  readonly rankName: string;
  readonly rankKind: RankKind;
  readonly supplierName: string | null;
}

/** The fields `_sort` may name on the order lists. */
export type OrderSort = 'createdAt' | 'totalPrice' | 'status' | 'id';

/** Who is asking: staff see every order, an account only its own orders of the merchant doors (the portal and Dhru). */
export type OrderScope = { readonly kind: 'staff' } | { readonly kind: 'merchant'; readonly accountId: number };

function selectRows(db: DbExecutor) {
  return (
    db
      .select({
        order: orders,
        serviceName: f.services.name,
        slaMinutes: f.services.slaMinutes,
        everDispatched: everDispatchedSql,
        allowCancel: f.services.allowCancel,
        allowVerify: f.services.allowVerify,
        verifyWindowH: f.services.verifyWindowH,
        categoryName: f.categories.name,
        accountName: f.clients.name,
        accountEmail: f.clients.email,
        accountHasAccount: f.clients.hasAccount,
        rankId: f.groups.id,
        rankName: f.groups.name,
        // The kind of the rank is told by the one rule of identity (only `b2b` is a merchant; anything else is retail).
        rankKind: sql<string>`${f.groups.kind}`.mapWith((kind: string) => rankKindOf(kind)),
        supplierName: f.suppliers.name,
      })
      .from(orders)
      .innerJoin(f.services, eq(f.services.id, orders.serviceId))
      .leftJoin(f.categories, eq(f.categories.id, f.services.categoryId))
      // Every order has a buyer and every account a rank (both foreign keys are NOT NULL), so these two joins never drop a row.
      .innerJoin(f.clients, eq(f.clients.id, orders.accountId))
      .innerJoin(f.groups, eq(f.groups.id, f.clients.groupId))
      .leftJoin(f.suppliers, eq(f.suppliers.id, orders.supplierId))
  );
}

/**
 * The wire field to column map of the staff list: derived fields are SQL expressions.
 *
 * `accountId` is the buyer; `clientId` is its alias (a merchant's number is its account number); `rankId` is the buyer's rank today. There is no
 * `customerId`: an old customer number is not an account number, so the filter answers 422 as an unknown parameter.
 */
function staffColumns(now: Date): ListColumns {
  return {
    id: orders.id,
    createdAt: orders.createdAt,
    totalPrice: orders.totalPrice,
    status: orders.status,
    type: orders.type,
    supplierId: orders.supplierId,
    accountId: orders.accountId,
    clientId: orders.accountId,
    rankId: f.clients.groupId,
    serviceId: orders.serviceId,
    queue: queueSql,
    channel: channelSql,
    pastSla: pastSlaPredicate(now),
  };
}

/** The wire field to column map of the merchant list. */
const MERCHANT_COLUMNS: ListColumns = {
  id: orders.id,
  createdAt: orders.createdAt,
  totalPrice: orders.totalPrice,
  status: orders.status,
  type: orders.type,
  serviceId: orders.serviceId,
};

/**
 * The text search of the order lists: case-insensitive contains over the input, the supplier reference and the names, and an exact
 * match on the order id when the text is all digits (the console strips `ORD-`, `SF-` and `#`).
 *
 * Why: staff search the buyer's name, never its address (the address is masked for most staff, and a search would leak it one character at a time).
 *
 * @param text the `q` text
 * @param scope who is asking: a merchant searches its own input and service names only
 * @returns the condition
 */
function searchSql(text: string, scope: OrderScope): SQL {
  const pattern = `%${escapeLike(text)}%`;
  const parts: SQL[] = [sql`${orders.imei} ilike ${pattern}`, sql`${f.services.name} ilike ${pattern}`];
  if (scope.kind === 'staff') {
    parts.push(sql`${orders.supplierRef} ilike ${pattern}`, sql`${f.clients.name} ilike ${pattern}`);
  }
  if (/^\d{1,15}$/.test(text)) parts.push(sql`${orders.id} = ${Number(text)}`);
  return sql`(${sql.join(parts, sql` or `)})`;
}

function whereOf(
  query: Pick<ParsedListQuery, 'filters' | 'search'>,
  scope: OrderScope,
  now: Date,
  ...extra: Array<SQL | undefined>
): SQL | undefined {
  const columns = scope.kind === 'staff' ? staffColumns(now) : MERCHANT_COLUMNS;
  const own = scope.kind === 'merchant' ? merchantDoorSql(scope.accountId) : undefined;
  return listWhere(
    { filters: query.filters, search: undefined },
    columns,
    own,
    query.search ? searchSql(query.search.text, scope) : undefined,
    ...extra,
  );
}

/**
 * Lists one page of orders.
 *
 * @param db the database or a transaction
 * @param scope staff (every order) or an account (its own orders of the merchant doors)
 * @param query the parsed list request
 * @param now the injected clock's time (the past-SLA filter)
 * @returns the rows of the page and the exact total before paging
 */
export async function listOrderRows(
  db: DbExecutor,
  scope: OrderScope,
  query: ParsedListQuery<OrderSort>,
  now: Date,
): Promise<{ rows: OrderRow[]; total: number }> {
  const where = whereOf(query, scope, now);
  const columns = scope.kind === 'staff' ? staffColumns(now) : MERCHANT_COLUMNS;
  const [rows, total] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, columns, orders.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    countOrderRows(db, scope, query, now),
  ]);
  return { rows, total };
}

/**
 * Counts the orders a list request matches (without paging).
 *
 * @param db the database or a transaction
 * @param scope staff or an account
 * @param query the parsed list request
 * @param now the injected clock's time
 * @returns the exact number of matching orders
 */
export async function countOrderRows(
  db: DbExecutor,
  scope: OrderScope,
  query: Pick<ParsedListQuery, 'filters' | 'search'>,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(f.services, eq(f.services.id, orders.serviceId))
    .leftJoin(f.clients, eq(f.clients.id, orders.accountId))
    .where(whereOf(query, scope, now));
  return row?.total ?? 0;
}

/**
 * Finds one order with its joined names.
 *
 * @param db the database or a transaction
 * @param scope staff (any order) or an account (only its own orders of the merchant doors: another account's, and its own store
 *   orders, are absent)
 * @param id the order id
 * @returns the row, or `undefined`
 */
export async function findOrderRow(db: DbExecutor, scope: OrderScope, id: number): Promise<OrderRow | undefined> {
  const own = scope.kind === 'merchant' ? merchantDoorSql(scope.accountId) : undefined;
  const [row] = await selectRows(db)
    .where(and(eq(orders.id, id), own))
    .limit(1);
  return row;
}

/** The columns of the shop's own order list: the filter and the sorts of `GET /store/v1/me/orders`. */
const SHOP_COLUMNS: ListColumns = {
  status: orders.status,
  createdAt: orders.createdAt,
  totalPrice: orders.totalPrice,
};

/**
 * Lists one account's own store orders.
 *
 * Why: `GET /store/v1/me/orders`: the condition `account_id = :id and source = 'store'` comes from the session, never from the request, so no
 * account can read another's orders, and an account that was a merchant sees only what it bought in the shop. The service is named as the shop
 * published it (its listing's title), else by its catalog name (feature 31).
 *
 * @param db the database or a transaction
 * @param accountId the signed-in account
 * @param query the parsed list request (`status` filter, `createdAt` or `totalPrice` sort)
 * @returns the page of orders and the exact total
 */
export async function listShopOrderRows(
  db: DbExecutor,
  accountId: number,
  query: ParsedListQuery<'createdAt' | 'totalPrice'>,
): Promise<{ rows: ShopOrderRow[]; total: number }> {
  const where = listWhere(query, SHOP_COLUMNS, shopDoorSql(accountId));
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: orders.id,
        status: orders.status,
        serviceId: orders.serviceId,
        serviceName: sql<string>`coalesce(${f.listings.publicTitle}, ${f.services.name})`,
        imei: orders.imei,
        quantity: orders.quantity,
        totalPrice: orders.totalPrice,
        taxAmount: orders.taxAmount,
        currency: orders.currency,
        publicToken: orders.publicToken,
        publicTokenEnc: orders.publicTokenEnc,
        createdAt: orders.createdAt,
        completedAt: orders.completedAt,
      })
      .from(orders)
      .innerJoin(f.services, eq(f.services.id, orders.serviceId))
      .leftJoin(f.listings, eq(f.listings.serviceId, orders.serviceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, SHOP_COLUMNS, orders.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(orders)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/** Where an export batch continues: the sort value and the id of the last row written. */
export interface ExportCursor {
  readonly value: string;
  readonly id: number;
}

const SORT_EXPRESSIONS: Readonly<Record<OrderSort, SQL>> = {
  createdAt: sql`${orders.createdAt}`,
  totalPrice: sql`${orders.totalPrice}`,
  status: sql`${orders.status}`,
  id: sql`${orders.id}`,
};

/**
 * Reads one batch of an export, in the requested order, after the last row of the previous batch.
 *
 * Why: the export streams up to 100,000 rows; paging by OFFSET would repeat or skip rows when orders arrive meanwhile, so each
 * batch continues after the `(sort value, id)` of the last one (keyset paging). The id breaks ties in the same direction as the
 * sort, as `listOrderBy` does.
 *
 * @param db the database
 * @param scope staff or an account
 * @param query the parsed list request (its filters, search and first sort key; the range is ignored)
 * @param now the injected clock's time
 * @param limit the batch size
 * @param after the cursor of the previous batch, or `undefined` for the first
 * @returns the rows of the batch
 */
export async function exportOrderRows(
  db: DbExecutor,
  scope: OrderScope,
  query: Pick<ParsedListQuery<OrderSort>, 'filters' | 'search' | 'sort'>,
  now: Date,
  limit: number,
  after?: ExportCursor,
): Promise<OrderRow[]> {
  const key = query.sort[0] ?? { field: 'createdAt' as const, order: 'desc' as const };
  const expression = SORT_EXPRESSIONS[key.field];
  const direction = key.order === 'asc' ? sql`>` : sql`<`;
  const cursor = after ? sql`(${expression}, ${orders.id}) ${direction} (${after.value}, ${after.id})` : undefined;
  return selectRows(db)
    .where(whereOf(query, scope, now, cursor))
    .orderBy(
      key.order === 'asc' ? asc(expression) : desc(expression),
      key.order === 'asc' ? asc(orders.id) : desc(orders.id),
    )
    .limit(limit);
}

/** An order that carries a pasted input, with what the bulk reply needs to match it and to name it. */
export interface InputMatchRow {
  readonly id: number;
  readonly squashed: string;
  readonly status: Order['status'];
  /** The buyer: an account of any rank (the bulk reply keeps two accounts' orders apart). */
  readonly accountId: number;
  readonly serviceId: number;
  /** When the order was closed (`completed_at`, else `updated_at` for a row closed without it). */
  readonly closedAt: Date;
  readonly accountName: string;
  readonly serviceName: string;
}

/**
 * Finds the orders whose input matches pasted inputs, ignoring whitespace.
 *
 * Why: the bulk reply preview matches on `orders.imei` with whitespace removed on both sides, only for non-empty inputs
 * (RESOLUTIONS orders-suppliers-2). The expression is backed by the index `orders_imei_squashed_idx`. The buyer, the service and the
 * closing time let the preview keep a line from another account's or service's order and name the order a line completes.
 *
 * @param db the database or a transaction
 * @param squashedInputs the inputs from the pasted lines, whitespace already removed
 * @returns the matching orders with their squashed input, status, buyer, service, closing time and names
 */
export async function findOrdersByInputs(db: DbExecutor, squashedInputs: readonly string[]): Promise<InputMatchRow[]> {
  if (squashedInputs.length === 0) return [];
  const squashed = sql<string>`regexp_replace(${orders.imei}, '\\s', '', 'g')`;
  return db
    .select({
      id: orders.id,
      squashed,
      status: orders.status,
      accountId: orders.accountId,
      serviceId: orders.serviceId,
      closedAt: sql<Date>`coalesce(${orders.completedAt}, ${orders.updatedAt})`.mapWith(orders.completedAt),
      accountName: f.clients.name,
      serviceName: f.services.name,
    })
    .from(orders)
    .innerJoin(f.services, eq(f.services.id, orders.serviceId))
    .innerJoin(f.clients, eq(f.clients.id, orders.accountId))
    .where(and(sql`${orders.imei} is not null and ${orders.imei} <> ''`, inArray(squashed, [...squashedInputs])))
    .orderBy(asc(orders.id));
}
