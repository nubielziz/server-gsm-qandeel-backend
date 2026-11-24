// The account surfaces of the support chat (feature 28, slice B2): a signed-in customer's own tickets and a merchant's ticket conversation.
// Separate from SupportModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { StoredFiles } from '../platform';
import { AccountTicketOpener } from './application/account-ticket-opener';
import { ClientTicketService } from './application/client-ticket.service';
import { MyTicketsService } from './application/my-tickets.service';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketEvents } from './application/ticket-events';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { TicketReadService } from './application/ticket-read.service';
import { TicketThreadService } from './application/ticket-thread.service';
import { ClientTicketsController } from './controllers/client-tickets.controller';
import { MyTicketsController } from './controllers/my-tickets.controller';

/**
 * Provides `/store/v1/me/tickets` and `/client/tickets*`.
 *
 * Why: these use cases need the global database, crypto, rate-limit, cache, storage, real-time publisher and clock providers and the outbox
 * (a customer's receipt), which a database-less test app does not have. The merchant portal and the signed-in customer write, mark and
 * download through the same chat-engine services as the ticket page (`TicketThreadService`, `TicketReadService`,
 * `TicketAttachmentService`), so every requester behaves alike. Like `SupportAdminModule` the module lists them itself instead of importing
 * `SupportStoreModule`: it then does not depend on the ticket-link module (a test that stands in for the ticket token resolver replaces that
 * one), and the services are stateless.
 */
@Module({
  controllers: [MyTicketsController, ClientTicketsController],
  providers: [
    AccountTicketOpener,
    MyTicketsService,
    ClientTicketService,
    TicketMailOutbox,
    StoredFiles,
    TicketEvents,
    TicketAttachmentService,
    TicketThreadService,
    TicketReadService,
  ],
})
export class SupportClientModule {}
