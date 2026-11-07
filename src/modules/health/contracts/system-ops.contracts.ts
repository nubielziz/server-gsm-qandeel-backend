// Route contracts of the background work pages: BullMQ queues and failed jobs, scheduled jobs and their runs, and webhook delivery
// health (`/admin/system/queues*`, `/jobs*`, `/webhooks`; docs/contract/endpoints/health.md, ANSWERS system-health Q6, Q7).
import { z } from 'zod';
import { defineRoute, listQuery, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { zId } from '../../../common/contract';
import { METRIC_STATES, zMeasure, zSeriesPoint, zStaffRef } from './system-common';

const QueueStats = z.object({
  name: z.string(),
  state: z.enum(METRIC_STATES),
  paused: z.boolean(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  oldestAge: zMeasure,
  ratePerMin: zMeasure,
  workers: z.number().int(),
});

const queueName = z.object({ name: z.string().min(1).max(100) });

/** `GET /admin/system/queues`: counters of every BullMQ queue. */
export const getQueues = defineRoute({
  key: 'GET /admin/system/queues',
  summary: 'Queue counters',
  description:
    'Live BullMQ counts on the queue Redis for every queue of decision 020: `waiting` (waiting and prioritized), `active`, `delayed`, `failed`, `paused`, `workers`, `oldestAge` (seconds since the oldest waiting job was added; `{value 0, state ok}` when nothing waits) ' +
    'and `ratePerMin` (jobs finished per minute over the last 5 minutes). `state` is the worst of the oldest-job age (warn 120 s, crit 600 s), the failed count (10 warn, 50 crit), a paused queue (warn) and no workers (crit). ' +
    "The outbox backlog (`outbox_events` not processed) is the `outbox-relay` queue's `waiting` and `oldestAge`. `trend` is 96 points of 15 minutes of the oldest waiting job over 24 hours from Prometheus (`value` null when Prometheus does not answer; the read never fails for that).",
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: {
    status: 200,
    schema: z.object({ queues: z.array(QueueStats), oldestAge: zMeasure, trend: z.array(zSeriesPoint) }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE'],
});

/** `GET /admin/system/queues/:name/failed`: the failed jobs of a queue. */
export const listFailedJobs = defineRoute({
  key: 'GET /admin/system/queues/:name/failed',
  summary: 'Failed jobs of a queue',
  description:
    'Newest failure first, 25 a page; `x-total-count` is the number of failed jobs. A row has the job id (a string), its name, the failure text, the attempts made and allowed, the failure time and the subject read from the ids in its payload ' +
    '(`order #10422`) or `null`. Jobs carry ids only, so no secret is shown. Failed jobs are kept 14 days. An unknown queue is 404.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  params: queueName,
  query: listQuery({ sorts: ['failedAt'], defaultSort: { field: 'failedAt', order: 'desc' }, filters: {} }),
  success: {
    status: 200,
    schema: z.object({
      id: z.string(),
      name: z.string(),
      failedReason: z.string(),
      attemptsMade: z.number().int(),
      maxAttempts: z.number().int(),
      failedAt: zIsoDateTime,
      subject: z.string().nullable(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

/** `POST /admin/system/queues/:name/retry`: move failed jobs back to waiting. */
export const retryQueue = defineRoute({
  key: 'POST /admin/system/queues/:name/retry',
  summary: 'Retry failed jobs',
  description:
    'Body is exactly one of `{ jobId }` (one failed job) or `{ all: true }`; neither or both is `422` on `jobId`. Answers `{ retried }`, the number of jobs moved back to waiting (0 is allowed). ' +
    'A `jobId` that is not in the failed set is 404. Writes the audit entry `retried failed jobs in <queue>`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:manage',
  params: queueName,
  body: z.object({ jobId: z.string().min(1).max(200).optional(), all: z.literal(true).optional() }),
  success: { status: 200, schema: z.object({ retried: z.number().int() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

/** `POST /admin/system/queues/:name/pause`: pause or resume a queue. */
export const pauseQueue = defineRoute({
  key: 'POST /admin/system/queues/:name/pause',
  summary: 'Pause or resume a queue',
  description:
    'Body `{ paused: true, reason }` (reason trimmed, 3 characters or more) or `{ paused: false }`. Pausing is global: workers stop taking jobs and waiting jobs stay queued; pausing a paused queue keeps the original pause. ' +
    "Answers the queue's counters after the change. Writes the audit entries `paused queue` (with the reason) and `resumed queue`.",
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:manage',
  params: queueName,
  body: z.object({ paused: z.boolean(), reason: z.string().max(300).optional() }),
  success: { status: 200, schema: QueueStats },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

const JobRun = z.object({
  id: zId,
  job: z.string(),
  startedAt: zIsoDateTime,
  finishedAt: zIsoDateTime.nullable(),
  durationMs: z.number().int(),
  processed: z.number().int(),
  trigger: z.enum(['schedule', 'manual', 'event']),
  status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
  error: z.string().nullable(),
  result: zJsonObject.nullable(),
  triggeredBy: zStaffRef.nullable(),
});

/** The `JobRun` shape, reused by the manual run route. */
export const JobRunShape = JobRun;

/** `GET /admin/system/jobs`: the scheduled jobs and, with `?job=`, one job's runs. */
export const getJobs = defineRoute({
  key: 'GET /admin/system/jobs',
  summary: 'Scheduled jobs and their runs',
  description:
    'Every scheduled job that records its runs (the BullMQ job schedulers of decision 020 joined with `job_runs`; the housekeeping ticks that write no `job_runs`, the outbox relay tick, the IP rule hit flush and the supplier poll tick, are not listed): `name` (the stable key), `label`, `schedule` (cron), `scheduleText`, `state` (the last finished run: failed crit, skipped warn, succeeded ok, none unknown), ' +
    "`running`, `lastRun` (the newest finished run, never the running one) and `nextRunAt`. With `?job=<name>` `runs` is that job's newest 50 runs, running ones included; without it `runs` is empty. " +
    'A running run has `durationMs` 0, `processed` 0 and `finishedAt` null. An unknown or unlisted `job` is 404.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  query: z.object({ job: z.string().min(1).max(100).optional() }),
  success: {
    status: 200,
    schema: z.object({
      jobs: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          schedule: z.string(),
          scheduleText: z.string(),
          state: z.enum(METRIC_STATES),
          running: z.boolean(),
          lastRun: JobRun.nullable(),
          nextRunAt: zIsoDateTime.nullable(),
        }),
      ),
      runs: z.array(JobRun),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'UNAVAILABLE', 'DATABASE_UNAVAILABLE'],
});

/** `POST /admin/system/jobs/:name/run`: run a scheduled job now. */
export const runJob = defineRoute({
  key: 'POST /admin/system/jobs/:name/run',
  summary: 'Run a job now',
  description:
    'Starts a manual run: inserts a `job_runs` row (`trigger` manual, `running`, the staff member) and enqueues the job outside its schedule with the job id `manual-<run id>`. Answers `202` with the new run. ' +
    'A job that already has a running run is `409 JOB_ALREADY_RUNNING`; an unknown job, or one of the unlisted housekeeping ticks, is 404. Writes the audit entry `ran job`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:manage',
  params: z.object({ name: z.string().min(1).max(100) }),
  success: { status: 202, schema: JobRun },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'JOB_ALREADY_RUNNING', 'UNAVAILABLE'],
});

const WebhookDirection = z.object({
  successRate: zMeasure,
  delivered: z.number().int(),
  failed: z.number().int(),
  retrying: z.number().int(),
  oldestUndeliveredAt: zIsoDateTime.nullable(),
  oldestAge: zMeasure,
});

/** `GET /admin/system/webhooks`: delivery health of outgoing and incoming webhooks. */
export const getWebhooksHealth = defineRoute({
  key: 'GET /admin/system/webhooks',
  summary: 'Webhook delivery health',
  description:
    'Last 24 hours. `outgoing` summarises `webhook_deliveries` to merchants: `delivered`, `failed` (gave up), `retrying` (pending with a retry time), `successRate` = delivered / (delivered + failed) (null without deliveries), ' +
    '`oldestUndeliveredAt` (the oldest pending delivery) and its `oldestAge` in seconds (`{value 0, state ok}` when none). `incoming` counts gateway callbacks from hourly counters in the cache Redis (accepted, refused, queued for reprocessing) and ' +
    'the oldest unrelayed outbox event of a callback. During a database outage the route answers `503 DATABASE_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: { status: 200, schema: z.object({ outgoing: WebhookDirection, incoming: WebhookDirection }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'DATABASE_UNAVAILABLE'],
});
