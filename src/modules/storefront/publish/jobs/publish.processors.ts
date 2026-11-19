// The worker jobs of a publish run (feature 31, plan 31 sections 6.1, 6.2, 6.3 and 6.7; queue `imports`): `publish_prepare` prepares a new
// run's draft, `publish_apply` publishes a queued run, `publish_set_listed` switches what it published and `publish_from_quick_add` makes
// and prepares the run of a finished Quick add. All four are outbox events, so they carry ids and the switch's target only.
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../../infra/queues';
import type { OutboxJobData } from '../../../platform';
import { PUBLISH_JOBS } from '../application/publish-outbox';
import { type PublishFromQuickAddOutcome, PublishFromQuickAdd } from '../application/publish-from-quick-add';
import { type PublishPrepareOutcome, PublishPreparer } from '../application/publish-preparer';
import { type PublishRunOutcome, PublishRunner } from '../application/publish-runner';
import { type PublishSwitchOutcome, PublishSwitch } from '../application/publish-switch';

/** A positive whole number: the shape of an id in a job. */
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** The run of an outbox job (its aggregate; for the Quick add hand-over, the Quick add run). */
function runIdOf(job: Job<OutboxJobData, unknown, string>): number {
  const runId = job.data.aggregateId;
  if (!isId(runId)) throw new UnrecoverableError(`The ${job.name} job has no run id.`);
  return runId;
}

/**
 * Prepares the draft of a publish run.
 *
 * Why: plan 31 section 6.1: `POST /admin/publish-runs` inserts the run (`preparing`) and writes the event in one commit; this reads the
 * scope, names and evaluates every service and closes the run as a `draft`. The queue gives it one attempt and never re-runs a stalled
 * job, and the preparer is idempotent: only a run that is `preparing` and unclaimed is taken. The job id is the outbox row's
 * (`outbox-<id>`). Recorded in the run's own tables, not in `job_runs`.
 *
 * @see docs/queues.md (imports)
 */
@Injectable()
@QueueProcessor('imports', PUBLISH_JOBS.prepare)
export class PublishPrepareProcessor implements JobProcessor<OutboxJobData, PublishPrepareOutcome> {
  constructor(private readonly preparer: PublishPreparer) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`aggregateId` is the run)
   * @returns how the preparation ended, or `not_preparing` when there was nothing to claim
   * @throws {UnrecoverableError} when the job carries no run id
   */
  process(job: Job<OutboxJobData, PublishPrepareOutcome, string>): Promise<PublishPrepareOutcome> {
    return this.preparer.run(runIdOf(job));
  }
}

/**
 * Runs the apply of a publish run.
 *
 * Why: plan 31 section 6.2: `POST /admin/publish-runs/:id/apply` (and the close of an automatic preview) moves the run to `queued` and
 * writes the event in one commit; this publishes its rows. The queue gives it one attempt and never re-runs a stalled job, and the
 * runner is idempotent: only a `queued` run is claimed. The job id is the outbox row's (`outbox-<id>`). Recorded in the run's own
 * tables, not in `job_runs`.
 *
 * @see docs/queues.md (imports)
 */
@Injectable()
@QueueProcessor('imports', PUBLISH_JOBS.apply)
export class PublishApplyProcessor implements JobProcessor<OutboxJobData, PublishRunOutcome> {
  constructor(private readonly runner: PublishRunner) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`aggregateId` is the run)
   * @returns how the run ended, or `not_queued` when there was nothing to claim
   * @throws {UnrecoverableError} when the job carries no run id
   */
  process(job: Job<OutboxJobData, PublishRunOutcome, string>): Promise<PublishRunOutcome> {
    return this.runner.run(runIdOf(job));
  }
}

/**
 * Runs the switch of a publish run.
 *
 * Why: plan 31 section 6.7: `POST /admin/publish-runs/:id/listed` queues the switch and writes the event in one commit; this takes what
 * the run published off the shop, or puts it back. A second delivery, or the job of an older press, claims nothing.
 *
 * @see docs/queues.md (imports)
 */
@Injectable()
@QueueProcessor('imports', PUBLISH_JOBS.setListed)
export class PublishSetListedProcessor implements JobProcessor<OutboxJobData, PublishSwitchOutcome> {
  constructor(private readonly switcher: PublishSwitch) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`aggregateId` is the run; the payload has `listed` and `requestedBy`)
   * @returns how the switch ended, or `not_queued` when there was nothing to claim
   * @throws {UnrecoverableError} when the job has no run id, no target, or a `requestedBy` that is not an id
   */
  process(job: Job<OutboxJobData, PublishSwitchOutcome, string>): Promise<PublishSwitchOutcome> {
    const runId = runIdOf(job);
    const { listed, requestedBy } = job.data.payload;
    if (typeof listed !== 'boolean') throw new UnrecoverableError('The publish_set_listed job has no target.');
    if (requestedBy !== null && requestedBy !== undefined && !isId(requestedBy)) {
      throw new UnrecoverableError('The publish_set_listed job has a bad requestedBy.');
    }
    return this.switcher.run(runId, listed, requestedBy ?? null);
  }
}

/**
 * Makes and prepares the publish run of a Quick add run that ended.
 *
 * Why: plan 31 section 6.3: the close of a Quick add run that asked to publish (and created services) writes `supplier.quick_add_done` in
 * its own transaction; this job makes the one automatic publish run of it and prepares it, and the close of that preparation queues the
 * apply. The queue gives it one attempt and never re-runs a stalled job; a second delivery inserts nothing (one publish run per Quick add
 * run). The job id is the outbox row's (`outbox-<id>`). If this job dies, no run exists or the run reads `failed`, and the Quick add
 * progress offers to prepare the preview by hand.
 *
 * @see docs/queues.md (imports)
 */
@Injectable()
@QueueProcessor('imports', PUBLISH_JOBS.fromQuickAdd)
export class PublishFromQuickAddProcessor implements JobProcessor<OutboxJobData, PublishFromQuickAddOutcome> {
  constructor(private readonly handOver: PublishFromQuickAdd) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`aggregateId` is the Quick add run; the payload has `listed` and `requestedBy`)
   * @returns `exists` when the Quick add run already had its publish run, else how the preparation ended
   * @throws {UnrecoverableError} when the job has no Quick add run id, no target, or a `requestedBy` that is not an id
   */
  process(job: Job<OutboxJobData, PublishFromQuickAddOutcome, string>): Promise<PublishFromQuickAddOutcome> {
    const quickAddRunId = runIdOf(job);
    const { listed, requestedBy } = job.data.payload;
    if (typeof listed !== 'boolean') throw new UnrecoverableError('The publish_from_quick_add job has no target.');
    if (requestedBy !== null && requestedBy !== undefined && !isId(requestedBy)) {
      throw new UnrecoverableError('The publish_from_quick_add job has a bad requestedBy.');
    }
    return this.handOver.run({ quickAddRunId, requestedBy: requestedBy ?? null, listed });
  }
}
