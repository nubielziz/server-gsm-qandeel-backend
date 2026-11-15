// The live events of the inbox (feature 27, decision 037; docs/contract/realtime-events.md): the zod schemas of their data. The hub
// writes nothing a schema refused: a mismatch is logged and the frame skipped.
import { z } from 'zod';
import { zId } from '../../../../common/contract';
import { listStaffInbox } from './inbox.contracts';

/** An in-app item was made for the viewer. */
export const NOTIFICATION_CREATED_EVENT = 'notification.created';
/** The viewer read one item or all of them, on any tab or device. */
export const NOTIFICATION_READ_EVENT = 'notification.read';
/** The viewer's unread count, after `ready`, a replay or a `resync`, or when it changed for another reason. */
export const UNREAD_CHANGED_EVENT = 'unread.changed';

const zUnread = z.number().int().min(0).max(100);

/**
 * The data of `notification.created`: the item exactly as the inbox lists answer it, the fresh count and whether it is live.
 *
 * Why: the client puts the item at the top of its list and the count on the bell without a request; `live: false` marks a
 * replayed item (no toast).
 */
export const zNotificationCreatedEvent = z.object({
  // The item schema of the three inbox lists (`zInboxItem` of inbox.contracts.ts): one shape for the list and the stream.
  item: listStaffInbox.success.schema,
  unread: zUnread,
  live: z.boolean(),
});

/**
 * The data of `notification.read`.
 *
 * Why: another tab or device of the same person marks the items read and updates its bell.
 */
export const zNotificationReadEvent = z.object({
  ids: z.array(zId),
  all: z.boolean(),
  upToId: zId.nullable(),
  unread: zUnread,
});

/**
 * The data of `unread.changed`.
 *
 * Why: the bell shows the count without polling.
 */
export const zUnreadChangedEvent = z.object({ unread: zUnread });
