// The pure rules of the supplier quick add (feature 26, B214): the constants, the groups of a scope, when a live run counts as stalled,
// how a run record reads on the wire, the chunks of the work list and the reason a failed item reports.
import { pgErrorInfo } from '../../../infra/db/pg-errors';
import type {
  QuickAddPublishMode,
  SupplierImportRunStatus,
  SupplierImportScope,
  SupplierImportServiceStatus,
} from '../db/schema';

/** How many supplier services one chunk (one transaction) creates. */
export const QUICK_ADD_CHUNK = 100;

/** How long a live run may go without a heartbeat before it reads as stalled: five minutes. */
export const QUICK_ADD_STALE_MS = 5 * 60_000;

/** The most groups one request may name; more is the scope `all`. */
export const MAX_QUICK_ADD_GROUPS = 500;

/** The failed items a run keeps; at this many failures the run stops. */
export const MAX_ITEM_FAILURES = 20;

/** What a stalled run says: the worker stopped before the run finished. */
export const STALLED_ERROR = 'The run stopped before it finished. Start it again: it continues with what is left.';

/** What a run that met too many failed items says. */
export const TOO_MANY_FAILURES_ERROR = `Too many services could not be added (${MAX_ITEM_FAILURES}). The rest was not tried.`;

/** The longest error text a run keeps. */
export const MAX_RUN_ERROR_LENGTH = 500;

/** What a Quick add that asks to publish says when its services start switched off: they cannot go on the shop. */
export const PUBLISH_NEEDS_ACTIVE_MESSAGE = 'Services added switched off cannot go on the shop.';

/** What a Quick add that asks to publish says when no retail price rule is active: the shop would have no price for them. */
export const PUBLISH_NO_RULE_MESSAGE = 'Set a retail pricing rule first.';

/** A supplier group: the pair `(type, remoteGroup)` exactly as `supplier_services` stores it. */
export interface QuickAddGroup {
  readonly type: string;
  readonly remoteGroup: string;
}

/** One service a run could not add. */
export interface QuickAddFailure {
  readonly supplierServiceId: number;
  readonly name: string;
  readonly reason: string;
}

/** A run as the repository reads it (the typed form of a `supplier_import_runs` row). */
export interface QuickAddRunRecord {
  readonly id: number;
  readonly supplierId: number;
  readonly scope: SupplierImportScope;
  readonly groups: readonly QuickAddGroup[];
  readonly serviceStatus: SupplierImportServiceStatus;
  readonly publishMode: QuickAddPublishMode;
  readonly status: SupplierImportRunStatus;
  readonly total: number;
  readonly createdCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly categoriesCreated: number;
  readonly createdWithQuantity: number;
  readonly failures: readonly QuickAddFailure[];
  readonly error: string | null;
  readonly requestedBy: number | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly heartbeatAt: Date;
}

/** A run as the console reads it (`QuickAddRun`). */
export interface QuickAddRunView {
  readonly id: number;
  readonly supplierId: number;
  readonly scope: SupplierImportScope;
  readonly groups: QuickAddGroup[];
  readonly serviceStatus: SupplierImportServiceStatus;
  readonly publish: QuickAddPublishMode;
  readonly status: SupplierImportRunStatus;
  readonly total: number;
  readonly processed: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
  readonly categoriesCreated: number;
  readonly failures: QuickAddFailure[];
  readonly error: string | null;
  readonly requestedBy: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * The stored mode of a request's `publish` choice.
 *
 * Why: plan 31 section 5.5: the body says `publish: { listed }` or nothing; the run keeps `listed`, `unlisted` or `none`.
 *
 * @param publish the body's choice, or `undefined` when the request did not ask to publish
 * @returns `none` without a choice, else `listed` or `unlisted`
 */
export function publishModeOf(publish: { readonly listed: boolean } | undefined): QuickAddPublishMode {
  if (publish === undefined) return 'none';
  return publish.listed ? 'listed' : 'unlisted';
}

/**
 * Tells whether a run that just ended hands its services to the bulk publish.
 *
 * Why: plan 31 section 6.3: a run that asked to publish and created at least one service writes `supplier.quick_add_done` in the
 * transaction that closes it, succeeded or failed, so the services of the chunks that did commit are not left out.
 *
 * @param run the closed run
 * @returns true when it asked to publish and created something
 */
export function handsOver(run: Pick<QuickAddRunRecord, 'publishMode' | 'createdCount'>): boolean {
  return run.publishMode !== 'none' && run.createdCount > 0;
}

/**
 * Drops the repeats of a list of groups, keeping the first of each.
 *
 * Why: two ticks of one group must not count its services twice; the pair is compared exactly (no trimming, no case folding), as the
 * stored text is.
 *
 * @param groups the groups a request names
 * @returns the groups without exact repeats, in the order given
 */
export function uniqueGroups(groups: readonly QuickAddGroup[]): QuickAddGroup[] {
  const seen = new Set<string>();
  const kept: QuickAddGroup[] = [];
  for (const group of groups) {
    const key = JSON.stringify([group.type, group.remoteGroup]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ type: group.type, remoteGroup: group.remoteGroup });
  }
  return kept;
}

/**
 * Tells whether a live run has stopped moving.
 *
 * Why: a worker that dies leaves its run `running` for ever; five minutes without a heartbeat (every chunk sets one) means it is gone,
 * so staff are told and the next start may close it.
 *
 * @param run the run's status and last heartbeat
 * @param nowMs the clock's time in epoch milliseconds
 * @returns true for a `queued` or `running` run whose heartbeat is older than {@link QUICK_ADD_STALE_MS}; never for a finished run
 */
export function isStalled(run: Pick<QuickAddRunRecord, 'status' | 'heartbeatAt'>, nowMs: number): boolean {
  if (run.status !== 'queued' && run.status !== 'running') return false;
  return nowMs - run.heartbeatAt.getTime() > QUICK_ADD_STALE_MS;
}

/**
 * Turns a run record into what the console reads.
 *
 * Why: a stalled run is only shown as `failed`; reading never writes the row (the next start closes it). `processed` is the three
 * counts added.
 *
 * @param run the run record
 * @param nowMs the clock's time in epoch milliseconds
 * @returns the wire shape: a stalled run reads `failed` with {@link STALLED_ERROR} and no `finishedAt`
 */
export function runView(run: QuickAddRunRecord, nowMs: number): QuickAddRunView {
  const stalled = isStalled(run, nowMs);
  return {
    id: run.id,
    supplierId: run.supplierId,
    scope: run.scope,
    groups: run.groups.map((group) => ({ type: group.type, remoteGroup: group.remoteGroup })),
    serviceStatus: run.serviceStatus,
    publish: run.publishMode,
    status: stalled ? 'failed' : run.status,
    total: run.total,
    processed: run.createdCount + run.skippedCount + run.failedCount,
    created: run.createdCount,
    skipped: run.skippedCount,
    failed: run.failedCount,
    categoriesCreated: run.categoriesCreated,
    failures: run.failures.map((failure) => ({ ...failure })),
    error: stalled ? STALLED_ERROR : run.error,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Cuts a list into chunks.
 *
 * @param ids the list
 * @param size the chunk size (at least 1)
 * @returns consecutive chunks of at most `size`, in order; empty for an empty list
 * @throws {RangeError} when `size` is not a whole number of at least 1
 */
export function chunksOf<T>(ids: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('A chunk holds at least one item.');
  const chunks: T[][] = [];
  for (let start = 0; start < ids.length; start += size) chunks.push(ids.slice(start, start + size));
  return chunks;
}

/**
 * The reason a failed item reports.
 *
 * Why: the console shows it to staff, so it never carries SQL, values or stack traces; the full error goes to the log only.
 *
 * @param error whatever the item's transaction threw
 * @returns the Postgres constraint name when the error has one, else `unexpected error`
 */
export function failureReason(error: unknown): string {
  return pgErrorInfo(error)?.constraint ?? 'unexpected error';
}

/**
 * The text a run keeps for an unexpected error.
 *
 * Why: the console shows it to staff, so a database error is reduced to its SQLSTATE and constraint (the driver's message carries the
 * statement); any other error keeps its message.
 *
 * @param error whatever was thrown
 * @returns the text cut to {@link MAX_RUN_ERROR_LENGTH} characters, or `unexpected error`
 */
export function runErrorText(error: unknown): string {
  const database = pgErrorInfo(error);
  const message = database
    ? `Database error ${database.code}${database.constraint ? ` (${database.constraint})` : ''}.`
    : error instanceof Error && error.message.trim() !== ''
      ? error.message.trim()
      : 'unexpected error';
  return message.slice(0, MAX_RUN_ERROR_LENGTH);
}
