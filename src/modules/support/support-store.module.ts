// The storefront routes and use cases of the support module (stage 17): open a ticket, read it, write on it, rate it, and the ticket token
// resolver. Separate from SupportModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { CustomerDirectoryModule } from '../customers';
import { StoreTicketService } from './application/store-ticket.service';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { TicketTokenResolver } from './application/ticket-token.resolver';
import { StoreTicketsController } from './controllers/store-tickets.controller';

/**
 * Provides `/store/v1/tickets*`.
 *
 * Why: these use cases need the global database, crypto, rate-limit and clock providers, the outbox (the receipt), the customers module's
 * directory (the guest customer of a new address) and the identity guard's resolver registry, which a database-less test app does not have.
 */
@Module({
  imports: [CustomerDirectoryModule],
  controllers: [StoreTicketsController],
  providers: [StoreTicketService, TicketMailOutbox, TicketTokenResolver],
})
export class SupportStoreModule {}
