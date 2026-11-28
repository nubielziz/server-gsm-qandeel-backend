// Nest module of the ended-session purge job and the purge of lapsed sign-up forms (identity module). Import it in the worker process only
// (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { SessionPurge } from './session-purge';
import { SESSION_PURGE_JOB, SessionPurgeProcessor } from './session-purge.processor';
import { SIGN_UP_PURGE_JOB, SignUpPurgeProcessor } from './sign-up-purge.processor';

/**
 * The id of the scheduler that ticks the purge once a day.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const SESSION_PURGE_SCHEDULER = 'session-purge';

/**
 * The id of the scheduler that ticks the purge of lapsed sign-up forms every 15 minutes (decision 079).
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const SIGN_UP_PURGE_SCHEDULER = 'sign-up-purge';

/** The id of the retired nightly promotion scheduler (maintenance queue); kept only so the worker can remove it from Redis. */
const RETIRED_PROMOTION_SCHEDULER = 'client-group-promotion';

/**
 * Provides the purge, its two processors, and registers their schedules: the sessions daily (03:15 UTC, off the nightly 02:30 and 03:00
 * jobs), the lapsed sign-up forms every 15 minutes (decision 079: no password hash outlives its link for long).
 *
 * Why: the API never deletes in bulk (decision 020); the worker does. The schedule is a BullMQ job scheduler, created on
 * every worker boot (idempotent). The module also lists the scheduler of the retired nightly merchant promotion, so the worker
 * removes it from Redis at boot (upserting never deletes).
 */
@Module({
  imports: [JobRunsModule],
  providers: [SessionPurge, SessionPurgeProcessor, SignUpPurgeProcessor],
  exports: [SessionPurge],
})
export class SessionPurgeModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: SESSION_PURGE_SCHEDULER,
      queue: 'maintenance',
      jobName: SESSION_PURGE_JOB,
      pattern: '15 3 * * *',
      description: 'Deletes sessions that ended more than 30 days ago.',
    });
    this.schedulers.register({
      id: SIGN_UP_PURGE_SCHEDULER,
      queue: 'maintenance',
      jobName: SIGN_UP_PURGE_JOB,
      pattern: '*/15 * * * *',
      description: 'Deletes the waiting sign-up forms whose link expired or was used.',
    });
    // The nightly promotion by spend is gone: remove its scheduler from Redis, or it keeps queueing jobs nobody processes.
    this.schedulers.retire('maintenance', RETIRED_PROMOTION_SCHEDULER);
  }
}
