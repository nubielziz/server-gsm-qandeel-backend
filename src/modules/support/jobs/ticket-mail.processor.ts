// The worker processor of the ticket messages (support module, queue notifications): one job name, `support.ticket_mail`, delegating to
// TicketMailJobs. Only the worker process runs it; the API loads the class.
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { TICKET_MAIL_EVENT } from '../application/ticket-mail-outbox';
import { type TicketMailJobResult, TicketMailJobs } from '../application/ticket-mail.jobs';

/**
 * Sends the receipt, the reply or the survey of a support ticket.
 *
 * Why: `POST /store/v1/tickets`, a staff reply and a resolve write `support.ticket_mail` (feature 17); this job hands the message to the
 * notification delivery. The `notifications` queue is shared with feature 12a and the identity module, so this processor names its one job.
 */
@Injectable()
@QueueProcessor('notifications', TICKET_MAIL_EVENT)
export class TicketMailProcessor implements JobProcessor<OutboxJobData, TicketMailJobResult> {
  constructor(private readonly jobs: TicketMailJobs) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the message was handed over
   */
  process(job: Job<OutboxJobData, TicketMailJobResult, string>): Promise<TicketMailJobResult> {
    return this.jobs.handle(job);
  }
}
