// CustomerLinks: issues a one-time link for a customer and writes its mail event in the same transaction.
import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../infra/db';
import { CustomerAuthTokens } from '../../identity';
import { PURPOSE_OF_KIND } from './mail/customer-mail-jobs';
import { CustomerMailOutbox, type CustomerMailKind } from './mail/customer-mail-outbox';

/** What `send` takes. */
export interface SendLinkInput {
  readonly kind: CustomerMailKind;
  readonly customerId: number;
  /** The staff member who sent the link; omitted for a link the customer asked for. */
  readonly createdBy?: number;
  /** The IP of the request, for the record. */
  readonly ip?: string;
}

/**
 * Sends a customer one of the four links.
 *
 * Why: every flow that emails a link (sign-in link, forgot password, staff invitation, staff reset, email verification) does the
 * same two things in one transaction: a token row (newest wins, hash only) and an outbox event with ids only (decision 020). The
 * clear token of the mail is made later, inside the mail job, which rotates this row's token (`CustomerMailJobs`).
 *
 * Side effects: inserts an `auth_tokens` row, voids the customer's older unused links of the same family, and inserts an
 * `outbox_events` row.
 */
@Injectable()
export class CustomerLinks {
  constructor(
    private readonly tokens: CustomerAuthTokens,
    private readonly mail: CustomerMailOutbox,
  ) {}

  /**
   * Issues the link and queues its mail.
   *
   * @param work the caller's transaction
   * @param input the kind of mail, the customer and who sent it
   * @returns the id of the link row
   */
  async send(work: Pick<TransactionContext, 'tx'>, input: SendLinkInput): Promise<number> {
    const issued = await this.tokens.issue(work, {
      customerId: input.customerId,
      purpose: PURPOSE_OF_KIND[input.kind],
      createdBy: input.createdBy ?? null,
      ip: input.ip ?? null,
    });
    // The issued token is a placeholder nobody receives: the mail job rotates it, so only the row's id goes on.
    await this.mail.enqueue(work, { kind: input.kind, customerId: input.customerId, tokenId: issued.id });
    return issued.id;
  }
}
