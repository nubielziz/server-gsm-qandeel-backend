// QuickAddService: the API's side of the supplier quick add (feature 26, B214): the supplier's groups with counts, the start of a run (a
// row and an outbox event, never slow work) and the state of a run. The worker's side is QuickAddRunner.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { RetailPricing } from '../../catalog';
import { AuditService } from '../../platform';
import type { SupplierImportServiceStatus } from '../db/schema';
import {
  PUBLISH_NEEDS_ACTIVE_MESSAGE,
  PUBLISH_NO_RULE_MESSAGE,
  type QuickAddGroup,
  type QuickAddRunView,
  STALLED_ERROR,
  handsOver,
  isStalled,
  publishModeOf,
  runView,
  uniqueGroups,
} from '../domain/quick-add';
import {
  type GroupCounts,
  countCandidates,
  failLiveRun,
  findRun,
  groupCountsOf,
  insertRun,
  latestRunOf,
  lockLiveRun,
} from '../infra/quick-add.repository';
import { findSupplier, lockSupplier } from '../infra/supplier.repository';
import { QuickAddOutbox } from './quick-add-outbox';

/** Whether a quick add also puts what it creates on the shop, and whether switched on (feature 31, plan 31 section 5.5). */
export interface QuickAddPublish {
  readonly listed: boolean;
}

/** What a quick add takes: every service of the supplier, or the services of picked groups. */
export type QuickAddStart =
  | {
      readonly scope: 'all';
      readonly serviceStatus?: SupplierImportServiceStatus | undefined;
      readonly publish?: QuickAddPublish | undefined;
    }
  | {
      readonly scope: 'groups';
      readonly groups: readonly QuickAddGroup[];
      readonly serviceStatus?: SupplierImportServiceStatus | undefined;
      readonly publish?: QuickAddPublish | undefined;
    };

/** The supplier's groups, their totals and its newest run. */
export interface ServiceGroupsView {
  readonly groups: GroupCounts[];
  readonly totals: Omit<GroupCounts, 'remoteGroup' | 'type'>;
  readonly latestRun: QuickAddRunView | null;
}

/** What `start` tells staff when no candidate is left in the scope. */
export const NOTHING_TO_ADD_MESSAGE =
  'Nothing to add: every service in this scope is already in the console, no longer available or of a type that cannot be imported.';

const notFound = () => new AppError('NOT_FOUND', { detail: 'No supplier has this id.' });

/** The 422 of a start that asks to publish what cannot be published: the field is `publish` (plan 31 section 5.5). */
const publishRefusal = (code: 'needs_active' | 'no_rule', message: string) =>
  new AppError('VALIDATION_FAILED', { errors: [{ field: 'publish', code, message }] });

/** The groups listed in an audit row: the first 20, as `TYPE: name`. */
const AUDIT_GROUP_NAMES = 20;

/**
 * Lists a supplier's service groups, starts a quick add and shows its run.
 *
 * Why: feature 26 (B214): staff add a supplier's services by whole group, or all of them, without ticking hundreds of rows. The API only
 * inserts the run and its outbox event in one transaction (decision 020); the worker does the adding in chunks.
 *
 * Side effects: `start` inserts `supplier_import_runs` and `outbox_events` (`supplier.quick_add`), may close a stalled run (and, when that
 * run asked to publish and created services, write `supplier.quick_add_done`), and writes the audit row `started quick add from`. The
 * reads write nothing.
 */
@Injectable()
export class QuickAddService {
  constructor(
    private readonly db: DbService,
    private readonly outbox: QuickAddOutbox,
    private readonly audit: AuditService,
    private readonly retailPricing: RetailPricing,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the groups of a supplier's services with their counts, and its newest run.
   *
   * @param supplierId the supplier
   * @returns one row per `(type, group)`, the totals and the latest run (`null` when there is none)
   * @throws {AppError} `NOT_FOUND`
   */
  async groups(supplierId: number): Promise<ServiceGroupsView> {
    if (!(await findSupplier(this.db.db, supplierId))) throw notFound();
    const [groups, latest] = await Promise.all([
      groupCountsOf(this.db.db, supplierId),
      latestRunOf(this.db.db, supplierId),
    ]);
    const totals = { total: 0, addable: 0, imported: 0, unavailable: 0, unsupported: 0 };
    for (const group of groups) {
      totals.total += group.total;
      totals.addable += group.addable;
      totals.imported += group.imported;
      totals.unavailable += group.unavailable;
      totals.unsupported += group.unsupported;
    }
    return { groups, totals, latestRun: latest ? runView(latest, this.clock.nowMs()) : null };
  }

  /**
   * Starts a quick add: records the run and queues it.
   *
   * Lock order: the supplier row first (as the import and the sync), then the supplier's live run.
   *
   * @param supplierId the supplier
   * @param body the scope (`all`, or 1 to 500 groups), the state the services start in (`active` by default) and whether they also go on
   *   the shop (`publish`; the caller has checked `storefront:publish`)
   * @param staffId the staff member who asked
   * @returns the new run, `queued`, with the number of candidates found now as its `total`
   * @throws {AppError} `NOT_FOUND`; `SUPPLIER_DISABLED` (a paused supplier is accepted); `JOB_ALREADY_RUNNING` (a live run that has not
   *   stalled); `VALIDATION_FAILED` (422 on `publish`, code `needs_active` when the services start switched off, or `no_rule` when no
   *   retail price rule is active; 422 on `scope`, code `nothing_to_add`: no candidate, no run is created)
   */
  async start(supplierId: number, body: QuickAddStart, staffId: number): Promise<QuickAddRunView> {
    // Decided before the first write: a switched-off service cannot go on the shop, so the two choices exclude each other.
    if (body.publish !== undefined && body.serviceStatus === 'disabled') {
      throw publishRefusal('needs_active', PUBLISH_NEEDS_ACTIVE_MESSAGE);
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const supplier = await lockSupplier(tx, supplierId);
      if (!supplier) throw notFound();
      if (supplier.status === 'disabled') {
        throw new AppError('SUPPLIER_DISABLED', {
          detail: `${supplier.name} is disabled: enable it to add its services.`,
        });
      }
      if (body.publish !== undefined && !(await this.retailPricing.anyActiveRule(tx))) {
        throw publishRefusal('no_rule', PUBLISH_NO_RULE_MESSAGE);
      }
      const now = this.clock.now();

      let closedStalledRun: Record<string, number> | undefined;
      const live = await lockLiveRun(tx, supplierId);
      if (live) {
        if (!isStalled(live, now.getTime())) {
          throw new AppError('JOB_ALREADY_RUNNING', { detail: 'A quick add for this supplier is already running.' });
        }
        // A run whose worker died (no heartbeat for QUICK_ADD_STALE_MS) is closed here; its last chunks stay.
        const closed = await failLiveRun(tx, live.id, STALLED_ERROR, now);
        const source = closed ?? live;
        // The services the stalled run did create still go to the bulk publish, as when a worker closes a run (plan 31 section 6.3).
        if (closed !== undefined && handsOver(closed)) await this.outbox.done(tx, closed);
        closedStalledRun = {
          runId: source.id,
          created: source.createdCount,
          skipped: source.skippedCount,
          failed: source.failedCount,
          total: source.total,
        };
      }

      const groups = body.scope === 'groups' ? uniqueGroups(body.groups) : [];
      const total = await countCandidates(tx, supplierId, body.scope === 'groups' ? groups : null);
      if (total === 0) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'scope', code: 'nothing_to_add', message: NOTHING_TO_ADD_MESSAGE }],
        });
      }
      const serviceStatus = body.serviceStatus ?? 'active';
      const run = await insertRun(tx, {
        supplierId,
        scope: body.scope,
        groups,
        serviceStatus,
        publishMode: publishModeOf(body.publish),
        total,
        requestedBy: staffId,
        heartbeatAt: now,
      });
      await this.outbox.requested(tx, run.id, supplierId);
      await this.audit.record(tx, {
        action: 'started quick add from',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: {
          runId: run.id,
          scope: body.scope,
          groups: groups.length,
          groupNames: groups.slice(0, AUDIT_GROUP_NAMES).map((group) => `${group.type}: ${group.remoteGroup}`),
          total,
          serviceStatus,
          ...(body.publish === undefined ? {} : { publish: publishModeOf(body.publish) }),
          ...(closedStalledRun ? { closedStalledRun } : {}),
        },
      });
      return runView(run, now.getTime());
    });
  }

  /**
   * Shows a run of a supplier.
   *
   * @param supplierId the supplier
   * @param runId the run
   * @returns the run; a live run without a heartbeat for five minutes reads as `failed` (the row is not written)
   * @throws {AppError} `NOT_FOUND` (no such run, or it belongs to another supplier)
   */
  async show(supplierId: number, runId: number): Promise<QuickAddRunView> {
    const run = await findRun(this.db.db, runId);
    if (!run || run.supplierId !== supplierId) {
      throw new AppError('NOT_FOUND', { detail: 'No quick add run has this id for this supplier.' });
    }
    return runView(run, this.clock.nowMs());
  }
}
