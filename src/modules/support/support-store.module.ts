// The storefront routes and use cases of the support module (stage 17): open a ticket, read it, write on it, and the ticket token
// resolver; feature 28 adds the ticket page's live stream, read mark and attachments, and the ticket source of the live streams.
// Separate from SupportModule so a test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { RealtimeHubModule } from '../../infra/realtime';
import { CustomerDirectoryModule } from '../customers';
import { StoredFiles } from '../platform';
import { SupportGuestClaimParticipant } from './application/guest-claim.participant';
import { StoreTicketService } from './application/store-ticket.service';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketEvents } from './application/ticket-events';
import { TicketMailOutbox } from './application/ticket-mail-outbox';
import { TicketReadService } from './application/ticket-read.service';
import { TicketThreadService } from './application/ticket-thread.service';
import { TicketTokenResolver } from './application/ticket-token.resolver';
import { StoreTicketLiveController } from './controllers/store-ticket-live.controller';
import { StoreTicketStreamController } from './controllers/store-ticket-stream.controller';
import { StoreTicketsController } from './controllers/store-tickets.controller';
import { TicketRealtimeSource } from './realtime/ticket-realtime.source';

/**
 * Provides `/store/v1/tickets*` and the ticket source of the live streams.
 *
 * Why: these use cases need the global database, crypto, rate-limit, cache, storage and clock providers, the outbox (the receipt), the
 * customers module's directory (the guest customer of a new address), the identity guard's resolver registry and the API's real-time hub
 * (the ticket stream), which a database-less test app does not have. The ticket source lives here because the hub is API-only; it serves
 * every stream (staff, merchants, customers and ticket links). `TicketThreadService` and the read and attachment services are
 * exported for the account surfaces of slice B2. The account rows come from identity's global `AccountDirectory` and the rank kinds from
 * the catalog's global `RankGroupReads` (decision 064).
 *
 * Side effects at boot (API process only): `SupportGuestClaimParticipant` registers `support` with identity's `GuestClaimParticipants`:
 * the tickets and messages of a guest row move to the account that claims it.
 */
@Module({
  imports: [CustomerDirectoryModule, RealtimeHubModule],
  controllers: [StoreTicketsController, StoreTicketStreamController, StoreTicketLiveController],
  providers: [
    StoreTicketService,
    TicketMailOutbox,
    TicketTokenResolver,
    StoredFiles,
    TicketEvents,
    TicketAttachmentService,
    TicketThreadService,
    TicketReadService,
    TicketRealtimeSource,
    SupportGuestClaimParticipant,
  ],
  exports: [TicketThreadService, TicketReadService, TicketAttachmentService, TicketEvents],
})
export class SupportStoreModule {}
