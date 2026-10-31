# Queues (`src/infra/queues`)

BullMQ on the queue Redis (decisions 006, 020). Every queue, job, payload, idempotency key, retry policy and schedule is
listed in `docs/queues.md`; a test fails when that document and `QUEUES` disagree.

| What                                                            | Where                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The ten queues: concurrency, attempts, backoff, stall rule      | `queue-definitions.ts` (`QUEUES`, `defaultJobOptions`)                            |
| Producers: `QueuesService.add`, `queue(name)`                    | `queues.service.ts`, `queues.module.ts` (global; API and worker)                  |
| Deterministic job ids                                           | `job-id.ts` (`queueJobId`)                                                        |
| "Redis is down" versus "bad call"                               | `queue-errors.ts` (`isQueueUnavailableError`)                                     |
| `@QueueProcessor(queue, jobName?)` and how processors are found | `queue-processor.ts`                                                              |
| Workers: start, run, drain                                      | `queue-workers.service.ts`, `queue-workers.module.ts` (**worker process only**)   |
| Schedulers: registry and the boot-time upsert                   | `job-schedulers.ts`, `job-scheduler-runner.ts`                                    |
| Gauges `bullmq_queue_jobs`, `bullmq_queue_paused`               | `queue-metrics.ts`                                                                |

## Rules

- **The API produces, the worker consumes.** `QueuesModule` is imported by both root modules; `QueueWorkersModule` only by
  `src/worker.module.ts`. The same domain modules are loaded by both processes, so a processor class is also built in the
  API, but only the worker turns it into a BullMQ `Worker`.
- **Never create a `Queue` or `Worker` yourself.** `QueuesService` builds the producers on the shared producer client with
  `skipWaitingForReady` and `skipVersionCheck`; both are needed so that `add()` fails at once while Redis is down and the
  same `Queue` works again when it is back (`src/infra/redis/README.md`). Workers get `RedisService.createWorkerConnection()`.
- **Constructors never connect.** The `Queue` objects are created in `onModuleInit` (the OpenAPI generator builds the app
  offline). `skipVersionCheck` only applies to the producers: each `Worker` still checks the Redis version and warns when
  the instance does not run `noeviction`, so a wrongly configured queue Redis is noticed when the worker boots.
- **Payload: ids only**, plus `requestId`. `QueuesService.add` adds the current request id to `data`; the worker makes the
  job's `requestId` the current request id while the job runs, so logs, follow-up `add` calls and outbox rows keep it.
- **Job ids** are `<kind>-<id>` built by `queueJobId('order-poll', orderId)`: BullMQ refuses ids with `:` and ids that are
  only digits. Adding an id that is taken (and retained) creates nothing.
- **Redis down.** `add` throws `AppError('UNAVAILABLE')` (503, `Retry-After: 5`) when the queue Redis is unreachable, full
  (`OOM`, the instance is `noeviction`) or loading. A bad call (a `:` in the job id, a payload over the size limit) stays the
  BullMQ error. A use case that must not lose the work writes an outbox row instead of calling `add` (decision 020).
- **Retries.** The queue's `attempts` and exponential backoff with jitter apply to every job. Throw `UnrecoverableError`
  (re-exported here) for a permanent failure. `supplier-dispatch` jobs are never re-run after a worker died (`maxStalledCount`
  0) and its processor throws `UnrecoverableError` for a send that may have reached the supplier (decision 025).
- **Shutdown** (decision 001): on SIGTERM `QueueWorkers.onModuleDestroy` stops taking jobs and waits for the running ones (at
  most `shutdownGraceMs`, 25 s); the pool, Redis and producers close later in `onApplicationShutdown`. When the queue Redis
  is away the workers are closed at once, since no job could be reported finished anyway.

## Add a job

```ts
// src/modules/orders/jobs/poll-order.processor.ts
@Injectable()
@QueueProcessor('supplier-poll', 'poll') // omit 'poll' to handle every job of the queue
export class PollOrderProcessor implements JobProcessor<{ orderId: number }, void> {
  constructor(private readonly orders: OrdersService) {}

  async process(job: Job<{ orderId: number }, void, string>): Promise<void> {
    await this.orders.pollSupplier(job.data.orderId); // re-reads the order; guarded transitions; safe to run twice
  }
}
```

1. Provide the class in its module and import that module in `src/worker.module.ts`.
2. Enqueue it from a use case through the outbox (`OutboxService.add`, see `src/modules/platform/README.md`) or directly:
   `await this.queues.add('supplier-poll', 'poll', { orderId }, { jobId: queueJobId('order-poll', orderId, 'n1'), delay })`.
3. A scheduled job registers itself in `onModuleInit` and wraps its work with `JobRunsService.run` (health module):

```ts
this.schedulers.register({
  id: 'ledger-integrity-nightly',
  queue: 'maintenance',
  jobName: 'ledger_integrity',
  pattern: '30 2 * * *', // UTC
  description: 'Nightly ledger integrity check.',
});

// the processor
@QueueProcessor('maintenance', 'ledger_integrity')
// ...
process(job) {
  return this.jobRuns.run({ job: 'ledger_integrity', trigger: 'schedule', runId: job.data.runId }, async () => {
    const result = await this.integrity.check();
    return { processed: result.accountsChecked, result: { failedChecks: result.failed } };
  });
}
```

4. Document the queue section in `docs/queues.md` and add an integration test that runs the processor twice and one that
   fails it once (`test/integration/queues.test.ts` shows how to start workers with test processors).

The worker refuses to start when processors are misconfigured (two catch-all processors on a queue, a catch-all next to
named ones, two processors for one job name), so such a mistake is found by the first test that boots the worker.

## Tests

`test/integration/queues.test.ts` (producers, defaults, de-duplication, fail-fast and recovery, schedulers, workers, retries,
drain deadline, outage with a forwarder), `test/integration/worker-process.test.ts` (the real worker and a SIGTERM during a
job), `test/integration/queue-redis-restart.test.ts` (`GSM_TEST_DOCKER=1`: restarts the real container). Tests use a private
`BULL_PREFIX` per file and delete their keys; never `FLUSHDB`.
