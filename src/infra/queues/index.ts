// Public API of the queue infrastructure (decision 020): the registry, the producers, the processor API, the schedulers.
export { QueuesModule } from './queues.module';
export { QueueWorkersModule } from './queue-workers.module';
export { QueuesService } from './queues.service';
export type { JobQueue, QueuedJob } from './queues.service';
export {
  COMPLETED_JOB_MAX_AGE_SECONDS,
  COMPLETED_JOB_MAX_COUNT,
  FAILED_JOB_MAX_AGE_SECONDS,
  QUEUES,
  QUEUE_NAMES,
  defaultJobOptions,
  isQueueName,
} from './queue-definitions';
export type { QueueDefinition, QueueName } from './queue-definitions';
export { queueJobId } from './job-id';
export { isQueueUnavailableError } from './queue-errors';
export { QueueProcessor } from './queue-processor';
export type { JobProcessor } from './queue-processor';
export { JobSchedulerRegistry } from './job-schedulers';
export type { JobSchedulerSpec } from './job-schedulers';
export { JobSchedulerRunner } from './job-scheduler-runner';
export { DEFAULT_QUEUE_WORKERS_OPTIONS, QUEUE_WORKERS_OPTIONS, QueueWorkers } from './queue-workers.service';
export type { QueueWorkersOptions } from './queue-workers.service';
export { QUEUE_JOB_STATES, QueueMetrics } from './queue-metrics';
// Modules import these from here so that no feature depends on BullMQ directly.
export { UnrecoverableError } from 'bullmq';
export type { Job } from 'bullmq';
