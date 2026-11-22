// WebhookDeliveryReconcilePass: the lost-work pass that re-arms merchant webhook deliveries whose job was lost (platform module, decision 055).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { applyLostWorkItems } from '../lost-work/lost-work-reconcile';
import { LOST_AFTER_MS } from '../lost-work/lost-work-rules';
import { LostWorkRegistry } from '../lost-work/lost-work.registry';
import type {
  LostWorkApplied,
  LostWorkContext,
  LostWorkItem,
  LostWorkPass,
  LostWorkPlan,
} from '../lost-work/lost-work.types';
import { LIVE_JOB_STATES } from '../lost-work/outbox-requests';
import { WEBHOOK_QUEUE, WebhookDeliveries } from './webhook-deliveries';
import { deliveriesByIds, overduePendingDeliveries } from './webhook-delivery.repository';

/** Deliveries one run looks at. */
const DELIVERY_RECONCILE_BATCH = 500;

/** The id of the job of a delivery's current attempt. */
const jobIdOf = (deliveryId: number, attempt: number): string => queueJobId('webhook', deliveryId, attempt);

/**
 * Re-arms the deliveries whose job was lost.
 *
 * Why: decision 055: a pending delivery always has a due time and its job is `webhook-<delivery>-<attempt>`; one overdue by 10 minutes
 * whose job is missing gets that job again, and one whose job of that id already finished (completed or failed without moving the row)
 * gets it replaced. Adding the current attempt's job is always safe: the delivery's write is guarded by `status = 'pending' and
 * attempt = n`, so a delivery is never sent twice for one attempt. There is no give-up: the delivery's own attempts and backoff end it.
 *
 * Side effects: `apply` removes finished jobs of that id and adds jobs to the `merchant-webhooks` queue; writes no database row.
 */
@Injectable()
export class WebhookDeliveryReconcilePass implements LostWorkPass, OnModuleInit {
  readonly kind = 'webhook_deliveries';

  constructor(
    private readonly db: DbService,
    private readonly queues: QueuesService,
    private readonly deliveries: WebhookDeliveries,
    private readonly registry: LostWorkRegistry,
  ) {}

  /** Registers the pass with the platform's reconcile. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Finds the overdue deliveries whose job is missing or finished.
   *
   * @param context the run's time
   * @returns the deliveries to re-arm; writes nothing
   */
  async plan({ now }: LostWorkContext): Promise<LostWorkPlan> {
    const rows = await overduePendingDeliveries(
      this.db.db,
      new Date(now.getTime() - LOST_AFTER_MS),
      DELIVERY_RECONCILE_BATCH,
    );
    const queue = this.queues.queue(WEBHOOK_QUEUE);
    const items: LostWorkItem[] = [];
    let unknown = 0;
    for (const row of rows) {
      let state: string;
      try {
        state = await queue.getJobState(jobIdOf(row.id, row.attempt));
      } catch {
        unknown += 1;
        continue;
      }
      if (LIVE_JOB_STATES.has(state)) continue;
      // BullMQ's "unknown" means no job of that id exists.
      if (state === 'unknown')
        items.push({ action: 'request', id: row.id, data: { attempt: row.attempt, replace: false } });
      else if (state === 'completed' || state === 'failed') {
        items.push({ action: 'request', id: row.id, data: { attempt: row.attempt, replace: true } });
      }
    }
    return { checked: rows.length, unknown, exhausted: 0, items };
  }

  /**
   * Re-arms each planned delivery that is still pending on the same attempt.
   *
   * @param plan what {@link WebhookDeliveryReconcilePass.plan} found
   * @returns how many deliveries got their job again
   * @throws {Error} after every item was tried, when one of them threw
   */
  async apply(plan: LostWorkPlan): Promise<LostWorkApplied> {
    const rows = new Map(
      (
        await deliveriesByIds(
          this.db.db,
          plan.items.map((item) => item.id),
        )
      ).map((row) => [row.id, row]),
    );
    const queue = this.queues.queue(WEBHOOK_QUEUE);
    return applyLostWorkItems(plan.items, async (item) => {
      const row = rows.get(item.id);
      if (!row || row.status !== 'pending' || row.attempt !== item.data?.attempt) return 'skipped';
      const jobId = jobIdOf(row.id, row.attempt);
      // Read again: a parallel run (or the delivery itself) may have added the job since the plan.
      const state = await queue.getJobState(jobId);
      if (LIVE_JOB_STATES.has(state)) return 'skipped';
      // A finished job keeps its id, and BullMQ ignores an add whose id is still taken: remove it first. A locked job stays (next run).
      if (state === 'completed' || state === 'failed') {
        if ((await queue.remove(jobId)) !== 1) return 'skipped';
      }
      await this.deliveries.ensureJobs([row]);
      return 'requested';
    });
  }
}
