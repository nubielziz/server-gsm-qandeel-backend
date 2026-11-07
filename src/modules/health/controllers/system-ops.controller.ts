// HTTP controller of the background work routes (map domain G, stage 9): queues, failed jobs, retry, pause, scheduled jobs and manual
// runs. Thin: the rules live in QueueAdminService and JobsAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { JobsAdminService } from '../application/jobs-admin.service';
import { QueueAdminService } from '../application/queue-admin.service';
import { getJobs, getQueues, listFailedJobs, pauseQueue, retryQueue, runJob } from '../contracts/system-ops.contracts';

/**
 * The queue and job routes.
 *
 * Why: the console's Queues tab shows BullMQ counters, failed jobs and scheduled jobs, and lets staff retry, pause and run.
 *
 * @route GET /admin/system/queues
 * @route GET /admin/system/queues/:name/failed
 * @route POST /admin/system/queues/:name/retry
 * @route POST /admin/system/queues/:name/pause
 * @route GET /admin/system/jobs
 * @route POST /admin/system/jobs/:name/run
 */
@Controller()
export class SystemOpsController {
  constructor(
    private readonly queues: QueueAdminService,
    private readonly jobs: JobsAdminService,
  ) {}

  /**
   * The counters of every queue.
   *
   * @returns the queues, the oldest waiting job and its trend
   * @route GET /admin/system/queues
   */
  @Route(getQueues)
  overview(): Promise<ResultOf<typeof getQueues>> {
    return this.queues.overview();
  }

  /**
   * The failed jobs of a queue.
   *
   * @param params the queue name
   * @param query the parsed list request
   * @returns the rows and the number of failed jobs
   * @route GET /admin/system/queues/:name/failed
   */
  @Route(listFailedJobs)
  failed(
    @Param() params: ParamsOf<typeof listFailedJobs>,
    @Query() query: QueryOf<typeof listFailedJobs>,
  ): Promise<ResultOf<typeof listFailedJobs>> {
    return this.queues.failed(params.name, query.range);
  }

  /**
   * Retries failed jobs.
   *
   * @param params the queue name
   * @param body one job id or `all`
   * @returns how many jobs were retried
   * @route POST /admin/system/queues/:name/retry
   */
  @Route(retryQueue)
  retry(
    @Param() params: ParamsOf<typeof retryQueue>,
    @Body() body: BodyOf<typeof retryQueue>,
  ): Promise<ResultOf<typeof retryQueue>> {
    return this.queues.retry(params.name, body);
  }

  /**
   * Pauses or resumes a queue.
   *
   * @param params the queue name
   * @param body the pause switch and reason
   * @returns the queue's counters
   * @route POST /admin/system/queues/:name/pause
   */
  @Route(pauseQueue)
  pause(
    @Param() params: ParamsOf<typeof pauseQueue>,
    @Body() body: BodyOf<typeof pauseQueue>,
  ): Promise<ResultOf<typeof pauseQueue>> {
    return this.queues.pause(params.name, body);
  }

  /**
   * The scheduled jobs.
   *
   * @param query the optional job whose history to include
   * @returns the jobs and the history
   * @route GET /admin/system/jobs
   */
  @Route(getJobs)
  list(@Query() query: QueryOf<typeof getJobs>): Promise<ResultOf<typeof getJobs>> {
    return this.jobs.list(query.job) as Promise<ResultOf<typeof getJobs>>;
  }

  /**
   * Runs a job now.
   *
   * @param staff the signed-in staff member
   * @param params the job name
   * @returns the new run
   * @route POST /admin/system/jobs/:name/run
   */
  @Route(runJob)
  run(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof runJob>,
  ): Promise<ResultOf<typeof runJob>> {
    return this.jobs.run(params.name, staff.staffId);
  }
}
