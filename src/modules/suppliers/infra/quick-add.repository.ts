// Drizzle queries of the supplier quick add (feature 26, B214) on `supplier_import_runs`, and the reads of `supplier_services` it
// needs: the groups with their counts, the candidates of a scope, and the guarded writes that claim, advance and close a run.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewSupplierImportRun, type SupplierImportRun, supplierImportRuns, supplierServices } from '../db/schema';
import { IMPORTABLE_TYPES } from '../domain/import-plan';
import {
  MAX_ITEM_FAILURES,
  type QuickAddFailure,
  type QuickAddGroup,
  type QuickAddRunRecord,
} from '../domain/quick-add';
import { isImportedSql } from './supplier-catalogue.repository';

/** The counts of one supplier group: every service is in exactly one bucket. */
export interface GroupCounts {
  readonly remoteGroup: string;
  readonly type: string;
  readonly total: number;
  readonly addable: number;
  readonly imported: number;
  readonly unavailable: number;
  readonly unsupported: number;
}

/** What one chunk of a run adds to its counts. */
export interface ProgressDelta {
  readonly created: number;
  readonly skipped: number;
  readonly categoriesCreated: number;
  readonly createdWithQuantity: number;
}

/**
 * Types a stored run.
 *
 * Why: `groups` and `failures` are untyped `jsonb` lists in the schema; the writer is this module, so the shapes are known.
 *
 * @param row the stored row
 * @returns the run record the domain reads
 */
export function toRunRecord(row: SupplierImportRun): QuickAddRunRecord {
  return {
    id: row.id,
    supplierId: row.supplierId,
    scope: row.scope,
    groups: row.groups as QuickAddGroup[],
    serviceStatus: row.serviceStatus,
    status: row.status,
    total: row.total,
    createdCount: row.createdCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    categoriesCreated: row.categoriesCreated,
    createdWithQuantity: row.createdWithQuantity,
    failures: row.failures as QuickAddFailure[],
    error: row.error,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    heartbeatAt: row.heartbeatAt,
  };
}

/** The type of a supplier service is one a quick add can create (the import's `importableType`, compared in SQL). */
const importableSql = sql`lower(btrim(${supplierServices.type})) in (${sql.join(
  IMPORTABLE_TYPES.map((type) => sql`${type}`),
  sql`, `,
)})`;

/**
 * Counts a supplier's services per group.
 *
 * Why: `GET /admin/suppliers/:id/service-groups`: one row per `(type, remote_group)`; each service is counted once, in the first bucket
 * that fits: `imported` (a link exists, an archived service counts), `unavailable`, `unsupported` (type not importable), else `addable`.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @returns the groups ordered by `lower(type), lower(remote_group), type, remote_group`
 */
export async function groupCountsOf(db: DbExecutor, supplierId: number): Promise<GroupCounts[]> {
  const result = await db.execute(sql`
    select g.type as type, g.remote_group as remote_group,
      count(*)::int as total,
      (count(*) filter (where g.imported))::int as imported,
      (count(*) filter (where not g.imported and not g.is_available))::int as unavailable,
      (count(*) filter (where not g.imported and g.is_available and not g.importable))::int as unsupported,
      (count(*) filter (where not g.imported and g.is_available and g.importable))::int as addable
    from (
      select ss.type, ss.remote_group, ss.is_available,
        exists (select 1 from service_supplier_links l where l.supplier_service_id = ss.id) as imported,
        lower(btrim(ss.type)) in (${sql.join(
          IMPORTABLE_TYPES.map((type) => sql`${type}`),
          sql`, `,
        )}) as importable
      from supplier_services ss
      where ss.supplier_id = ${supplierId}
    ) g
    group by g.type, g.remote_group
    order by lower(g.type), lower(g.remote_group), g.type, g.remote_group
  `);
  return result.rows.map((row) => ({
    remoteGroup: String(row.remote_group),
    type: String(row.type),
    total: Number(row.total),
    addable: Number(row.addable),
    imported: Number(row.imported),
    unavailable: Number(row.unavailable),
    unsupported: Number(row.unsupported),
  }));
}

/** The services of a scope that a quick add would take: of this supplier, not imported, available, of an importable type. */
function candidateWhere(supplierId: number, groups: readonly QuickAddGroup[] | null) {
  const inScope =
    groups === null
      ? undefined
      : sql`(${supplierServices.type}, ${supplierServices.remoteGroup}) in (${sql.join(
          groups.map((group) => sql`(${group.type}::text, ${group.remoteGroup}::text)`),
          sql`, `,
        )})`;
  return and(
    eq(supplierServices.supplierId, supplierId),
    eq(supplierServices.isAvailable, true),
    importableSql,
    sql`not ${isImportedSql}`,
    inScope,
  );
}

/**
 * Counts the candidates of a scope.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @param groups the picked groups, or `null` for every service of the supplier
 * @returns how many services a quick add would take now
 */
export async function countCandidates(
  db: DbExecutor,
  supplierId: number,
  groups: readonly QuickAddGroup[] | null,
): Promise<number> {
  if (groups !== null && groups.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(supplierServices)
    .where(candidateWhere(supplierId, groups));
  return row?.total ?? 0;
}

/**
 * Lists the ids of the candidates of a scope.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @param groups the picked groups, or `null` for every service of the supplier
 * @returns the supplier service ids in id order (ids only: the chunks read the rows)
 */
export async function candidateIds(
  db: DbExecutor,
  supplierId: number,
  groups: readonly QuickAddGroup[] | null,
): Promise<number[]> {
  if (groups !== null && groups.length === 0) return [];
  const rows = await db
    .select({ id: supplierServices.id })
    .from(supplierServices)
    .where(candidateWhere(supplierId, groups))
    .orderBy(asc(supplierServices.id));
  return rows.map((row) => row.id);
}

/**
 * Stores a new run.
 *
 * @param db the start's transaction
 * @param row the run (`queued`)
 * @returns the stored run
 * @throws {Error} a unique violation of `supplier_import_runs_active_uq` when the supplier already has a live run
 */
export async function insertRun(db: DbExecutor, row: NewSupplierImportRun): Promise<QuickAddRunRecord> {
  const [created] = await db.insert(supplierImportRuns).values(row).returning();
  return toRunRecord(created!);
}

/**
 * Finds a run.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @returns the run, or `undefined`
 */
export async function findRun(db: DbExecutor, runId: number): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db.select().from(supplierImportRuns).where(eq(supplierImportRuns.id, runId)).limit(1);
  return row ? toRunRecord(row) : undefined;
}

/**
 * Finds a supplier's newest run.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @returns the run with the highest id, or `undefined`
 */
export async function latestRunOf(db: DbExecutor, supplierId: number): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db
    .select()
    .from(supplierImportRuns)
    .where(eq(supplierImportRuns.supplierId, supplierId))
    .orderBy(desc(supplierImportRuns.id))
    .limit(1);
  return row ? toRunRecord(row) : undefined;
}

/**
 * Finds the live run of a supplier (`queued` or `running`) and locks it.
 *
 * Why: `start` decides under this lock whether a new run may begin; the partial unique index keeps at most one.
 *
 * @param db the start's transaction (the supplier row is locked)
 * @param supplierId the supplier
 * @returns the live run, or `undefined`
 */
export async function lockLiveRun(db: DbExecutor, supplierId: number): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db
    .select()
    .from(supplierImportRuns)
    .where(
      and(eq(supplierImportRuns.supplierId, supplierId), inArray(supplierImportRuns.status, ['queued', 'running'])),
    )
    .limit(1)
    .for('update');
  return row ? toRunRecord(row) : undefined;
}

/**
 * Closes a live run as failed.
 *
 * Why: a stalled run is closed by the next start (`STALLED_ERROR`), and an unexpected error closes the run it hit.
 *
 * @param db the transaction
 * @param runId the run
 * @param error what to tell staff
 * @param now the clock's time (`finished_at`)
 * @returns the closed run, or `undefined` when it was no longer live
 */
export async function failLiveRun(
  db: DbExecutor,
  runId: number,
  error: string,
  now: Date,
): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db
    .update(supplierImportRuns)
    .set({ status: 'failed', error, finishedAt: now })
    .where(and(eq(supplierImportRuns.id, runId), inArray(supplierImportRuns.status, ['queued', 'running'])))
    .returning();
  return row ? toRunRecord(row) : undefined;
}

/**
 * Claims a queued run for this worker.
 *
 * Why: the job is idempotent: a second delivery, or a run that was closed, finds no `queued` row and does nothing.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param now the clock's time (`started_at` and the first heartbeat of the run)
 * @returns the claimed run, or `undefined` when it was not `queued`
 */
export async function claimRun(db: DbExecutor, runId: number, now: Date): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db
    .update(supplierImportRuns)
    .set({ status: 'running', startedAt: now, heartbeatAt: now })
    .where(and(eq(supplierImportRuns.id, runId), eq(supplierImportRuns.status, 'queued')))
    .returning();
  return row ? toRunRecord(row) : undefined;
}

/**
 * Sets the number of services a running run set out to add.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param total the candidates the worker found when it started
 * @param now the clock's time (the heartbeat)
 * @returns false when the run is no longer `running`
 */
export async function setRunTotal(db: DbExecutor, runId: number, total: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(supplierImportRuns)
    .set({ total, heartbeatAt: now })
    .where(and(eq(supplierImportRuns.id, runId), eq(supplierImportRuns.status, 'running')))
    .returning({ id: supplierImportRuns.id });
  return rows.length > 0;
}

/**
 * Adds what one chunk (or one item) did to a running run and moves its heartbeat.
 *
 * Why: the guarded update is the fence between two runners: when a newer start closed the run, no row matches and the caller rolls its
 * chunk back.
 *
 * @param db the chunk's transaction
 * @param runId the run
 * @param delta the counts to add
 * @param now the clock's time (the heartbeat)
 * @returns false when the run is no longer `running`
 */
export async function addRunProgress(db: DbExecutor, runId: number, delta: ProgressDelta, now: Date): Promise<boolean> {
  const rows = await db
    .update(supplierImportRuns)
    .set({
      createdCount: sql`${supplierImportRuns.createdCount} + ${delta.created}`,
      skippedCount: sql`${supplierImportRuns.skippedCount} + ${delta.skipped}`,
      categoriesCreated: sql`${supplierImportRuns.categoriesCreated} + ${delta.categoriesCreated}`,
      createdWithQuantity: sql`${supplierImportRuns.createdWithQuantity} + ${delta.createdWithQuantity}`,
      heartbeatAt: now,
    })
    .where(and(eq(supplierImportRuns.id, runId), eq(supplierImportRuns.status, 'running')))
    .returning({ id: supplierImportRuns.id });
  return rows.length > 0;
}

/**
 * Counts one item that could not be added, and keeps its name while the list holds fewer than the limit.
 *
 * @param db the database or a transaction
 * @param runId the run
 * @param failure the item
 * @param now the clock's time (the heartbeat)
 * @returns the run's failed count after this one, or `undefined` when the run is no longer `running`
 */
export async function addRunFailure(
  db: DbExecutor,
  runId: number,
  failure: QuickAddFailure,
  now: Date,
): Promise<number | undefined> {
  const [row] = await db
    .update(supplierImportRuns)
    .set({
      failedCount: sql`${supplierImportRuns.failedCount} + 1`,
      failures: sql`case when jsonb_array_length(${supplierImportRuns.failures}) < ${MAX_ITEM_FAILURES} then ${supplierImportRuns.failures} || ${JSON.stringify([failure])}::jsonb else ${supplierImportRuns.failures} end`,
      heartbeatAt: now,
    })
    .where(and(eq(supplierImportRuns.id, runId), eq(supplierImportRuns.status, 'running')))
    .returning({ failed: supplierImportRuns.failedCount });
  return row?.failed;
}

/**
 * Ends a running run.
 *
 * @param db the close's transaction
 * @param runId the run
 * @param status how it ended
 * @param error what to tell staff, or `null`
 * @param now the clock's time (`finished_at`)
 * @returns the closed run, or `undefined` when it was no longer `running` (a newer start closed it)
 */
export async function finishRun(
  db: DbExecutor,
  runId: number,
  status: 'succeeded' | 'failed',
  error: string | null,
  now: Date,
): Promise<QuickAddRunRecord | undefined> {
  const [row] = await db
    .update(supplierImportRuns)
    .set({ status, error, finishedAt: now })
    .where(and(eq(supplierImportRuns.id, runId), eq(supplierImportRuns.status, 'running')))
    .returning();
  return row ? toRunRecord(row) : undefined;
}
