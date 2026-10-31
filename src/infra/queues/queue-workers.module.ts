// Nest module for the consuming side of the queues (decision 020): the BullMQ workers and the scheduler runner.
// Import it in the worker process only (src/worker.module.ts); the API process must never run jobs.
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobSchedulerRunner } from './job-scheduler-runner';
import { DEFAULT_QUEUE_WORKERS_OPTIONS, QUEUE_WORKERS_OPTIONS, QueueWorkers } from './queue-workers.service';

/**
 * Starts one worker per queue that has a `@QueueProcessor`, and creates the registered schedulers.
 *
 * Why: decision 016 keeps the API free of job processing: the same domain modules are loaded by both processes, but only
 * the process that imports this module turns their processors into BullMQ workers. It needs QueuesModule (the producers
 * and the scheduler registry), which the worker's root module imports.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: QUEUE_WORKERS_OPTIONS, useValue: DEFAULT_QUEUE_WORKERS_OPTIONS },
    QueueWorkers,
    JobSchedulerRunner,
  ],
  exports: [QueueWorkers, JobSchedulerRunner],
})
export class QueueWorkersModule {}
