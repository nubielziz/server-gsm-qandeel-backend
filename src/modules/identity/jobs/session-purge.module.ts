// Nest module of the ended-session purge job (identity module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { SessionPurge } from './session-purge';
import { SESSION_PURGE_JOB, SessionPurgeProcessor } from './session-purge.processor';

/**
 * The id of the scheduler that ticks the purge once a day.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const SESSION_PURGE_SCHEDULER = 'session-purge';

/**
 * Provides the purge, its processor, and registers its daily schedule (03:15 UTC, off the nightly 02:30 and 03:00 jobs).
 *
 * Why: the API never deletes in bulk (decision 020); the worker does. The schedule is a BullMQ job scheduler, created on
 * every worker boot (idempotent).
 */
@Module({ imports: [JobRunsModule], providers: [SessionPurge, SessionPurgeProcessor], exports: [SessionPurge] })
export class SessionPurgeModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: SESSION_PURGE_SCHEDULER,
      queue: 'maintenance',
      jobName: SESSION_PURGE_JOB,
      pattern: '15 3 * * *',
      description: 'Deletes sessions that ended more than 30 days ago.',
    });
  }
}
