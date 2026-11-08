// The staff routes and use cases of the support module (stage 17): the inbox and the reply templates. Separate from SupportModule so a test
// app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { ReplyTemplateAdminService } from './application/reply-template-admin.service';
import { TicketAdminService } from './application/ticket-admin.service';
import { TicketConversationService } from './application/ticket-conversation.service';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { ReplyTemplatesController } from './controllers/reply-templates.controller';
import { SupportTicketsController } from './controllers/support-tickets.controller';

/**
 * Provides `/admin/support-tickets*` and `/admin/reply-templates*`.
 *
 * Why: these use cases need the global database, audit and clock providers and the outbox (a reply and a resolve write the event of
 * their message), which a database-less test app does not have.
 */
@Module({
  controllers: [SupportTicketsController, ReplyTemplatesController],
  providers: [TicketAdminService, TicketConversationService, ReplyTemplateAdminService, TicketMailOutbox],
})
export class SupportAdminModule {}
