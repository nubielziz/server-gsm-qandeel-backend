// QuickAddRunner: the worker's side of the supplier quick add (feature 26, B214): claims the run, builds the work list from the supplier's
// synced services and creates the catalog services in chunks, each chunk in one transaction under the supplier row lock.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { CatalogPriceVersion, ServiceImporter, recomputeEffectiveCost } from '../../catalog';
import { AuditService, SettingsReader } from '../../platform';
import type { SupplierImportRunStatus } from '../db/schema';
import { importableType } from '../domain/import-plan';
import { linkUnitCost } from '../domain/link-selection';
import {
  MAX_ITEM_FAILURES,
  QUICK_ADD_CHUNK,
  type QuickAddRunRecord,
  TOO_MANY_FAILURES_ERROR,
  chunksOf,
  failureReason,
  runErrorText,
} from '../domain/quick-add';
import { linkedServicesOf } from '../infra/foreign-reads.repository';
import {
  type ProgressDelta,
  addRunFailure,
  addRunProgress,
  candidateIds,
  claimRun,
  finishRun,
  setRunTotal,
} from '../infra/quick-add.repository';
import { supplierServicesByIds } from '../infra/supplier-catalogue.repository';
import { findSupplier, lockSupplier } from '../infra/supplier.repository';
import {
  createImportedService,
  DEFAULT_IMPORT_SLA_MINUTES,
  IMPORT_DEFAULT_SLA_KEY,
  SLA_BOUNDS,
} from './imported-service';

/** How a call of {@link QuickAddRunner.run} ended. */
export type QuickAddOutcome = 'not_queued' | 'stopped' | 'succeeded' | 'failed';

/** Thrown inside a chunk when the run is no longer `running` (a newer start closed it): the chunk rolls back and the runner stops. */
class RunClosedError extends Error {
  constructor() {
    super('The quick add run was closed by a newer start.');
  }
}

/**
 * Runs one supplier quick add.
 *
 * Why: feature 26 (B214): the API only inserts the run and its outbox event; this does the work in the worker (queue `imports`, job
 * `supplier_quick_add`). It only creates catalog services for supplier services that are still not imported, available and of an
 * importable type; it never changes a service that exists. Every chunk takes the supplier row lock first (as the picker's import and the
 * sync do), re-reads the links inside its transaction and advances the run with a guarded update, so two runners or a runner and a newer
 * start never create a supplier service twice. A worker that dies leaves the run `running`; its heartbeat tells readers it stalled.
 *
 * Side effects: per created service, `service_categories` (when missing), `services`, `service_fields` and `service_supplier_links`;
 * `services.effective_cost`; the catalog price version moves after each chunk that created something; `supplier_import_runs` is
 * claimed, advanced and closed; one `audit_logs` row with the actor `system` at the close.
 *
 * @see docs/queues.md (imports)
 */
@Injectable()
export class QuickAddRunner {
  private readonly logger = new Logger(QuickAddRunner.name);

  constructor(
    private readonly db: DbService,
    private readonly importer: ServiceImporter,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs a queued quick add to its end.
   *
   * Idempotent: only a `queued` run is claimed, so a second delivery of the job, a second runner or a run that was closed does nothing.
   *
   * @param runId the `supplier_import_runs` row
   * @returns `not_queued` when the run was not `queued`; `stopped` when a newer start closed it while it ran; else how it ended
   * @throws {Error} what an unexpected error outside the chunks threw, after the run was closed `failed` (so the job shows in the failed
   *   list; a retry finds the run not `queued` and does nothing)
   */
  async run(runId: number): Promise<QuickAddOutcome> {
    const run = await claimRun(this.db.db, runId, this.clock.now());
    if (!run) return 'not_queued';
    try {
      const defaultSla = await this.settings.integer(IMPORT_DEFAULT_SLA_KEY, DEFAULT_IMPORT_SLA_MINUTES, SLA_BOUNDS);
      const ids = await candidateIds(this.db.db, run.supplierId, run.scope === 'all' ? null : run.groups);
      if (!(await setRunTotal(this.db.db, run.id, ids.length, this.clock.now()))) return 'stopped';
      for (const chunk of chunksOf(ids, QUICK_ADD_CHUNK)) {
        const step = await this.addChunk(run, chunk, defaultSla);
        if (step === 'stopped') return 'stopped';
        if (step === 'too_many_failures') return await this.close(run, 'failed', TOO_MANY_FAILURES_ERROR);
      }
      return await this.close(run, 'succeeded', null);
    } catch (error) {
      this.logger.error(
        `Quick add run ${run.id} of supplier ${run.supplierId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // A failing close must not hide the error that brought us here; the run then stays `running` and reads as stalled.
      await this.close(run, 'failed', runErrorText(error)).catch((closeError: unknown) => {
        this.logger.error(
          `Quick add run ${run.id} could not be closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      });
      throw error;
    }
  }

  /**
   * Adds one chunk; when it throws, tries its items one by one.
   *
   * Why: one bad supplier entry must not stop the rest. The retry also absorbs the category race of two suppliers creating the same
   * category at once (the second attempt finds it).
   */
  private async addChunk(
    run: QuickAddRunRecord,
    ids: readonly number[],
    defaultSla: number,
  ): Promise<'ok' | 'stopped' | 'too_many_failures'> {
    try {
      await this.createIn(run, ids, defaultSla);
      return 'ok';
    } catch (error) {
      if (error instanceof RunClosedError) return 'stopped';
      this.logger.warn(
        `Quick add run ${run.id}: a chunk of ${ids.length} failed (${error instanceof Error ? error.message : String(error)}); trying its items one by one.`,
      );
    }
    for (const id of ids) {
      try {
        await this.createIn(run, [id], defaultSla);
      } catch (error) {
        if (error instanceof RunClosedError) return 'stopped';
        this.logger.error(
          `Quick add run ${run.id}: supplier service ${id} could not be added: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        const [row] = await supplierServicesByIds(this.db.db, run.supplierId, [id]);
        const failed = await addRunFailure(
          this.db.db,
          run.id,
          { supplierServiceId: id, name: row?.name ?? '', reason: failureReason(error) },
          this.clock.now(),
        );
        if (failed === undefined) return 'stopped';
        if (failed >= MAX_ITEM_FAILURES) return 'too_many_failures';
      }
    }
    return 'ok';
  }

  /**
   * Creates the candidates among some supplier services in one transaction and advances the run.
   *
   * Lock order: the supplier row first (as the picker's import and the sync), then the run row (the guarded progress update).
   *
   * @throws {RunClosedError} when the run is no longer `running`: the transaction rolls back
   */
  private async createIn(run: QuickAddRunRecord, ids: readonly number[], defaultSla: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const supplier = await lockSupplier(tx, run.supplierId);
      if (!supplier) throw new RunClosedError();
      const rows = new Map((await supplierServicesByIds(tx, run.supplierId, ids)).map((row) => [row.id, row]));
      const linked = await linkedServicesOf(tx, ids);
      const made: number[] = [];
      let created = 0;
      let skipped = 0;
      let categoriesCreated = 0;
      let createdWithQuantity = 0;
      for (const id of ids) {
        const row = rows.get(id);
        // Re-checked here, inside the transaction: the list was built earlier and a sync or an import may have changed a row since.
        if (!row || linked.has(id) || !row.isAvailable || importableType(row.type) === undefined) {
          skipped += 1;
          continue;
        }
        const service = await createImportedService(tx, this.importer, {
          row,
          cost: linkUnitCost({ credit: row.credit, creditRate: supplier.creditRate }),
          defaultSla,
          status: run.serviceStatus,
        });
        made.push(service.serviceId);
        created += 1;
        if (service.categoryCreated) categoriesCreated += 1;
        if (service.withQuantity) createdWithQuantity += 1;
      }
      if (made.length > 0) {
        await recomputeEffectiveCost(tx, made);
        this.priceVersion.bumpAfterCommit(work);
      }
      const progress: ProgressDelta = { created, skipped, categoriesCreated, createdWithQuantity };
      if (!(await addRunProgress(tx, run.id, progress, this.clock.now()))) throw new RunClosedError();
    });
  }

  /** Ends the run and writes the audit row of the whole run; nothing is written when a newer start already closed the run. */
  private async close(
    run: QuickAddRunRecord,
    status: Extract<SupplierImportRunStatus, 'succeeded' | 'failed'>,
    error: string | null,
  ): Promise<QuickAddOutcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      const closed = await finishRun(tx, run.id, status, error, this.clock.now());
      if (!closed) return 'stopped';
      const supplier = await findSupplier(tx, closed.supplierId);
      await this.audit.record(tx, {
        action: 'quick added services from',
        entityType: 'supplier',
        entityId: closed.supplierId,
        entityLabel: supplier?.name ?? '',
        after: {
          runId: closed.id,
          requestedBy: closed.requestedBy,
          scope: closed.scope,
          status: closed.status,
          total: closed.total,
          created: closed.createdCount,
          skipped: closed.skippedCount,
          failed: closed.failedCount,
          categoriesCreated: closed.categoriesCreated,
          createdWithQuantity: closed.createdWithQuantity,
          serviceStatus: closed.serviceStatus,
          ...(closed.status === 'failed' ? { error: closed.error } : {}),
        },
      });
      return status;
    });
  }
}
