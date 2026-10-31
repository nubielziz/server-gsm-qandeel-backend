// Nest module of the IP rule hit flush job (identity module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../../infra/queues';
import { IpRuleHitsFlush } from './ip-rule-hits-flush';
import { IP_RULE_HITS_FLUSH_JOB, IpRuleHitsFlushProcessor } from './ip-rule-hits-flush.processor';

/**
 * The id of the scheduler that ticks the flush every minute.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const IP_RULE_HITS_FLUSH_SCHEDULER = 'ip-rule-hits-flush';

/**
 * Provides the flush, its processor, and registers its per-minute schedule.
 *
 * Why: the API counts hits, only the worker writes them (decision 020). The schedule is a BullMQ job scheduler, created on
 * every worker boot (idempotent); the processor is found by `QueueWorkers`. It needs the global Redis, cache-key, database
 * and metrics modules.
 */
@Module({ providers: [IpRuleHitsFlush, IpRuleHitsFlushProcessor], exports: [IpRuleHitsFlush] })
export class IpRuleHitsFlushModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: IP_RULE_HITS_FLUSH_SCHEDULER,
      queue: 'maintenance',
      jobName: IP_RULE_HITS_FLUSH_JOB,
      every: 60_000,
      // The next tick is the retry, and a job a minute should not fill the completed set of the noeviction Redis.
      jobOptions: { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { age: 24 * 60 * 60, count: 100 } },
      description: 'Writes the counted IP rule hits to ip_rules.hit_count and last_hit_at.',
    });
  }
}
