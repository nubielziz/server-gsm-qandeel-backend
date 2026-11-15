// The doorbells of the inbox (feature 27, decision 037): after the commit of a change to `notification_inbox`, one message with ids
// only tells the API processes that hold live streams to re-read the item or the count. Beside `NotificationInbox` (API and worker).
import { Injectable } from '@nestjs/common';
import { RealtimePublisher } from '../../../../infra/realtime';
import type { NotificationRecipientType } from '../../db/schema';
import type { InboxOwner } from './inbox.repository';

/** The doorbell topic of the inbox and of its source. */
export const INBOX_TOPIC = 'inbox';
/** Recipient ids per `created` doorbell of a campaign chunk: 500 ids fit well in the 8 KB of a doorbell. */
export const CHUNK_IDS_PER_DOORBELL = 500;

/**
 * Rings the inbox doorbells.
 *
 * Why: decision 037: a notification appears at once on the person's open pages. Every method rings after the commit of the
 * current transaction, or at once outside one (`publishOnCommit`), so a rolled-back change rings nothing; a doorbell carries ids
 * only and never fails the use case.
 *
 * Side effects: `PUBLISH` on the cache Redis (topic `inbox`).
 */
@Injectable()
export class InboxDoorbell {
  constructor(private readonly realtime: RealtimePublisher) {}

  /**
   * An event item was made for one person.
   *
   * @param type the recipient's type
   * @param recipientId the recipient
   * @param itemId the new `notification_inbox` id
   */
  created(type: NotificationRecipientType, recipientId: number, itemId: number): void {
    this.realtime.publishOnCommit(INBOX_TOPIC, 'created', { type, ids: [recipientId], itemId });
  }

  /**
   * A campaign chunk made items for these people (only those who got one now: a repeated chunk rings nothing).
   *
   * @param campaignId the campaign
   * @param type the type of every id
   * @param recipientIds the people who got an item
   */
  campaignChunk(campaignId: number, type: NotificationRecipientType, recipientIds: readonly number[]): void {
    for (let at = 0; at < recipientIds.length; at += CHUNK_IDS_PER_DOORBELL) {
      const ids = recipientIds.slice(at, at + CHUNK_IDS_PER_DOORBELL);
      this.realtime.publishOnCommit(INBOX_TOPIC, 'created', { type, ids, campaignId });
    }
  }

  /**
   * The owner read one item (it was unread).
   *
   * @param owner whose inbox
   * @param itemId the item
   */
  read(owner: InboxOwner, itemId: number): void {
    this.realtime.publishOnCommit(INBOX_TOPIC, 'read', { type: owner.type, ids: [owner.id], itemIds: [itemId] });
  }

  /**
   * The owner read every unread item, up to an id or all of them.
   *
   * @param owner whose inbox
   * @param upToId the newest id the screen showed, or `null` for every item
   */
  readAll(owner: InboxOwner, upToId: number | null): void {
    this.realtime.publishOnCommit(INBOX_TOPIC, 'read', { type: owner.type, ids: [owner.id], all: true, upToId });
  }

  /**
   * The unread counts of these recipient types may have changed for another reason (a campaign was cancelled: its items hide).
   *
   * @param types the audience's recipient types
   */
  recount(types: readonly NotificationRecipientType[]): void {
    if (types.length > 0) this.realtime.publishOnCommit(INBOX_TOPIC, 'recount', { types: [...new Set(types)] });
  }
}
