// LostWorkReconcile: runs the registered lost-work passes, plan first, then apply (platform module, decision 055).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { LostWorkRegistry } from './lost-work.registry';
import type { LostWorkApplied, LostWorkContext, LostWorkCounts, LostWorkItem, LostWorkPlan } from './lost-work.types';
import { OutboxRequests } from './outbox-requests';

/** What every pass planned in one run, and the passes whose plan failed. */
export interface LostWorkPlans {
  readonly now: Date;
  readonly plans: ReadonlyMap<string, LostWorkPlan>;
  readonly failures: ReadonlyArray<{ readonly kind: string; readonly error: unknown }>;
}

/** What one run did: the counts per kind and their sums. */
export interface LostWorkResult {
  readonly passes: Readonly<Record<string, LostWorkCounts>>;
  readonly requested: number;
  readonly gaveUp: number;
  readonly unknown: number;
}

/** The longest piece of an error's message the run's error carries. */
const FAILURE_TEXT_MAX = 200;

const NO_COUNTS: LostWorkCounts = { checked: 0, unknown: 0, exhausted: 0, requested: 0, gaveUp: 0 };

/**
 * One short line for an error: its code for an `AppError`, else the first line of its message (a query error's further lines carry the
 * statement's parameters, which stay out of the run's record; the rule of the dispatch sweep, decision 044).
 */
function describeFailure(error: unknown): string {
  if (error instanceof AppError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').slice(0, FAILURE_TEXT_MAX);
}

/**
 * Tells whether a run has anything to record.
 *
 * Why: decision 055: a scheduled run that found nothing to ask for, and no failure, writes no `job_runs` row (one every 5 minutes would
 * bury the jobs list).
 *
 * @param plans what {@link LostWorkReconcile.plan} found
 * @returns true when a pass planned an item or a pass failed
 */
export function hasWork(plans: LostWorkPlans): boolean {
  return plans.failures.length > 0 || [...plans.plans.values()].some((plan) => plan.items.length > 0);
}

/**
 * Applies the items of a plan one by one; one item that throws does not stop the others.
 *
 * Why: decision 055: each item is its own transaction with a guarded write, so the next run is safe; after the loop one error names how
 * many items failed (the rule of the dispatch sweep, decision 044).
 *
 * @param items the planned items
 * @param act writes one item and says what it did: `requested`, `gave_up` or `skipped` (the row changed before the write)
 * @returns the counts
 * @throws {Error} after every item was tried, when at least one threw: "<n> of <m> item(s) failed; first failure: <line>"
 */
export async function applyLostWorkItems(
  items: readonly LostWorkItem[],
  act: (item: LostWorkItem) => Promise<'requested' | 'gave_up' | 'skipped'>,
): Promise<LostWorkApplied> {
  let requested = 0;
  let gaveUp = 0;
  let failed = 0;
  let firstFailure: unknown;
  for (const item of items) {
    try {
      const outcome = await act(item);
      if (outcome === 'requested') requested += 1;
      else if (outcome === 'gave_up') gaveUp += 1;
    } catch (error) {
      if (failed === 0) firstFailure = error;
      failed += 1;
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} of ${items.length} item(s) failed; first failure: ${describeFailure(firstFailure)}`);
  }
  return { requested, gaveUp };
}

/**
 * Asks again for work whose queue job was lost.
 *
 * Why: decision 055: a queue Redis that lost its data (or a job removed by hand) leaves rows waiting for a job that will never come.
 * The owning modules register a pass each (storefront refunds, merchant webhook deliveries, bulk publish runs, Quick add runs); this runs
 * them: every pass plans read-only, then applies its items, each in its own transaction under the row's lock. A pass that throws does not
 * stop the others: once every other pass ran, one error names the failed kinds, so the run is recorded as failed.
 *
 * Side effects: what the passes write (new outbox events with `reconcile: true`, failed refunds, re-added webhook jobs); one warning
 * line with the counts when anything was asked for again or given up.
 *
 * @see docs/queues.md (lost_work_reconcile) and docs/decisions/055-infra.md
 */
@Injectable()
export class LostWorkReconcile {
  private readonly logger = new Logger(LostWorkReconcile.name);

  constructor(
    private readonly registry: LostWorkRegistry,
    private readonly requests: OutboxRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lets every pass plan, without writing anything.
   *
   * @returns the plans by kind, and the passes whose plan threw
   */
  async plan(): Promise<LostWorkPlans> {
    const now = this.clock.now();
    const context: LostWorkContext = { now, requests: this.requests };
    const plans = new Map<string, LostWorkPlan>();
    const failures: Array<{ kind: string; error: unknown }> = [];
    for (const pass of this.registry.list()) {
      try {
        plans.set(pass.kind, await pass.plan(context));
      } catch (error) {
        failures.push({ kind: pass.kind, error });
      }
    }
    return { now, plans, failures };
  }

  /**
   * Applies the plans of a run.
   *
   * @param plans what {@link LostWorkReconcile.plan} found
   * @returns the counts per kind (zeros for a pass that failed) and their sums
   * @throws {Error} when a pass failed to plan or to apply, after every other pass applied: "Lost work reconcile: <n> pass(es) failed
   *   (<kinds>); first failure: <one line>"
   */
  async apply(plans: LostWorkPlans): Promise<LostWorkResult> {
    const context: LostWorkContext = { now: plans.now, requests: this.requests };
    const failures = [...plans.failures];
    const failedKinds = new Set(failures.map((failure) => failure.kind));
    const passes: Record<string, LostWorkCounts> = {};
    let requested = 0;
    let gaveUp = 0;
    let unknown = 0;
    for (const pass of this.registry.list()) {
      const plan = plans.plans.get(pass.kind);
      if (!plan || failedKinds.has(pass.kind)) {
        passes[pass.kind] = NO_COUNTS;
        continue;
      }
      try {
        const applied: LostWorkApplied =
          plan.items.length === 0 ? { requested: 0, gaveUp: 0 } : await pass.apply(plan, context);
        passes[pass.kind] = {
          checked: plan.checked,
          unknown: plan.unknown,
          exhausted: plan.exhausted,
          requested: applied.requested,
          gaveUp: applied.gaveUp,
        };
        requested += applied.requested;
        gaveUp += applied.gaveUp;
        unknown += plan.unknown;
      } catch (error) {
        failures.push({ kind: pass.kind, error });
        passes[pass.kind] = NO_COUNTS;
      }
    }
    if (requested + gaveUp > 0) this.logger.warn(`Lost work reconcile: ${JSON.stringify(passes)}`);
    const first = failures[0];
    if (first) {
      throw new Error(
        `Lost work reconcile: ${failures.length} pass(es) failed (${failures.map((failure) => failure.kind).join(', ')}); first failure: ${describeFailure(first.error)}`,
      );
    }
    return { passes, requested, gaveUp, unknown };
  }

  /**
   * Plans and applies one run (tests and manual use).
   *
   * @returns the counts
   * @throws {Error} as {@link LostWorkReconcile.apply}
   */
  async run(): Promise<LostWorkResult> {
    return this.apply(await this.plan());
  }
}
