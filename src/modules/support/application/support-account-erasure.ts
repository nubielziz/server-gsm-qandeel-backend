// SupportAccountErasure: the support module's part of account anonymization (feature 18, B175; decision 064). It clears the ticket page links of
// the account being erased and (feature 28) deletes the attachments of their tickets and ends their ticket streams. Registered with the
// customers module's hook list at boot, so the customers module never imports support.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { type AccountErasureHook, AccountErasureHooks } from '../../customers';
import { clearTicketTokensOfAccount } from '../infra/ticket.repository';
import { TicketAttachmentService } from './ticket-attachment.service';

/**
 * Sets the token of an account's tickets to NULL when the account is anonymized.
 *
 * Why: `POST /admin/clients/:id/anonymize` must leave no way back to the account's data. A ticket's capability token (decision 010) is
 * mailed to the requester and opens the thread without any sign-in, so it is personal data that outlives the account. After the hook
 * `GET /store/v1/tickets/:token` answers 404 for the old link. The tickets and messages themselves stay (staff history). Feature 28
 * (rule 10): every attachment of the account's tickets is deleted too (both sides' files; a file another record still uses is kept), and
 * the ticket streams still open with the old link end (`bye session_ended`). The same call runs for the guest row of a proven email
 *: it is an account row too.
 *
 * Side effects: updates `support_tickets.token`, `token_hash` and `token_enc` (every stored form of the link, decision 054) and
 * `ticket_messages.file_ids` and deletes `files` rows on the anonymization's transaction (the objects after its commit); a failure rolls
 * the whole anonymization back. Rings `ticket revoked` after the commit.
 */
@Injectable()
export class SupportAccountErasure implements AccountErasureHook, OnModuleInit {
  constructor(
    private readonly hooks: AccountErasureHooks,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /** Adds this hook to the customers module's list. */
  onModuleInit(): void {
    this.hooks.add(this);
  }

  /**
   * Clears the ticket links of one account.
   *
   * @param tx the anonymization's transaction
   * @param accountId the account
   */
  async eraseAccount(tx: DbExecutor, accountId: number): Promise<void> {
    await clearTicketTokensOfAccount(tx, accountId);
    await this.attachments.eraseForAccount(tx, accountId);
  }
}
