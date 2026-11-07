// Nest module of the nightly merchant group promotion (identity module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { ClientGroupDirectory } from '../../catalog';
import { JobRunsModule } from '../../health';
import { MerchantSpend, MerchantWallets } from '../../money';
import { AuditService, SettingsModule } from '../../platform';
import { SessionPolicy } from '../security/session-policy';
import { SessionService } from '../security/session.service';
import { SessionSubjects } from '../security/subject-resolvers';
import { GroupPromotion } from './group-promotion';
import { GROUP_PROMOTION_JOB, GroupPromotionProcessor } from './group-promotion.processor';

/**
 * The id of the scheduler that ticks the promotion once a night.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const GROUP_PROMOTION_SCHEDULER = 'client-group-promotion';

/**
 * Provides the promotion, its processor, and registers its nightly schedule (03:30 UTC, after the integrity check at 02:30, the
 * retention job at 03:00 and the session purge at 03:15).
 *
 * Why: the API never does slow work inline (decision 020); the worker does. The classes the job needs are plain services that take
 * the database as an argument or need only the database and the cache, so the worker builds them here instead of loading the
 * API's modules (the catalog directory, the ledger readers, the audit writer and the session cache invalidation). The schedule is
 * a BullMQ job scheduler, created on every worker boot (idempotent).
 */
@Module({
  imports: [JobRunsModule, SettingsModule],
  providers: [
    ClientGroupDirectory,
    MerchantSpend,
    MerchantWallets,
    AuditService,
    SessionPolicy,
    SessionSubjects,
    SessionService,
    GroupPromotion,
    GroupPromotionProcessor,
  ],
  exports: [GroupPromotion],
})
export class GroupPromotionModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: GROUP_PROMOTION_SCHEDULER,
      queue: 'maintenance',
      jobName: GROUP_PROMOTION_JOB,
      pattern: '30 3 * * *',
      description: 'Promotes merchants to a higher group by their completed-order spend.',
    });
  }
}
