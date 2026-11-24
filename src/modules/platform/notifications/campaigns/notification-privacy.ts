// NotificationPrivacy: what the notification center forgets about a person who is erased (feature 23, plan section 9.7, owner decision O6).
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { DbExecutor } from '../../../../infra/db';
import { type NotificationRecipientType, notificationInbox, notifications } from '../../db/schema';

/**
 * Clears a person's in-app items and the personal values of their log rows.
 *
 * Why: anonymizing an account (`POST /admin/clients/:id/anonymize`, any rank) must leave no way back to its data: the inbox items repeat
 * orders and announcements, and a log row's payload holds the account's name (`customerName`, `merchantName`). The log rows themselves
 * stay (staff history of what was sent and when); only the payload is emptied. The customers module calls this from its erasure hook, in
 * the anonymization's own transaction, so either everything is cleared or nothing is.
 *
 * Side effects: deletes `notification_inbox` rows and updates `notifications.payload` of the person.
 */
@Injectable()
export class NotificationPrivacy {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Erases one person's inbox and log payloads.
   *
   * @param tx the caller's transaction
   * @param type the kind of person (`account` for an account of any rank, a guest row included)
   * @param id the person (the account id)
   * @returns how many items were deleted and how many log payloads were emptied
   */
  async eraseRecipient(
    tx: DbExecutor,
    type: NotificationRecipientType,
    id: number,
  ): Promise<{ inboxItems: number; payloads: number }> {
    const items = await tx
      .delete(notificationInbox)
      .where(and(eq(notificationInbox.recipientType, type), eq(notificationInbox.recipientId, id)))
      .returning({ id: notificationInbox.id });
    const rows = await tx
      .update(notifications)
      .set({ payload: {}, updatedAt: this.clock.now() })
      .where(and(eq(notifications.recipientType, type), eq(notifications.recipientId, id)))
      .returning({ id: notifications.id });
    return { inboxItems: items.length, payloads: rows.length };
  }
}
