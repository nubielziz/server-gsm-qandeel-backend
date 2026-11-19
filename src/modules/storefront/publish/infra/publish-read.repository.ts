// The read side of the bulk publish (feature 31, plan 31 section 5.2): the runs of the history list, the live counts of a run's rows,
// and the rows of a draft joined with their service, category and listing. Every list is the simple-rest dialect with an exact count.
//
// DEVIATION to resolve when catalog exports a read: decision 016 wants the service and category facts through catalog's public
// service. Catalog exports no join that can be filtered, sorted and searched by service name and code, so this file reads `services`
// and `service_categories` with plain selects, like `foreign-reads.repository.ts` does for the listing rows. Nothing outside this file
// knows.
import { type SQL, and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedFilter, ParsedListQuery } from '../../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../../infra/db';
import {
  type ListingPublishItem,
  type ListingPublishRun,
  type PublishItemState,
  listingPublishItems as items,
  listingPublishRuns as runs,
} from '../../db/schema';
import type { BrandKind, PublishServiceType } from '../domain/naming';
import type { PublishRunCounts } from '../domain/publish-item';

/** The sorts of `GET /admin/publish-runs`. */
export type PublishRunSort = 'id' | 'createdAt';

/** The sorts of `GET /admin/publish-runs/:id/items`. */
export type PublishItemSort = 'id' | 'title' | 'cost';

/** The extra query parameter of the items list: the rows after an id ("Save and next"). */
export interface PublishItemExtra {
  readonly afterId?: number;
}

// The Quick add run a publish run belongs to: the one that asked for it (`source_run_id`, the automatic run), else the one a staff member
// named in the scope `quickAddRun` ("Prepare the shop preview", plan 31 correction 13). The cast runs only for that scope.
const QUICK_ADD_RUN_OF_RUN = sql`coalesce(${runs.sourceRunId}, case when ${runs.scope}->>'kind' = 'quickAddRun' then (${runs.scope}->>'runId')::bigint end)`;

const RUN_COLUMNS: ListColumns = {
  id: runs.id,
  createdAt: runs.createdAt,
  status: runs.status,
  source: runs.source,
  quickAddRunId: QUICK_ADD_RUN_OF_RUN,
};

/**
 * Lists one page of publish runs.
 *
 * Why: plan 31 section 5.2: the history of the Publish tab, and the lookup of the publish run of a Quick add run
 * (`?quickAddRunId=`, which also finds a run staff started with the scope `quickAddRun`: plan 31 correction 13). The filter on `status`
 * is on the stored status: a stalled run reads `failed` but is stored as it was.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page and the exact total
 */
export async function listRuns(
  db: DbExecutor,
  query: ParsedListQuery<PublishRunSort>,
): Promise<{ rows: ListingPublishRun[]; total: number }> {
  const where = listWhere(query, RUN_COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(runs)
      .where(where)
      .orderBy(...listOrderBy(query.sort, RUN_COLUMNS, runs.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(runs)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Counts the rows of some runs by state, tick, flag and result, in one grouped read.
 *
 * Why: plan 31 section 5.2: the counts of a run are read live from its rows (the three counters of the run row are written only at a
 * close and by a cancel). A run without rows has no entry here.
 *
 * @param db the database or a transaction
 * @param runIds the runs of a page
 * @returns the counts by run id
 */
export async function countsOfRuns(db: DbExecutor, runIds: readonly number[]): Promise<Map<number, PublishRunCounts>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({
      runId: items.runId,
      ready: sql<number>`(count(*) filter (where ${items.state} = 'ready'))::int`,
      review: sql<number>`(count(*) filter (where ${items.state} = 'review'))::int`,
      blocked: sql<number>`(count(*) filter (where ${items.state} = 'blocked'))::int`,
      included: sql<number>`(count(*) filter (where ${items.included}))::int`,
      noRule: sql<number>`(count(*) filter (where 'no_rule' = any(${items.flags})))::int`,
      published: sql<number>`(count(*) filter (where ${items.result} = 'published'))::int`,
      skipped: sql<number>`(count(*) filter (where ${items.result} = 'skipped'))::int`,
      refused: sql<number>`(count(*) filter (where ${items.result} = 'refused'))::int`,
      pending: sql<number>`(count(*) filter (where ${items.result} is null))::int`,
    })
    .from(items)
    .where(inArray(items.runId, [...runIds]))
    .groupBy(items.runId);
  return new Map(
    rows.map(({ runId, ...counts }) => [runId, counts satisfies PublishRunCounts] as [number, PublishRunCounts]),
  );
}

/** A draft row with the facts of its service, its category and its listing. */
export interface ItemRow {
  readonly item: ListingPublishItem;
  readonly service: {
    readonly name: string;
    readonly code: string;
    readonly type: PublishServiceType;
    readonly categoryName: string;
  };
  /** Whether the row's listing is on the shop now; `null` without a listing. */
  readonly listingListed: boolean | null;
}

const ITEM_COLUMNS: ListColumns = {
  id: items.id,
  title: items.title,
  slug: items.slug,
  cost: items.cost,
  state: items.state,
  included: items.included,
  // A row without a result is `pending`, so one filter value tells the three results and "not yet" apart.
  result: sql`coalesce(${items.result}, 'pending')`,
  brandKind: sql`${items.detected}->>'brandKind'`,
  'service.name': s.services.name,
  'service.code': s.services.code,
};

/** The columns of an item read and the joins that give it its service, its category and its listing's switch. */
function itemSelect(db: DbExecutor) {
  return db
    .select({
      item: items,
      serviceName: s.services.name,
      serviceCode: s.services.code,
      serviceType: s.services.type,
      categoryName: s.serviceCategories.name,
      listingListed: s.serviceListings.isListed,
    })
    .from(items)
    .innerJoin(s.services, eq(s.services.id, items.serviceId))
    .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
    .leftJoin(s.serviceListings, eq(s.serviceListings.id, items.listingId));
}

/** The text array literal of a closed list of identifiers (flags): letters, digits and underscores, so no escaping is needed. */
const arrayOf = (values: readonly (string | number | boolean | Date)[]): string => `{${values.join(',')}}`;

/**
 * Lists one page of the rows of a run.
 *
 * Why: plan 31 section 5.2: filters `state`, `included`, `result` (`pending`: no result yet), `flag` (the row has it), `brandKind`,
 * `afterId` (the rows after an id: the "Save and next" of the dialog) and the search `q` over the title, the address and the
 * service's name and code. `flag` is an array test and not a column comparison, so it is taken out of the generic filters here.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param query the parsed list request
 * @returns the page and the exact total
 */
export async function listItemRows(
  db: DbExecutor,
  runId: number,
  query: ParsedListQuery<PublishItemSort, PublishItemExtra>,
): Promise<{ rows: ItemRow[]; total: number }> {
  const flags = query.filters.filter((filter) => filter.field === 'flag').flatMap((filter) => filter.values);
  const generic = { filters: query.filters.filter((filter) => filter.field !== 'flag'), search: query.search };
  const extra: (SQL | undefined)[] = [eq(items.runId, runId)];
  if (flags.length > 0) extra.push(sql`${items.flags} && ${arrayOf(flags)}::text[]`);
  if (query.extra.afterId !== undefined) extra.push(gt(items.id, query.extra.afterId));
  const where = listWhere(generic, ITEM_COLUMNS, ...extra);
  const [rows, [count]] = await Promise.all([
    itemSelect(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, ITEM_COLUMNS, items.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(items)
      .innerJoin(s.services, eq(s.services.id, items.serviceId))
      .where(where),
  ]);
  return { rows: rows.map(toItemRow), total: count?.total ?? 0 };
}

/** One row of {@link itemSelect} as an {@link ItemRow}. */
function toItemRow(row: Awaited<ReturnType<typeof itemSelect>>[number]): ItemRow {
  return {
    item: row.item,
    service: { name: row.serviceName, code: row.serviceCode, type: row.serviceType, categoryName: row.categoryName },
    listingListed: row.listingListed,
  };
}

/**
 * Reads one row of a run with its service, category and listing.
 *
 * Why: plan 31 section 5.2: the answer of the row's `PATCH` is the row as the list shows it.
 *
 * @param db the database or the edit's transaction (it sees its own write)
 * @param runId the run
 * @param itemId the row
 * @returns the row, or `undefined` when this run has no such row
 */
export async function findItemRow(db: DbExecutor, runId: number, itemId: number): Promise<ItemRow | undefined> {
  const [row] = await itemSelect(db).where(and(eq(items.id, itemId), eq(items.runId, runId)));
  return row === undefined ? undefined : toItemRow(row);
}

/** The rows a bulk change selects by a filter: the filters of the rows list, without paging. */
export interface ItemSelectionFilter {
  readonly state?: PublishItemState;
  /** The row has this flag. */
  readonly flag?: string;
  readonly brandKind?: BrandKind;
  readonly included?: boolean;
  /** A contains over the title, the address and the service's name and code. */
  readonly q?: string;
}

/**
 * Reads the ids of every row of a run that a filter matches.
 *
 * Why: plan 31 section 5.2 (`bulk`, `select.filter`): "all that match" is decided on the server, over the whole run and not over the page
 * the console shows; the filters are those of `GET /admin/publish-runs/:id/items`.
 *
 * @param db the bulk's transaction
 * @param runId the run
 * @param filter what a row must match (nothing: every row)
 * @returns the ids in id order
 */
export async function selectItemIds(db: DbExecutor, runId: number, filter: ItemSelectionFilter): Promise<number[]> {
  const filters: ParsedFilter[] = [];
  if (filter.state !== undefined) filters.push({ field: 'state', op: 'eq', values: [filter.state] });
  if (filter.included !== undefined) filters.push({ field: 'included', op: 'eq', values: [filter.included] });
  if (filter.brandKind !== undefined) filters.push({ field: 'brandKind', op: 'eq', values: [filter.brandKind] });
  const text = filter.q?.trim() ?? '';
  const search = text === '' ? undefined : { text, fields: ['title', 'slug', 'service.name', 'service.code'] };
  const extra: (SQL | undefined)[] = [eq(items.runId, runId)];
  if (filter.flag !== undefined) extra.push(sql`${items.flags} && ${arrayOf([filter.flag])}::text[]`);
  const rows = await db
    .select({ id: items.id })
    .from(items)
    .innerJoin(s.services, eq(s.services.id, items.serviceId))
    .where(listWhere({ filters, search }, ITEM_COLUMNS, ...extra))
    .orderBy(asc(items.id));
  return rows.map((row) => row.id);
}

/** What a row edit needs of the other rows of its run: their address, their title and their supplier name. */
export interface OtherItem {
  readonly slug: string;
  readonly title: string;
  readonly serviceName: string;
}

/**
 * Reads the address, the title and the service name of every other row of a run.
 *
 * Why: plan 31 sections 3.2 and 5.2: a typed address that another row holds is refused (`duplicate`), a regenerated address takes the
 * next free suffix against the listings and the other rows, and a title another row has under a different supplier name is a likely
 * twin (`title_taken`). A run holds at most 5000 rows.
 *
 * @param db the edit's transaction
 * @param runId the run
 * @param exceptItemId the row being edited
 * @returns the other rows' fields
 */
export function otherItemsOf(db: DbExecutor, runId: number, exceptItemId: number): Promise<OtherItem[]> {
  return db
    .select({ slug: items.slug, title: items.title, serviceName: s.services.name })
    .from(items)
    .innerJoin(s.services, eq(s.services.id, items.serviceId))
    .where(and(eq(items.runId, runId), ne(items.id, exceptItemId)));
}
