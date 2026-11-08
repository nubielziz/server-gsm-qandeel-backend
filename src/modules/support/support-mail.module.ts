// The sending side of the support module (stage 17): the job that sends a ticket's receipt, reply and survey. Loaded by the API (the
// processor class is resolved there, like the other notification processors) and by the worker, which runs it. It needs the database
// and the notification delivery, so a test app built without them leaves it out.
import { Module } from '@nestjs/common';
import { NotificationDeliveryModule } from '../platform';
import { TicketMailJobs } from './application/ticket-mail.jobs';
import { TicketMailProcessor } from './jobs/ticket-mail.processor';

/**
 * Provides {@link TicketMailProcessor} and the job behind it.
 *
 * Why: decision 020: the worker turns each `support.ticket_mail` event into a message and sends it through `NotificationService`. Only the
 * worker starts a BullMQ worker for the processor.
 */
@Module({ imports: [NotificationDeliveryModule], providers: [TicketMailJobs, TicketMailProcessor] })
export class SupportMailModule {}
