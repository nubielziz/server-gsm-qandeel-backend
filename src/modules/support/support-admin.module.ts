// The staff routes and use cases of the support module (stage 17): the inbox and the reply templates; feature 28 adds the console's read
// mark and attachments. Separate from SupportModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { StoredFiles } from '../platform';
import { ReplyTemplateAdminService } from './application/reply-template-admin.service';
import { TicketAdminService } from './application/ticket-admin.service';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketConversationService } from './application/ticket-conversation.service';
import { TicketEvents } from './application/ticket-events';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { TicketReadService } from './application/ticket-read.service';
import { ReplyTemplatesController } from './controllers/reply-templates.controller';
import { SupportTicketLiveController } from './controllers/support-ticket-live.controller';
import { SupportTicketsController } from './controllers/support-tickets.controller';

/**
 * Provides `/admin/support-tickets*` and `/admin/reply-templates*`.
 *
 * Why: these use cases need the global database, audit, settings, cache, storage, real-time publisher and clock providers and the outbox (a
 * reply and a resolve write the event of their message), which a database-less test app does not have.
 */
@Module({
  controllers: [SupportTicketsController, SupportTicketLiveController, ReplyTemplatesController],
  providers: [
    TicketAdminService,
    TicketConversationService,
    ReplyTemplateAdminService,
    TicketMailOutbox,
    StoredFiles,
    TicketEvents,
    TicketAttachmentService,
    TicketReadService,
  ],
})
export class SupportAdminModule {}
