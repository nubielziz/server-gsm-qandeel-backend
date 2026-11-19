// PublishRunAdminService: the staff use cases of a bulk publish run (feature 31, decision 040, plan 31 sections 5.2, 6.5 and 6.6): create a
// run (and "Check again"), list the runs, show one and list its rows (slice B4a), apply it (with the resume), cancel it and switch what it
// published (slice B4b). The edits of a draft's rows are PublishItemEditService.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { ParsedListQuery } from '../../../../common/contract';
import { AppError, type FieldError } from '../../../../common/errors';
import { DbService, type DbExecutor } from '../../../../infra/db';
import { CatalogPriceVersion } from '../../../catalog';
import { AuditService } from '../../../platform';
import type { ListingPublishRun } from '../../db/schema';
import { staffNamesOf } from '../../infra/foreign-reads.repository';
import { NAMING_RULES_VERSION } from '../domain/naming';
import {
  MAX_PUBLISH_ITEMS,
  PREPARE_STALLED_ERROR,
  type PublishRunCounts,
  type PublishRunView,
  STALLED_ERROR,
  SWITCH_STALLED_ERROR,
  isStalled,
  runView,
} from '../domain/publish-item';
import {
  type CopyAllowed,
  PREVIEW_NOT_FINISHED,
  applyVerdict,
  cancelVerdict,
  copyVerdict,
  switchVerdict,
} from '../domain/publish-moves';
import { cancelledRunAudit, publishRunLabel } from '../domain/publish-run';
import type { PublishItemView } from '../domain/publish-view';
import type { PublishScope } from '../domain/publish-item';
import {
  cancelRunRow,
  closeStalledRun,
  closeStalledSwitch,
  countDraftRows,
  countItemResults,
  failPrepare,
  findRun,
  insertRun,
  lockQuickAddRun,
  lockRun,
  moveRunToQueued,
  queueRunSwitch,
  reopenFailedItems,
  repointReplacedRun,
} from '../infra/publish.repository';
import {
  type PublishItemExtra,
  type PublishItemSort,
  type PublishRunSort,
  countsOfRuns,
  listItemRows,
  listRuns,
} from '../infra/publish-read.repository';
import { PUBLISH_PERMISSION, missingPermission } from './publish-permissions';
import { itemViewsOf } from './publish-item-views';
import { PublishOutbox } from './publish-outbox';
import { type ScopeField, countScope, unknownScopeReference } from './publish-scope';

/** What `POST /admin/publish-runs` takes: the scope and how the run publishes. */
export interface CreatePublishRunInput {
  readonly scope: PublishScope;
  /** Whether apply switches the listings on; left out: `true`, or the old run's for the scope `run`. */
  readonly listed?: boolean;
}

/** The test seam of {@link PublishRunAdminService.create}: product code passes nothing. */
export interface CreatePublishRunOptions {
  /** The most services a run takes (default {@link MAX_PUBLISH_ITEMS}); a test lowers it to reach `too_many` cheaply. */
  readonly maxItems?: number;
}

/** A run with no rows yet: its counts are all zero. */
const NO_ROWS: PublishRunCounts = {
  ready: 0,
  review: 0,
  blocked: 0,
  included: 0,
  noRule: 0,
  published: 0,
  skipped: 0,
  refused: 0,
  pending: 0,
};

const notFound = () => new AppError('NOT_FOUND', { detail: 'No publish run has this id.' });

function invalid(field: string, message: string, code = 'invalid'): AppError {
  const error: FieldError = { field, code, message };
  return new AppError('VALIDATION_FAILED', { errors: [error] });
}

/** The sentence of an unknown reference of a scope (`scope.runId` here is a Quick add run: a publish run is checked under its lock). */
const UNKNOWN_REFERENCE: Record<ScopeField, string> = {
  'scope.categoryId': 'No category has this id.',
  'scope.supplierId': 'No supplier has this id.',
  'scope.runId': 'No Quick add run has this id.',
};

/** The scope as the run stores it: the ticked services without repeats, in the order they were sent. */
function storedScope(scope: PublishScope): PublishScope {
  return scope.kind === 'services' ? { kind: 'services', serviceIds: [...new Set(scope.serviceIds)] } : scope;
}

/** A copy of an earlier run that was allowed: that run, under its lock, and what the copy does to it. */
interface PlannedCopy {
  readonly old: ListingPublishRun;
  readonly verdict: CopyAllowed;
}

/**
 * The staff use cases of a publish run's draft.
 *
 * Why: decision 040 and plan 31 section 5.2: the preview is a draft kept on the server (a run and its rows); creating, listing and
 * showing one write only `listing_publish_runs` and `listing_publish_items`, so a preview changes nothing a visitor or a merchant can
 * see. A read never writes: a run whose worker stopped reads `failed`.
 *
 * Side effects: `create` inserts a `listing_publish_runs` row and one `storefront.publish_prepare` outbox event in one transaction;
 * "Check again" also cancels the draft it replaces and writes the `cancelled publishing run` audit row; "Prepare again" after a "Check
 * again" that died moves the old draft's link to the new run and closes the dead run when it is still stored `preparing`, and preparing a
 * Quick add's preview by hand closes that Quick add's automatic run when it stalled while it was prepared (no audit row: nothing is
 * cancelled). `apply` moves the run to `queued` with the event `storefront.publish_apply` and the audit row `started publishing
 * to the storefront`, and a resume closes a run switch that stalled; `cancel` closes the run with the audit row `cancelled publishing run`
 * (and moves the catalog price version after its commit when a row was published); `setListed` queues the switch with the event
 * `storefront.publish_set_listed` and the audit row `started switching publishing run`. No cache key of its own.
 *
 * @see docs/briefs/31-bulk-publish.md (sections 5.2, 6.1 and 7.2)
 */
@Injectable()
export class PublishRunAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: PublishOutbox,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts a draft: inserts the run in `preparing` and asks the worker to prepare it.
   *
   * Why: plan 31 sections 5.2 and 7.2. The scope's services are counted with the same walk the preparer inserts from, so a run is never
   * refused for one count and prepared with another; a scope with nothing left to publish is refused, also when every service ticked has a
   * listing. For the scope `run` the old run is locked `FOR UPDATE` first (an edit takes it `FOR SHARE`, so no edit slips in) and
   * {@link copyVerdict} judges it: an old `draft` is cancelled in the same transaction with `replaced_by_run_id` and the audit row (one
   * live draft, never two over the same rows), and a draft whose replacement died before its preview was ready is copied again ("Prepare
   * again"). The scope `quickAddRun` is "Prepare the shop preview" of a Quick add whose hand-over died: its automatic run, when it stalled
   * while it was prepared, is closed in the same transaction. Every refusal is decided before the first write.
   *
   * @param staffId the staff member who asked
   * @param input the scope and how the run publishes
   * @param options the test seam
   * @returns the new run (`preparing`, `total` the services counted now)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `scope.categoryId`, `scope.supplierId` or `scope.runId` with the code `invalid`; on
   *   `scope` with `nothing_to_publish` or `too_many`); `CONFLICT` (409: the old run is still working, its preview was never finished, or
   *   its replacement is alive or was prepared)
   */
  async create(
    staffId: number,
    input: CreatePublishRunInput,
    options: CreatePublishRunOptions = {},
  ): Promise<PublishRunView> {
    const maxItems = options.maxItems ?? MAX_PUBLISH_ITEMS;
    const scope = storedScope(input.scope);
    const unknown = await unknownScopeReference(this.db.db, scope);
    if (unknown !== null) throw invalid(unknown, UNKNOWN_REFERENCE[unknown]);

    const run = await this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const copy = scope.kind === 'run' ? await this.planCopy(tx, scope.runId, now) : undefined;
      const listed = input.listed ?? copy?.old.listed ?? true;

      const { total, unlisted } = await countScope(tx, scope);
      if (unlisted === 0) {
        throw invalid(
          'scope',
          'Nothing to publish: every service of this choice is already on the shop.',
          'nothing_to_publish',
        );
      }
      if (total > maxItems) {
        throw invalid(
          'scope',
          `This choice has ${total} services. A run takes at most ${maxItems}: pick a category or a supplier.`,
          'too_many',
        );
      }

      const created = await insertRun(tx, {
        status: 'preparing',
        source: 'console',
        scope: { ...scope },
        listed,
        auto: false,
        rulesVersion: NAMING_RULES_VERSION,
        total,
        requestedBy: staffId,
        heartbeatAt: now,
      });
      await this.outbox.prepareRequested(tx, created.id);
      if (copy !== undefined) await this.linkCopy(tx, copy, created.id, now);
      if (scope.kind === 'quickAddRun') await this.closeStalledHandOver(tx, scope.runId, now);
      return created;
    });
    return (await this.views(this.db.db, [run]))[0]!;
  }

  /**
   * Closes the automatic run of a Quick add that stalled while it was prepared, when staff prepare that Quick add's preview by hand.
   *
   * Why: plan 31 section 6.3: its job died or sleeps, and staff took over. Left `preparing`, a worker that wakes up would finish that preview
   * and, the run being automatic, publish beside the run staff just started. Closed here, its next guarded statement finds no row and it
   * stops. A run that is alive, prepared or finished is left alone.
   */
  private async closeStalledHandOver(tx: DbExecutor, quickAddRunId: number, now: Date): Promise<void> {
    const auto = await lockQuickAddRun(tx, quickAddRunId);
    if (auto?.status === 'preparing' && isStalled(auto, now.getTime())) {
      await failPrepare(tx, auto.id, PREPARE_STALLED_ERROR, now);
    }
  }

  /**
   * Locks the run the scope `run` copies, and the run that replaced it, and judges the copy.
   *
   * Lock order between two run rows: the older first. A replacement is always newer than the run it replaces, and no path takes them the
   * other way round, so two requests cannot deadlock here. Both rows are held to the commit, so a worker that is finishing the replacement
   * either committed before this read (its `prepared_at` refuses the copy) or waits and then finds the run closed.
   */
  private async planCopy(tx: DbExecutor, runId: number, now: Date): Promise<PlannedCopy> {
    const old = await lockRun(tx, runId);
    if (old === undefined) throw invalid('scope.runId', 'No publish run has this id.');
    const replacement = old.replacedByRunId === null ? undefined : await lockRun(tx, old.replacedByRunId);
    const verdict = copyVerdict(old, replacement, now.getTime());
    if (!verdict.ok) throw new AppError(verdict.code, { detail: verdict.detail });
    return { old, verdict };
  }

  /**
   * Does to the earlier run what the copy asks, once the new run exists.
   *
   * "Prepare again" writes no audit row: it cancels nothing, and a draft is not a record of the shop (plan 31 section 5.1). The replacement
   * that is still stored `preparing` is closed here so that its worker, if it wakes up, stops at its next guarded statement and cannot
   * leave a second draft of these rows.
   */
  private async linkCopy(tx: DbExecutor, copy: PlannedCopy, newRunId: number, now: Date): Promise<void> {
    const { old, verdict } = copy;
    if (verdict.link === 'cancel') await this.replaceDraft(tx, old, newRunId, now);
    if (verdict.link !== 'repoint') return;
    if (verdict.closesReplacement) await failPrepare(tx, old.replacedByRunId!, PREPARE_STALLED_ERROR, now);
    const repointed = await repointReplacedRun(tx, old.id, newRunId);
    if (repointed === undefined) throw new Error(`Publish run ${old.id} could not be linked under its lock.`);
  }

  /**
   * Cancels the draft "Check again" replaces, inside the transaction that creates the new run.
   *
   * The old run is already locked `FOR UPDATE` and is a `draft`, so no worker is inside it and no edit can follow; the cancel writes
   * its counters from the rows, stores the new run's id and the one audit row.
   */
  private async replaceDraft(tx: DbExecutor, draft: ListingPublishRun, replacedBy: number, now: Date): Promise<void> {
    const counts = await countItemResults(tx, draft.id);
    const cancelled = await cancelRunRow(tx, draft.id, counts, now, replacedBy);
    if (cancelled === undefined) throw new Error(`Publish run ${draft.id} could not be cancelled under its lock.`);
    await this.audit.record(tx, {
      action: 'cancelled publishing run',
      entityType: 'publish_run',
      entityId: draft.id,
      entityLabel: publishRunLabel(draft.id),
      after: cancelledRunAudit(draft, counts, replacedBy),
    });
  }

  /**
   * Lists publish runs.
   *
   * @param query the parsed list request
   * @returns the page of runs and the exact total
   */
  async list(query: ParsedListQuery<PublishRunSort>): Promise<{ rows: PublishRunView[]; total: number }> {
    const { rows, total } = await listRuns(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Shows one publish run.
   *
   * @param id the run
   * @returns the run
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<PublishRunView> {
    const run = await findRun(this.db.db, id);
    if (run === undefined) throw notFound();
    return (await this.views(this.db.db, [run]))[0]!;
  }

  /**
   * Lists the rows of a publish run.
   *
   * @param runId the run
   * @param query the parsed list request (filters `state`, `included`, `result`, `flag`, `brandKind`, `afterId`, search, sorts)
   * @returns the page of rows and the exact total
   * @throws {AppError} `NOT_FOUND` (404: unknown run)
   */
  async items(
    runId: number,
    query: ParsedListQuery<PublishItemSort, PublishItemExtra>,
  ): Promise<{ rows: PublishItemView[]; total: number }> {
    if ((await findRun(this.db.db, runId)) === undefined) throw notFound();
    const { rows, total } = await listItemRows(this.db.db, runId, query);
    return { rows: await itemViewsOf(this.db.db, rows), total };
  }

  /**
   * Applies a run: the first apply of a draft, or a resume of a run whose worker stopped.
   *
   * One transaction: the run row `FOR UPDATE` (a row in flight of the worker holds it `FOR SHARE`, so the resume waits for it and no
   * worker is inside a row), the verdict of its status ({@link applyVerdict}), the guarded move to `queued` (`heartbeat_at` now, the `error`
   * of a failed run cleared, `listed` stored when sent; it also asks for `prepared_at`, so a half-evaluated draft is never applied), on a resume the rows
   * `refused: failed` set back to no result and a switch that stalled closed `failed`, the outbox event `storefront.publish_apply` and the
   * audit row. The worker that claims the run gets the next `attempt`, which stops a worker of the earlier one.
   *
   * @param runId the run
   * @param input how the run publishes, when staff send it (`listed`)
   * @returns the run, `queued`
   * @throws {AppError} `NOT_FOUND` (404); `JOB_ALREADY_RUNNING` (409: the run, or its switch, is alive); `CONFLICT` (409: the preview is
   *   still being prepared, was not finished, or the run is finished); `VALIDATION_FAILED` (422 on `included` with `nothing_included`)
   */
  async apply(runId: number, input: { readonly listed?: boolean } = {}): Promise<PublishRunView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const run = await lockRun(tx, runId);
      if (run === undefined) throw notFound();
      const verdict = applyVerdict(run, now.getTime());
      if (!verdict.ok) throw new AppError(verdict.code, { detail: verdict.detail });
      const rows = await countDraftRows(tx, runId);
      if (!verdict.resume && rows.included === 0) throw invalid('included', 'No row is included.', 'nothing_included');
      // Before the move, so the answer shows it. The move writes the heartbeat the switch reads too: left open, a switch that stalled would
      // read alive again, and its late job would claim the run and stop this apply.
      if (verdict.resume) await closeStalledSwitch(tx, runId, SWITCH_STALLED_ERROR);
      const moved = await moveRunToQueued(tx, runId, {
        now,
        ...(input.listed === undefined ? {} : { listed: input.listed }),
      });
      if (moved === undefined) throw new AppError('CONFLICT', { detail: PREVIEW_NOT_FINISHED });
      if (verdict.resume) await reopenFailedItems(tx, runId);
      await this.outbox.applyRequested(tx, runId);
      await this.audit.record(tx, {
        action: 'started publishing to the storefront',
        entityType: 'publish_run',
        entityId: runId,
        entityLabel: publishRunLabel(runId),
        after: {
          scope: moved.scope,
          total: moved.total,
          included: rows.included,
          listed: moved.listed,
          source: moved.source,
          resumed: verdict.resume,
          requestedBy: moved.requestedBy,
        },
      });
      return (await this.views(tx, [moved]))[0]!;
    });
  }

  /**
   * Cancels a run that is not finished.
   *
   * One transaction with the run row `FOR UPDATE`: every row transaction of the worker holds that row `FOR SHARE`, so the cancel waits for
   * the row in flight and the worker stops before the next one; rows already published stay published and keep their result. The three
   * counters are written from the rows, with `finished_at` and the audit row, and the catalog price version moves after the commit when a
   * row was published (a run that ends this way wrote prices too). A run that is `queued` or `running` is stopped only by a caller who may
   * publish, which the controller reads from the role and passes in.
   *
   * @param runId the run
   * @param canPublish whether the caller holds `storefront:publish`
   * @returns the run, `cancelled`
   * @throws {AppError} `NOT_FOUND` (404); `CONFLICT` (409: the run is finished); `FORBIDDEN` (403: a run that is publishing needs
   *   `storefront:publish`)
   */
  async cancel(runId: number, canPublish: boolean): Promise<PublishRunView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const run = await lockRun(tx, runId);
      if (run === undefined) throw notFound();
      const verdict = cancelVerdict(run);
      if (!verdict.ok) throw new AppError(verdict.code, { detail: verdict.detail });
      if (verdict.needsPublishPermission && !canPublish) throw missingPermission(PUBLISH_PERMISSION);
      const counts = await countItemResults(tx, runId);
      const cancelled = await cancelRunRow(tx, runId, counts, this.clock.now());
      if (cancelled === undefined) throw new Error(`Publish run ${runId} could not be cancelled under its lock.`);
      await this.audit.record(tx, {
        action: 'cancelled publishing run',
        entityType: 'publish_run',
        entityId: runId,
        entityLabel: publishRunLabel(runId),
        after: cancelledRunAudit(run, counts),
      });
      if (counts.published > 0) this.priceVersion.bumpAfterCommit(work);
      return (await this.views(tx, [cancelled]))[0]!;
    });
  }

  /**
   * Takes everything a finished run published off the shop, or puts it back: queues the run switch.
   *
   * One transaction: the run row `FOR UPDATE`, the verdict ({@link switchVerdict}), `switch_status = 'queued'` with the target (`listed` of
   * the run too), the two switch counters zeroed, `switch_error` cleared, `heartbeat_at` now, the outbox event
   * `storefront.publish_set_listed` and the audit row. A `queued` or `running` run that stalled is first closed `failed` by this
   * transaction (`STALLED_ERROR`, the three counters from the rows, its close audit row, and the price version when it published), as
   * Quick add closes a stalled run at a restart; a worker that wakes up later stops at its next row. A switch is allowed again after one
   * that is `done`, `failed` or stalled.
   *
   * @param staffId the staff member who pressed the button (the event and the audit rows of the listings carry it)
   * @param runId the run
   * @param listed the target: on the shop, or off it
   * @returns the run, with `switch.status = 'queued'`
   * @throws {AppError} `NOT_FOUND` (404); `CONFLICT` (409: the run is not finished, or published nothing); `JOB_ALREADY_RUNNING` (409: a
   *   switch is alive)
   */
  async setListed(staffId: number, runId: number, listed: boolean): Promise<PublishRunView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const now = this.clock.now();
      const run = await lockRun(tx, runId);
      if (run === undefined) throw notFound();
      const counts = await countItemResults(tx, runId);
      const verdict = switchVerdict(run, counts.published, now.getTime());
      if (!verdict.ok) throw new AppError(verdict.code, { detail: verdict.detail });
      if (verdict.closesStalledRun) {
        const closed = await closeStalledRun(tx, runId, counts, STALLED_ERROR, now);
        if (closed === undefined) throw new Error(`Publish run ${runId} could not be closed under its lock.`);
        await this.audit.record(tx, {
          action: 'published services to the storefront',
          entityType: 'publish_run',
          entityId: runId,
          entityLabel: publishRunLabel(runId),
          after: {
            status: 'failed',
            total: run.total,
            published: counts.published,
            skipped: counts.skipped,
            refused: counts.refused,
            listed: run.listed,
            requestedBy: run.requestedBy,
            error: STALLED_ERROR,
          },
        });
        if (counts.published > 0) this.priceVersion.bumpAfterCommit(work);
      }
      const queued = await queueRunSwitch(tx, runId, listed, now);
      if (queued === undefined) throw new Error(`Publish run ${runId} could not be switched under its lock.`);
      await this.outbox.switchRequested(tx, runId, listed, staffId);
      await this.audit.record(tx, {
        action: 'started switching publishing run',
        entityType: 'publish_run',
        entityId: runId,
        entityLabel: publishRunLabel(runId),
        after: { listed, published: counts.published },
      });
      return (await this.views(tx, [queued]))[0]!;
    });
  }

  /** The wire views of some runs: live counts from their rows, the staff names in one read, the stall rule at the clock's time. */
  private async views(db: DbExecutor, runs: readonly ListingPublishRun[]): Promise<PublishRunView[]> {
    const counts = await countsOfRuns(
      db,
      runs.map((run) => run.id),
    );
    const names = await staffNamesOf(
      db,
      runs.flatMap((run) => (run.requestedBy === null ? [] : [run.requestedBy])),
    );
    const nowMs = this.clock.nowMs();
    return runs.map((run) =>
      runView(
        run,
        counts.get(run.id) ?? NO_ROWS,
        run.requestedBy === null ? null : (names.get(run.requestedBy) ?? null),
        nowMs,
      ),
    );
  }
}
