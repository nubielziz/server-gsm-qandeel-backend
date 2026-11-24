// The inbox as a real-time source (feature 27, decision 037): turns an inbox doorbell into `notification.created`,
// `notification.read` and `unread.changed` frames for the owner's open streams, replays what a reconnect missed and sends the count
// after `ready`. Every query carries the owner's two keys; the text is made for the viewer. API only.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../../infra/db';
import {
  type Delivery,
  type Doorbell,
  type Frame,
  type RealtimeSource,
  RealtimeSources,
  type StreamViewer,
} from '../../../../infra/realtime';
import type { NotificationAudience, NotificationRecipientType } from '../../db/schema';
import { recipientOf } from '../notification-foreign-reads';
import { INBOX_TOPIC } from './inbox-doorbell';
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATION_READ_EVENT,
  UNREAD_CHANGED_EVENT,
  zNotificationCreatedEvent,
  zNotificationReadEvent,
  zUnreadChangedEvent,
} from './inbox-realtime.events';
import { InboxTextRegistry } from './inbox-texts';
import { type InboxReader, inboxView } from './inbox-views';
import {
  type InboxOwner,
  type InboxRow,
  UNREAD_CAP,
  campaignRowsFor,
  countUnread,
  countUnreadOf,
  inboxRowFor,
  inboxRowsAfter,
  newestInboxId,
} from './inbox.repository';

/** The most items one reconnect replays; one more missed means `resync` (the client refetches its list). */
export const INBOX_REPLAY_LIMIT = 50;
/** People counted by one grouped query of a `recount`. */
const RECOUNT_BATCH = 500;
/** The most account viewers remembered per type for a `recount` (the oldest is forgotten first). */
const MAX_WATCHED = 100_000;

const RECIPIENT_TYPES: readonly NotificationRecipientType[] = ['staff', 'account'];
const isRecipientType = (value: unknown): value is NotificationRecipientType =>
  typeof value === 'string' && (RECIPIENT_TYPES as readonly string[]).includes(value);
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
/**
 * The audience key of an owner's streams: `u:<kind>:<id>`, the key the hub gives a viewer of that kind and the session doorbell names for a
 * subject (decision 064: an account of either rank is one kind, so a merchant's stream and a shopper's stream share one key space and a key
 * is never the key of another kind with the same number).
 */
const keyOf = (owner: InboxOwner) => `u:${owner.type}:${owner.id}`;

/** The inbox of a viewer: staff and accounts have one; the holder of a ticket link has none. */
function ownerOf(viewer: StreamViewer): InboxOwner | undefined {
  return viewer.kind === 'ticket' ? undefined : { type: viewer.kind, id: viewer.id };
}

/** What the viewer's saved account says: the `{{name}}` of a broadcast, and the audience of its rank. */
interface Saved {
  readonly name: string;
  readonly audience: NotificationAudience;
}

/**
 * The inbox source of the live streams.
 *
 * Why: owner request (2026-11-15): a notification appears at once. The doorbell carries ids only; this source re-reads the item
 * with the owner's keys (`visibleTo`), so nothing of another person can be rendered, and renders it per viewer (the account's
 * name fills `{{name}}`), exactly as the inbox lists do (`inboxView`).
 *
 * Side effects: reads `notification_inbox`, `notification_campaigns` and the recipient's account; registers itself with the hub's
 * source registry at module start.
 *
 * @see GET /admin/stream, GET /client/stream, GET /store/v1/me/stream
 */
@Injectable()
export class InboxRealtimeSource implements RealtimeSource, OnModuleInit {
  readonly topic = INBOX_TOPIC;
  readonly cursorKey = 'i';
  private readonly saved = new WeakMap<StreamViewer, Saved>();
  private readonly loading = new WeakMap<StreamViewer, Promise<void>>();
  /** Account viewers seen at open, by type, oldest first: the candidates of a `recount` (filtered by `has`). */
  private readonly watched = new Map<NotificationRecipientType, Set<number>>(
    RECIPIENT_TYPES.map((type) => [type, new Set<number>()]),
  );

  constructor(
    private readonly db: DbService,
    private readonly texts: InboxTextRegistry,
    private readonly sources: RealtimeSources,
  ) {}

  /** Registers the source before the API listens. */
  onModuleInit(): void {
    this.sources.register(this);
  }

  /**
   * The inbox adds no audience key: an item is for its recipient, `u:<type>:<id>`.
   *
   * @returns no key
   */
  keysFor(): readonly string[] {
    return [];
  }

  /**
   * The newest inbox id: a stream without a cursor replays nothing before it.
   *
   * @param viewer the viewer of the new stream
   * @returns the largest `notification_inbox.id` (0 for a ticket viewer, who has no inbox)
   */
  async head(viewer: StreamViewer): Promise<number> {
    const owner = ownerOf(viewer);
    if (!owner) return 0;
    await this.prime(viewer, owner);
    return newestInboxId(this.db.db);
  }

  /**
   * The viewer's visible items after the cursor, oldest first, as `notification.created` with `live: false`.
   *
   * @param viewer the viewer of the reconnecting stream
   * @param after the last item id it saw
   * @param limit the hub's limit (the inbox replays at most {@link INBOX_REPLAY_LIMIT})
   * @returns the frames, or `resync` when more were missed
   */
  async replay(viewer: StreamViewer, after: number, limit: number): Promise<Frame[] | 'resync'> {
    const owner = ownerOf(viewer);
    if (!owner) return [];
    await this.prime(viewer, owner);
    const most = Math.min(limit, INBOX_REPLAY_LIMIT);
    const rows = await inboxRowsAfter(this.db.db, owner, after, most + 1);
    if (rows.length > most) return 'resync';
    if (rows.length === 0) return [];
    const unread = await countUnread(this.db.db, owner);
    return rows.map((row) => this.createdFrame(row, unread, false));
  }

  /**
   * The unread count, after `ready` and the replay.
   *
   * @param viewer the viewer of the stream
   * @returns one `unread.changed` frame (none for a ticket viewer)
   */
  async snapshot(viewer: StreamViewer): Promise<Frame[]> {
    const owner = ownerOf(viewer);
    if (!owner) return [];
    const unread = await countUnread(this.db.db, owner);
    return [{ event: UNREAD_CHANGED_EVENT, data: zUnreadChangedEvent.parse({ unread }) }];
  }

  /**
   * Turns an inbox doorbell into frames for the owners' open streams.
   *
   * @param doorbell `created` (an event item, or a campaign chunk), `read`, or `recount`
   * @param has whether an open stream listens to a key (nothing is read for a person without one)
   * @returns the deliveries, one per owner
   */
  async resolve(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    switch (doorbell.op) {
      case 'created':
        return isId(doorbell['campaignId']) ? this.campaignCreated(doorbell, has) : this.itemCreated(doorbell, has);
      case 'read':
        return this.read(doorbell, has);
      case 'recount':
        return this.recount(doorbell, has);
      default:
        return [];
    }
  }

  /** `created` with `itemId`: the one item, for its recipient. */
  private async itemCreated(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const owner = firstOwnerOf(doorbell);
    const itemId = doorbell['itemId'];
    if (!owner || !isId(itemId) || !has(keyOf(owner))) return [];
    const row = await inboxRowFor(this.db.db, owner, itemId);
    if (!row) return [];
    const unread = await countUnread(this.db.db, owner);
    return [{ keys: [keyOf(owner)], frame: this.createdFrame(row, unread, true) }];
  }

  /** `created` with `campaignId`: the chunk's items of the people with an open stream, one query and one grouped count. */
  private async campaignCreated(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const type = doorbell['type'];
    const ids = doorbell['ids'];
    if (!isRecipientType(type) || !Array.isArray(ids)) return [];
    const connected = ids.filter(isId).filter((id) => has(keyOf({ type, id })));
    if (connected.length === 0) return [];
    const rows = await campaignRowsFor(this.db.db, doorbell['campaignId'] as number, type, connected);
    if (rows.length === 0) return [];
    const counts = await countUnreadOf(
      this.db.db,
      type,
      rows.map((row) => row.item.recipientId),
    );
    return rows.map((row) => ({
      keys: [keyOf({ type, id: row.item.recipientId })],
      frame: this.createdFrame(row, Math.min(counts.get(row.item.recipientId) ?? 0, UNREAD_CAP), true),
    }));
  }

  /** `read`: the ids (or all) and the fresh count, for the owner's other streams. */
  private async read(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const owner = firstOwnerOf(doorbell);
    if (!owner || !has(keyOf(owner))) return [];
    const all = doorbell['all'] === true;
    const itemIds = Array.isArray(doorbell['itemIds']) ? doorbell['itemIds'].filter(isId) : [];
    const upToId = doorbell['upToId'];
    const unread = await countUnread(this.db.db, owner);
    const data = zNotificationReadEvent.parse({
      ids: all ? [] : itemIds,
      all,
      upToId: all && isId(upToId) ? upToId : null,
      unread,
    });
    return [{ keys: [keyOf(owner)], frame: { event: NOTIFICATION_READ_EVENT, data } }];
  }

  /** `recount`: `unread.changed` for every connected viewer of the types, counted in batches. */
  private async recount(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const types = Array.isArray(doorbell['types']) ? doorbell['types'].filter(isRecipientType) : [];
    const deliveries: Delivery[] = [];
    for (const type of new Set(types)) {
      const watched = this.watched.get(type)!;
      const connected: number[] = [];
      for (const id of watched) {
        if (has(keyOf({ type, id }))) connected.push(id);
        else watched.delete(id);
      }
      for (let at = 0; at < connected.length; at += RECOUNT_BATCH) {
        const batch = connected.slice(at, at + RECOUNT_BATCH);
        const counts = await countUnreadOf(this.db.db, type, batch);
        for (const id of batch) {
          const data = zUnreadChangedEvent.parse({ unread: counts.get(id) ?? 0 });
          deliveries.push({ keys: [keyOf({ type, id })], frame: { event: UNREAD_CHANGED_EVENT, data } });
        }
      }
    }
    return deliveries;
  }

  /** A `notification.created` frame whose item is rendered for each viewer (all of them the item's owner). */
  private createdFrame(row: InboxRow, unread: number, live: boolean): Frame {
    return {
      event: NOTIFICATION_CREATED_EVENT,
      cursor: row.item.id,
      data: (viewer: StreamViewer) =>
        zNotificationCreatedEvent.parse({ item: inboxView(row, this.readerOf(viewer), this.texts), unread, live }),
    };
  }

  /** The reader of the inbox lists: the audience of the viewer's rank and the account's name. */
  private readerOf(viewer: StreamViewer): InboxReader {
    const saved = this.saved.get(viewer);
    return {
      audience: saved?.audience ?? (viewer.kind === 'staff' ? 'staff' : 'customer'),
      name: saved?.name ?? viewer.name,
    };
  }

  /** Reads the viewer's saved name once per stream, and remembers the viewer for a `recount`. */
  private async prime(viewer: StreamViewer, owner: InboxOwner): Promise<void> {
    const watched = this.watched.get(owner.type)!;
    // Re-adding moves the viewer to the end: the first entries are the ones not seen for the longest.
    watched.delete(owner.id);
    watched.add(owner.id);
    if (watched.size > MAX_WATCHED) watched.delete(watched.values().next().value as number);
    if (this.saved.has(viewer)) return;
    let loading = this.loading.get(viewer);
    if (!loading) {
      loading = recipientOf(this.db.db, owner.type, owner.id).then((recipient) => {
        this.saved.set(viewer, {
          name: recipient?.name ?? viewer.name,
          audience: recipient?.audience ?? (owner.type === 'staff' ? 'staff' : 'customer'),
        });
      });
      this.loading.set(viewer, loading);
    }
    await loading;
  }
}

/** The owner a doorbell names first: `{ type, ids: [id] }`. */
function firstOwnerOf(doorbell: Doorbell): InboxOwner | undefined {
  const type = doorbell['type'];
  const ids = doorbell['ids'];
  if (!isRecipientType(type) || !Array.isArray(ids) || !isId(ids[0])) return undefined;
  return { type, id: ids[0] };
}
