// NotificationInbox: how code makes an in-app item for an event (platform module, feature 23, plan section 9.2). Campaign items are
// written by the fan-out; this writer serves events (the notification service, the event notifier, other modules after they register
// their own in-app text).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { DbExecutor } from '../../../../infra/db';
import type { NotificationRecipientType } from '../../db/schema';
import { type Recipient, audienceOf, recipientOf } from '../notification-foreign-reads';
import { InboxTextRegistry } from './inbox-texts';
import { insertEventItem } from './inbox.repository';

/** What an event item is about and for whom. */
export interface EventItemInput {
  readonly recipient: { readonly type: NotificationRecipientType; readonly id: number };
  /** The registered event key; the item exists only when an in-app text is registered for it. */
  readonly event: string;
  /** The event's placeholder values: never a secret, a token or a link with a token. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Names the occurrence (`outbox-<id>`, `campaign-test-<id>-<n>`), so a repeat makes no second item; omit for none. */
  readonly occurrence?: string;
}

/**
 * Tells whether a recipient may get in-app items.
 *
 * Why: an inbox exists for an active staff member, an active or pending merchant and an active customer with an account
 * (`Recipient.inboxEligible`, plan 9.5); a guest, a suspended person or a gone one gets no item.
 *
 * @param recipient the recipient read for the item
 * @returns true when an item is worth writing
 */
export function canReadInbox(recipient: Recipient): boolean {
  return recipient.inboxEligible;
}

/**
 * Writes in-app items for events.
 *
 * Why: S9: the main merchant and customer events also appear in the person's inbox; the item is written in the caller's
 * transaction, so it exists if and only if the event did. An event with no registered text, a recipient who is gone or cannot read
 * an inbox, and a repeated occurrence make nothing.
 *
 * Side effects: inserts at most one `notification_inbox` row per call.
 */
@Injectable()
export class NotificationInbox {
  constructor(
    private readonly texts: InboxTextRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Writes the item of an event, when the event has an in-app text.
   *
   * @param tx the caller's transaction
   * @param input the recipient, event, variables and occurrence
   * @returns the new item's id, or `undefined` when nothing was written
   */
  async addForEvent(tx: DbExecutor, input: EventItemInput): Promise<number | undefined> {
    const audience = audienceOf(input.recipient.type);
    const text = this.texts.get(audience, input.event);
    if (!text) return undefined;
    const recipient = await recipientOf(tx, input.recipient.type, input.recipient.id);
    if (!recipient || !canReadInbox(recipient)) return undefined;
    return insertEventItem(
      tx,
      {
        recipientType: input.recipient.type,
        recipientId: input.recipient.id,
        event: input.event,
        category: text.category,
        variables: input.variables ?? {},
        dedupeKey: input.occurrence === undefined ? null : `inapp:${audience}:${input.event}:${input.occurrence}`,
      },
      this.clock.now(),
    );
  }

  /**
   * Writes an item for a caller of another module (features 20 and 21, after they registered their in-app text).
   *
   * @param tx the caller's transaction
   * @param input the recipient, event, variables and occurrence
   * @returns the new item's id, or `undefined` when nothing was written
   */
  add(tx: DbExecutor, input: EventItemInput): Promise<number | undefined> {
    return this.addForEvent(tx, input);
  }
}
