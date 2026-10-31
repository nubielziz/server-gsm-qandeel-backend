// Global Nest module for the producing side of the queues (decision 020): QueuesService, the scheduler registry and the
// queue gauge. Shared by the API and the worker; the processors and workers are in QueueWorkersModule (worker only).
import { Global, Module } from '@nestjs/common';
import { JobSchedulerRegistry } from './job-schedulers';
import { QueueMetrics } from './queue-metrics';
import { QueuesService } from './queues.service';

/**
 * Provides {@link QueuesService} and {@link JobSchedulerRegistry} to every module.
 *
 * Why: any use case or job may enqueue work, and modules declare their schedules next to their code. Importing this
 * module never starts a worker or creates a scheduler in Redis: that is QueueWorkersModule, imported by the worker
 * process only (decision 016). It needs the global config, Redis and metrics modules, which both root modules import.
 */
@Global()
@Module({
  providers: [QueuesService, JobSchedulerRegistry, QueueMetrics],
  exports: [QueuesService, JobSchedulerRegistry],
})
export class QueuesModule {}
