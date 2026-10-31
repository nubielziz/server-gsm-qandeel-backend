// The processor API of the queues (decision 020): a module marks a provider with @QueueProcessor, and only the worker
// process starts a BullMQ Worker for it (QueueWorkers). The API process can load the same classes and never runs them.
import { DiscoveryService } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type QueueName, isQueueName } from './queue-definitions';

/** What the decorator remembers about a processor class. */
export interface QueueProcessorMetadata {
  readonly queue: QueueName;
  /** The one job name the processor handles; `undefined` means every job of the queue. */
  readonly jobName: string | undefined;
}

/**
 * Anything that processes jobs: the shape a `@QueueProcessor` provider must have.
 *
 * Why: the worker calls `process` for each job of the queue (or of the one job name) the class is marked for. Throw
 * `UnrecoverableError` for a permanent failure (no retry); any other error is retried with the queue's backoff.
 */
export interface JobProcessor<Data = unknown, Result = unknown> {
  /**
   * Handles one job.
   *
   * @param job the BullMQ job; `job.data` carries ids only (and `requestId` when the producer was inside a request)
   * @returns the job result (kept with the job; small and free of secrets)
   */
  process(job: Job<Data, Result, string>): Promise<Result>;
}

const Marker = DiscoveryService.createDecorator<QueueProcessorMetadata>();

/**
 * Marks a provider as the processor of a queue, or of one job name on a queue.
 *
 * Why: modules own their jobs (`src/modules/<id>/jobs/`) but only the worker runs them (decision 016, 020). A queue may
 * be shared by several modules: `@QueueProcessor('maintenance', 'ledger_integrity')` handles only that job name, while
 * `@QueueProcessor('supplier-dispatch')` handles every job of the queue. A queue cannot have a catch-all and named
 * processors together, and a name cannot have two processors: the worker refuses to start otherwise.
 *
 * Side effects: none at the call site; `QueueWorkers` finds the marked providers when the worker process starts.
 *
 * @param queue the queue the processor works on
 * @param jobName the only job name it handles; omit to handle all jobs of the queue
 * @returns a class decorator
 * @throws {RangeError} when `queue` is not a registered queue
 */
export function QueueProcessor(queue: QueueName, jobName?: string): ClassDecorator {
  if (!isQueueName(queue))
    throw new RangeError(`"${String(queue)}" is not a queue (see QUEUES in queue-definitions.ts).`);
  return Marker({ queue, jobName });
}

/** A marked provider found in the application, with the instance Nest built for it. */
export interface DiscoveredProcessor extends QueueProcessorMetadata {
  readonly instance: JobProcessor;
  /** Class name, for messages. */
  readonly label: string;
}

/** The processors of one queue, ready to be looked up by job name. */
export interface QueueHandlers {
  /** Handles every job name that has no named processor (set only when no named processor exists). */
  readonly catchAll: DiscoveredProcessor | undefined;
  readonly byName: ReadonlyMap<string, DiscoveredProcessor>;
}

/**
 * Finds every provider marked with {@link QueueProcessor} in the running application.
 *
 * Why: processors live in many modules; the worker discovers them instead of listing them in one place.
 *
 * @param discovery Nest's discovery service
 * @returns the marked providers (static providers only)
 */
export function findQueueProcessors(discovery: DiscoveryService): DiscoveredProcessor[] {
  const found: DiscoveredProcessor[] = [];
  for (const wrapper of discovery.getProviders({ metadataKey: Marker.KEY })) {
    const metadata = discovery.getMetadataByDecorator(Marker, wrapper);
    const instance: unknown = wrapper.instance;
    if (!metadata || !wrapper.isDependencyTreeStatic() || typeof instance !== 'object' || instance === null) continue;
    const label = wrapper.metatype?.name ?? 'a provider';
    if (typeof (instance as { process?: unknown }).process !== 'function') {
      throw new Error(`${label} is marked @QueueProcessor but has no process(job) method.`);
    }
    found.push({ ...metadata, instance: instance as JobProcessor, label });
  }
  return found;
}

/**
 * Groups processors by queue and checks that the combination is valid.
 *
 * Why: a misconfigured processor must stop the worker at boot (a programming error), not surface as failed jobs later.
 *
 * @param processors what {@link findQueueProcessors} found
 * @returns the handlers of every queue that has a processor
 * @throws {Error} when a queue has a catch-all together with named processors, two catch-alls, or two processors for one
 *   job name
 */
export function buildProcessorTable(processors: readonly DiscoveredProcessor[]): Map<QueueName, QueueHandlers> {
  const grouped = new Map<QueueName, { catchAll: DiscoveredProcessor[]; named: DiscoveredProcessor[] }>();
  for (const processor of processors) {
    const entry = grouped.get(processor.queue) ?? { catchAll: [], named: [] };
    (processor.jobName === undefined ? entry.catchAll : entry.named).push(processor);
    grouped.set(processor.queue, entry);
  }
  const table = new Map<QueueName, QueueHandlers>();
  for (const [queue, { catchAll, named }] of grouped) {
    if (catchAll.length > 1) {
      throw new Error(
        `Queue "${queue}" has more than one catch-all processor: ${catchAll.map((p) => p.label).join(', ')}.`,
      );
    }
    if (catchAll.length === 1 && named.length > 0) {
      throw new Error(
        `Queue "${queue}" has the catch-all processor ${catchAll[0]?.label} and also named processors (${named
          .map((p) => `${p.label} for "${p.jobName}"`)
          .join(', ')}); use one style per queue.`,
      );
    }
    const byName = new Map<string, DiscoveredProcessor>();
    for (const processor of named) {
      const name = processor.jobName as string;
      const existing = byName.get(name);
      if (existing) {
        throw new Error(
          `Queue "${queue}" has two processors for job "${name}": ${existing.label} and ${processor.label}.`,
        );
      }
      byName.set(name, processor);
    }
    table.set(queue, { catchAll: catchAll[0], byName });
  }
  return table;
}

/**
 * Picks the processor for a job name.
 *
 * @param handlers the handlers of the queue
 * @param jobName the name of the job being run
 * @returns the named processor, else the catch-all, else `undefined`
 */
export function handlerFor(handlers: QueueHandlers, jobName: string): DiscoveredProcessor | undefined {
  return handlers.byName.get(jobName) ?? handlers.catchAll;
}
