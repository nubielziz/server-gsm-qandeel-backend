// The support module's part of account anonymization (feature 18, B175; one account type, decision 064): it clears the ticket page links
// of the account being erased and (feature 28) deletes the attachments of its tickets and ends their ticket streams. The hook itself is
// `SupportAccountErasure` (application/support-account-erasure.ts), registered with the customers module's hook list at boot, so the
// customers module never imports support.
import { Module } from '@nestjs/common';
import { CustomerErasureModule } from '../customers';
import { StoredFiles } from '../platform';
import { SupportAccountErasure } from './application/support-account-erasure';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketEvents } from './application/ticket-events';

/**
 * Provides `SupportAccountErasure`, the support hook of the anonymization.
 *
 * Why: it needs the hook list (`AccountErasureHooks`, a global leaf of the customers module) and writes through the transaction it is
 * given; since feature 28 it also deletes the attachments (object storage, the settings reader) and rings the ticket doorbell (the
 * real-time publisher), so a test app built without the database or the infrastructure leaves it out with the other support modules. The
 * attachment service reads the account through identity's global `AccountDirectory`.
 *
 * Side effects at boot: the hook adds itself to `AccountErasureHooks`.
 */
@Module({
  imports: [CustomerErasureModule],
  providers: [SupportAccountErasure, StoredFiles, TicketEvents, TicketAttachmentService],
})
export class SupportErasureModule {}
