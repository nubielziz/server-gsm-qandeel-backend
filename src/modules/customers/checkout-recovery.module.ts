// The abandoned-checkout recovery of the customers module (feature 19): the outbox event and its route, the use cases that queue the
// emails, the mail job and the reminder's tick. Loaded by the API (the recover route writes the event) and by the worker (it handles it).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../infra/queues';
import { CatalogModule } from '../catalog';
import { JobRunsModule } from '../health';
import { AuditService, NotificationDeliveryModule, SettingsModule } from '../platform';
import { RecoveryMail } from './application/recovery-mail';
import { RecoveryOutbox } from './application/recovery-outbox';
import { RecoveryQueue } from './application/recovery-queue';
import { RecoverySweep } from './application/recovery-sweep';
import {
  CheckoutRecoveryProcessor,
  CheckoutRecoverySweepProcessor,
  CHECKOUT_RECOVERY_SWEEP_JOB,
} from './jobs/checkout-recovery.processors';

/**
 * The id of the scheduler that ticks the automatic reminder.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const CHECKOUT_RECOVERY_SCHEDULER = 'checkout-recovery-sweep';

/**
 * Provides the recovery queue, the mail job, the reminder tick and its schedule (every 5 minutes).
 *
 * Why: the API only writes `checkout.recovery` events (decision 020); the worker sends the mails. Both processes load the module so
 * both know the event's route; only the worker turns the processors into BullMQ workers. The schedule is registered in both too: only
 * the worker's runner creates it in Redis.
 */
@Module({
  imports: [NotificationDeliveryModule, JobRunsModule, CatalogModule, SettingsModule],
  providers: [
    // The audit writer is a plain service of the database: the worker has no global AuditModule, so the module provides its own (like the other worker jobs).
    AuditService,
    RecoveryOutbox,
    RecoveryQueue,
    RecoveryMail,
    RecoverySweep,
    CheckoutRecoveryProcessor,
    CheckoutRecoverySweepProcessor,
  ],
  exports: [RecoveryQueue],
})
export class CheckoutRecoveryModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: CHECKOUT_RECOVERY_SCHEDULER,
      queue: 'maintenance',
      jobName: CHECKOUT_RECOVERY_SWEEP_JOB,
      pattern: '*/5 * * * *',
      description:
        'Emails the abandoned checkouts that waited abandonedMinutes, once, to customers who agreed to marketing email.',
    });
  }
}
