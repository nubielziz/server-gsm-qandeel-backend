// The support module's part of customer anonymization (feature 18, B175): it clears the ticket page links of the customer being erased
// and (feature 28) deletes the attachments of their tickets and ends their ticket streams. Registered with the customers module's hook
// list at boot, so the customers module never imports support.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../infra/db';
import { type CustomerErasureHook, CustomerErasureHooks, CustomerErasureModule } from '../customers';
import { StoredFiles } from '../platform';
import { TicketAttachmentService } from './application/ticket-attachment.service';
import { TicketEvents } from './application/ticket-events';
import { clearTicketTokensOfCustomer } from './infra/ticket.repository';

/**
 * Sets the token of a customer's tickets to NULL when the customer is anonymized.
 *
 * Why: `POST /admin/customers/:id/anonymize` must leave no way back to the customer's data. A ticket's capability token (decision 010) is
 * mailed to the customer and opens the thread without any account, so it is personal data that outlives the account. After the hook
 * `GET /store/v1/tickets/:token` answers 404 for the old link. The tickets and messages themselves stay (staff history); a ticket of a
 * merchant is not touched. Feature 28 (rule 10): every attachment of the customer's tickets is deleted too (both sides' files; a file
 * another record still uses is kept), and the ticket streams still open with the old link end (`bye session_ended`).
 *
 * Side effects: updates `support_tickets.token`, `token_hash` and `token_enc` (every stored form of the link, decision 054) and
 * `ticket_messages.file_ids` and deletes `files` rows on the anonymization's
 * transaction (the objects after its commit); a failure rolls the whole anonymization back. Rings `ticket revoked` after the commit.
 */
@Injectable()
export class SupportCustomerErasure implements CustomerErasureHook, OnModuleInit {
  constructor(
    private readonly hooks: CustomerErasureHooks,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /** Adds this hook to the customers module's list. */
  onModuleInit(): void {
    this.hooks.add(this);
  }

  /**
   * Clears the ticket links of one customer.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   */
  async eraseCustomer(tx: DbExecutor, customerId: number): Promise<void> {
    await clearTicketTokensOfCustomer(tx, customerId);
    await this.attachments.eraseForCustomer(tx, customerId);
  }
}

/**
 * Provides {@link SupportCustomerErasure}.
 *
 * Why: it needs the hook list (a global leaf of the customers module) and writes through the transaction it is given; since feature 28 it
 * also deletes the attachments (object storage, the settings reader) and rings the ticket doorbell (the real-time publisher), so a test app
 * built without the database or the infrastructure leaves it out with the other support modules.
 */
@Module({
  imports: [CustomerErasureModule],
  providers: [SupportCustomerErasure, StoredFiles, TicketEvents, TicketAttachmentService],
})
export class SupportErasureModule {}
