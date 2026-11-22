// The shapes of the lost-work reconcile (platform module, decision 055): what a module's pass plans, what it writes, what a run records.
import type { OutboxRequests } from './outbox-requests';

/** What the coordinator hands to every pass: the run's time and the reader of outbox requests. */
export interface LostWorkContext {
  readonly now: Date;
  readonly requests: OutboxRequests;
}

/** One row a pass will act on: ask for its job again, or give up. `data` carries what the pass needs to act (ids, flags). */
export interface LostWorkItem {
  readonly action: 'request' | 'give_up';
  readonly id: number;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * What a pass found, before it writes anything. `exhausted` counts the rows past their re-request limit that the pass leaves as they
 * are (they make no item, so they never make a run worth recording).
 */
export interface LostWorkPlan {
  readonly checked: number;
  readonly unknown: number;
  readonly exhausted: number;
  readonly items: readonly LostWorkItem[];
}

/** What a pass wrote. */
export interface LostWorkApplied {
  readonly requested: number;
  readonly gaveUp: number;
}

/**
 * One kind of work a module can ask for again after its queue job was lost (decision 055).
 *
 * Why: each module knows which of its rows wait for a job; the platform runs the passes and records the run. The plan/apply split is
 * the dispatch sweep's (decision 044): a run that plans nothing writes nothing and is not recorded.
 */
export interface LostWorkPass {
  /** Lower case letters and "_", unique: the key of the pass's counts in the run's result. */
  readonly kind: string;
  /** Reads only: the rows that wait for a job, judged with `lostWorkAction`. */
  plan(context: LostWorkContext): Promise<LostWorkPlan>;
  /** Writes: each item in its own transaction, re-checking the row under its lock. */
  apply(plan: LostWorkPlan, context: LostWorkContext): Promise<LostWorkApplied>;
}

/** The counts of one pass in a run, as the run's result records them. */
export interface LostWorkCounts {
  readonly checked: number;
  readonly unknown: number;
  readonly exhausted: number;
  readonly requested: number;
  readonly gaveUp: number;
}
