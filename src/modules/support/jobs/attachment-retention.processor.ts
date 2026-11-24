// The worker job that deletes old ticket attachments (support module, queue maintenance, job ticket_attachment_retention): every night
// the files of tickets resolved longer ago than `support.attachmentRetentionDays` go (TicketAttachmentService.applyRetention).
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { type AttachmentRetentionOutcome, TicketAttachmentService } from '../application/ticket-attachment.service';

/**
 * The job name of the nightly attachment retention.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is the console's job name (`GET /admin/system/jobs`).
 */
export const TICKET_ATTACHMENT_RETENTION_JOB = 'ticket_attachment_retention';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface AttachmentRetentionData {
  readonly runId?: number;
}

/**
 * Deletes the attachments of tickets past the retention when the nightly tick arrives.
 *
 * Why: feature 28, rule 10. Recorded in `job_runs` like the other jobs (every run, decision 020); `JobRunsService` skips it while a
 * previous run is still going. The job carries no data: it reads the setting and the clock itself, and a repeat only finds fewer rows.
 */
@Injectable()
@QueueProcessor('maintenance', TICKET_ATTACHMENT_RETENTION_JOB)
export class AttachmentRetentionProcessor implements JobProcessor<AttachmentRetentionData, AttachmentRetentionOutcome> {
  constructor(
    private readonly attachments: TicketAttachmentService,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns the retention in force and what was removed
   */
  async process(
    job: Job<AttachmentRetentionData, AttachmentRetentionOutcome, string>,
  ): Promise<AttachmentRetentionOutcome> {
    let outcome: AttachmentRetentionOutcome = { days: 0, tickets: 0, files: 0 };
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: TICKET_ATTACHMENT_RETENTION_JOB, trigger: 'schedule' } as const)
        : ({ job: TICKET_ATTACHMENT_RETENTION_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      outcome = await this.attachments.applyRetention();
      return { processed: outcome.files, result: { ...outcome } };
    });
    return outcome;
  }
}
