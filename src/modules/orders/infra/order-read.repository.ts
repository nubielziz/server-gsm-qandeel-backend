// The order read model (map domain D, routes GET /admin/orders*, GET /client/orders*, the exports and the bulk reply match): one
// select with the joins the console's row needs, translated from the simple-rest query, with an exact count and no N+1.
import { type SQL, and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, escapeLike, listOrderBy, listWhere } from '../../../infra/db';
import { type Order, type OrderStatus, orders } from '../db/schema';
import { foreignTables as f } from './foreign-reads.repository';
import { channelSql, pastSlaPredicate, queueSql } from './order-sql';

/** An order with the names the console's row shows. */
export interface OrderRow {
  readonly order: Order;
  readonly serviceName: string;
  readonly slaMinutes: number;
  /** The service's own rules for the merchant's cancel and verify buttons. */
  readonly allowCancel: boolean;
  readonly allowVerify: boolean;
  readonly verifyWindowH: number;
  readonly categoryName: string | null;
  readonly clientName: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly supplierName: string | null;
}

/** The fields `_sort` may name on the order lists. */
export type OrderSort = 'createdAt' | 'totalPrice' | 'status' | 'id';

/** Who is asking: staff see every order, a merchant only its own. */
export type OrderScope = { readonly kind: 'staff' } | { readonly kind: 'merchant'; readonly clientId: number };

function selectRows(db: DbExecutor) {
  return db
    .select({
      order: orders,
      serviceName: f.services.name,
      slaMinutes: f.services.slaMinutes,
      allowCancel: f.services.allowCancel,
      allowVerify: f.services.allowVerify,
      verifyWindowH: f.services.verifyWindowH,
      categoryName: f.categories.name,
      clientName: f.clients.name,
      customerName: f.customers.name,
      customerEmail: f.customers.email,
      supplierName: f.suppliers.name,
    })
    .from(orders)
    .innerJoin(f.services, eq(f.services.id, orders.serviceId))
    .leftJoin(f.categories, eq(f.categories.id, f.services.categoryId))
    .leftJoin(f.clients, eq(f.clients.id, orders.clientId))
    .leftJoin(f.customers, eq(f.customers.id, orders.customerId))
    .leftJoin(f.suppliers, eq(f.suppliers.id, orders.supplierId));
}

/** The wire field to column map of the staff list: derived fields are SQL expressions. */
function staffColumns(now: Date): ListColumns {
  return {
    id: orders.id,
    createdAt: orders.createdAt,
    totalPrice: orders.totalPrice,
    status: orders.status,
    type: orders.type,
    supplierId: orders.supplierId,
    clientId: orders.clientId,
    customerId: orders.customerId,
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
 * @param text the `q` text
 * @param scope who is asking: a merchant searches its own input and service names only
 * @returns the condition
 */
function searchSql(text: string, scope: OrderScope): SQL {
  const pattern = `%${escapeLike(text)}%`;
  const parts: SQL[] = [sql`${orders.imei} ilike ${pattern}`, sql`${f.services.name} ilike ${pattern}`];
  if (scope.kind === 'staff') {
    parts.push(
      sql`${orders.supplierRef} ilike ${pattern}`,
      sql`${f.clients.name} ilike ${pattern}`,
      sql`${f.customers.name} ilike ${pattern}`,
    );
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
  const own = scope.kind === 'merchant' ? eq(orders.clientId, scope.clientId) : undefined;
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
 * @param scope staff (every order) or a merchant (its own)
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
 * @param scope staff or a merchant
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
    .leftJoin(f.clients, eq(f.clients.id, orders.clientId))
    .leftJoin(f.customers, eq(f.customers.id, orders.customerId))
    .where(whereOf(query, scope, now));
  return row?.total ?? 0;
}

/**
 * Finds one order with its joined names.
 *
 * @param db the database or a transaction
 * @param scope staff (any order) or a merchant (only its own: another's is absent)
 * @param id the order id
 * @returns the row, or `undefined`
 */
export async function findOrderRow(db: DbExecutor, scope: OrderScope, id: number): Promise<OrderRow | undefined> {
  const own = scope.kind === 'merchant' ? eq(orders.clientId, scope.clientId) : undefined;
  const [row] = await selectRows(db)
    .where(and(eq(orders.id, id), own))
    .limit(1);
  return row;
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
 * @param scope staff or a merchant
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

/**
 * Finds the orders whose input matches pasted inputs, ignoring whitespace.
 *
 * Why: the bulk reply preview matches on `orders.imei` with whitespace removed on both sides, only for non-empty inputs
 * (RESOLUTIONS orders-suppliers-2). The expression is backed by the index `orders_imei_squashed_idx`.
 *
 * @param db the database or a transaction
 * @param squashedInputs the inputs from the pasted lines, whitespace already removed
 * @returns the matching orders with their squashed input and status
 */
export async function findOrdersByInputs(
  db: DbExecutor,
  squashedInputs: readonly string[],
): Promise<Array<{ id: number; squashed: string; status: Order['status'] }>> {
  if (squashedInputs.length === 0) return [];
  const squashed = sql<string>`regexp_replace(${orders.imei}, '\\s', '', 'g')`;
  return db
    .select({ id: orders.id, squashed, status: orders.status })
    .from(orders)
    .where(and(sql`${orders.imei} is not null and ${orders.imei} <> ''`, inArray(squashed, [...squashedInputs])))
    .orderBy(asc(orders.id));
}

/** What REST v1's `GET /v1/orders` filters by. */
export interface ApiOrderFilter {
  readonly statuses?: readonly OrderStatus[] | undefined;
  readonly ids?: readonly number[] | undefined;
  /** The main input without whitespace (`orders.imei` is compared with its whitespace removed, like the bulk reply). */
  readonly input?: string | undefined;
  /** Only orders changed at or after this time (`orders.updated_at`). */
  readonly updatedSince?: Date | undefined;
}

/**
 * Reads one page of a merchant's orders by cursor, newest first.
 *
 * Why: `GET /v1/orders` pages by cursor (ALIGNMENT § 7): each page continues after the id of the last order of the previous one, so an
 * order placed meanwhile never repeats or skips one. Order ids grow with time, so the id is the order.
 *
 * @param db the database or a transaction
 * @param clientId the merchant (another merchant's orders are never read)
 * @param filter status, ids, input and `updatedSince`
 * @param options how many rows to read (the caller asks for one more than it sends) and where to continue
 * @returns the rows, newest first
 */
export async function pageMerchantOrderRows(
  db: DbExecutor,
  clientId: number,
  filter: ApiOrderFilter,
  options: { readonly limit: number; readonly beforeId?: number | undefined },
): Promise<OrderRow[]> {
  return selectRows(db)
    .where(
      and(
        eq(orders.clientId, clientId),
        options.beforeId === undefined ? undefined : lt(orders.id, options.beforeId),
        filter.statuses === undefined ? undefined : inArray(orders.status, [...filter.statuses]),
        filter.ids === undefined ? undefined : inArray(orders.id, [...filter.ids]),
        filter.input === undefined ? undefined : sql`regexp_replace(${orders.imei}, '\\s', '', 'g') = ${filter.input}`,
        filter.updatedSince === undefined ? undefined : gte(orders.updatedAt, filter.updatedSince),
      ),
    )
    .orderBy(desc(orders.id))
    .limit(options.limit);
}
