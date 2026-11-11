// The worker side of the notification center (feature 23, plan section 2.3): the fan-out, the in-app writer, the per-channel budget,
// the minute sweep and its schedule. Imported by `NotificationDeliveryModule`, so the API (which writes the events) and the worker (which
// runs the jobs) load the same classes; only the worker starts BullMQ workers for the processors.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../../infra/queues';
import { AuditService } from '../../audit/audit.service';
import { SettingsModule } from '../../settings/settings.module';
import { NotificationInbox } from '../inbox/notification-inbox';
import { NotificationReconcile } from '../notification-reconcile';
import { NotificationReconcileProcessor, NOTIFICATION_RECONCILE_JOB } from '../notification-reconcile.processor';
import { NotificationRetention } from '../notification-retention';
import { NotificationRetentionProcessor, NOTIFICATION_RETENTION_JOB } from '../notification-retention.processor';
import { BroadcastBudget } from './broadcast-budget';
import { CAMPAIGN_FANOUT_OPTIONS, CampaignFanOut, DEFAULT_FANOUT_OPTIONS } from './campaign-fan-out';
import { CampaignFanOutProcessor } from './campaign-fan-out.processor';
import { CampaignSweep } from './campaign-sweep';
import { CAMPAIGN_SWEEP_JOB, CampaignSweepProcessor } from './campaign-sweep.processor';

/**
 * The id of the scheduler of the campaign sweep.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const CAMPAIGN_SWEEP_SCHEDULER = 'notification-campaign-sweep';
/** The id of the scheduler of the reconciler that re-adds lost send jobs (every 5 minutes). */
export const NOTIFICATION_RECONCILE_SCHEDULER = 'notification-reconcile';
/** The id of the scheduler of the daily retention clean-up (04:20 UTC). */
export const NOTIFICATION_RETENTION_SCHEDULER = 'notification-retention';

/**
 * Provides the campaign engine and registers the schedules of the sweep (every minute), the reconciler (every 5 minutes) and the retention
 * clean-up (daily, 04:20 UTC).
 *
 * Why: decision 020: the API writes rows and outbox events; the worker fans out and sends. The schedule is registered in both
 * processes; only the worker's runner creates it in Redis.
 */
@Module({
  imports: [SettingsModule],
  providers: [
    // The worker has no global AuditModule: the sweep's audit rows need their own writer (like the other worker jobs).
    AuditService,
    NotificationInbox,
    BroadcastBudget,
    { provide: CAMPAIGN_FANOUT_OPTIONS, useValue: DEFAULT_FANOUT_OPTIONS },
    CampaignFanOut,
    CampaignFanOutProcessor,
    CampaignSweep,
    CampaignSweepProcessor,
    NotificationReconcile,
    NotificationReconcileProcessor,
    NotificationRetention,
    NotificationRetentionProcessor,
  ],
  exports: [
    NotificationInbox,
    BroadcastBudget,
    CampaignFanOut,
    CampaignSweep,
    NotificationReconcile,
    NotificationRetention,
  ],
})
export class NotificationCampaignEngineModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: CAMPAIGN_SWEEP_SCHEDULER,
      queue: 'maintenance',
      jobName: CAMPAIGN_SWEEP_JOB,
      pattern: '* * * * *',
      description:
        'Sends the scheduled notification campaigns that are due, re-kicks a stalled fan-out and gives up one older than a day.',
    });
    this.schedulers.register({
      id: NOTIFICATION_RECONCILE_SCHEDULER,
      queue: 'maintenance',
      jobName: NOTIFICATION_RECONCILE_JOB,
      pattern: '*/5 * * * *',
      description:
        'Adds the send job again for queued notifications whose job was lost, and fails queued messages older than 48 hours.',
    });
    this.schedulers.register({
      id: NOTIFICATION_RETENTION_SCHEDULER,
      queue: 'maintenance',
      jobName: NOTIFICATION_RETENTION_JOB,
      pattern: '20 4 * * *',
      description:
        'Deletes read and old inbox items and old sent or failed rows of the notification log, by the three retention settings.',
    });
  }
}
