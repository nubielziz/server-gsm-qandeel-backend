// The support chat as a real-time source (feature 28, plan § 3.4, decision 037): turns a ticket doorbell into the staff view (key
// `support:staff`) and the requester view (keys `ticket:<id>` and the requester's account key) of each event, replays the messages a
// reconnect missed and ends the streams of a revoked ticket link. Every read is scoped by ticket, and the requester view never carries an
// internal note, a system message, a staff name, the assignee or the priority. API only.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { LogThrottle } from '../../../common/log-throttle';
import { DbService } from '../../../infra/db';
import {
  type Delivery,
  type Doorbell,
  type Frame,
  type RealtimeSource,
  RealtimeSources,
  type StreamViewer,
} from '../../../infra/realtime';
import { grants } from '../../identity';
import { TicketAttachmentService } from '../application/ticket-attachment.service';
import { TICKET_TOPIC } from '../application/ticket-events';
import {
  type AttachmentFiles,
  toAttachments,
  toMessageView,
  toStoreMessage,
  toTicketView,
} from '../application/ticket-views';
import type { SupportTicket, TicketMessage } from '../db/schema';
import { hasUnread } from '../domain/seen';
import { toWireStatus } from '../domain/ticket-status';
import { findStaffName } from '../infra/support-foreign-reads';
import {
  type MessageRow,
  type MessageScope,
  type TicketRow,
  findMessageRow,
  findTicket,
  findTicketRow,
  lastPublicTimes,
  messageRowsAfter,
  newestMessageId,
} from '../infra/ticket.repository';
import {
  TICKET_MESSAGE_CREATED_EVENT,
  TICKET_READ_EVENT,
  TICKET_TYPING_EVENT,
  TICKET_UPDATED_EVENT,
  zRequesterMessageCreated,
  zRequesterTicketRead,
  zRequesterTicketTyping,
  zRequesterTicketUpdated,
  zStaffMessageCreated,
  zStaffTicketRead,
  zStaffTicketTyping,
  zStaffTicketUpdated,
} from './ticket-realtime.events';

/** The audience key of every staff stream whose role grants `support:read`. */
export const SUPPORT_STAFF_KEY = 'support:staff';

/** The most tickets' messages one reconnect replays; one more missed means `resync`. */
export const TICKET_REPLAY_LIMIT = 100;

/**
 * The audience key of the streams opened with a ticket's link (also the first cap key of such a stream).
 *
 * @param ticketId the ticket
 * @returns `ticket:<id>`
 */
export const ticketStreamKey = (ticketId: number): string => `ticket:${ticketId}`;

/** The account key of a ticket's requester (`u:customer:42`, `u:client:7`: the default key of brief 27). */
const accountKey = (ticket: Pick<SupportTicket, 'requesterType' | 'requesterId'>): string =>
  `u:${ticket.requesterType}:${ticket.requesterId}`;

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A message the requester may see: public and not the system's. */
const requesterMay = (message: Pick<TicketMessage, 'isInternal' | 'authorType'>): boolean =>
  !message.isInternal && message.authorType !== 'system';

/** The id a requester event names: a merchant's ticket id, `null` for a customer (who addresses the ticket by its token). */
const requesterTicketId = (ticket: Pick<SupportTicket, 'id' | 'requesterType'>): number | null =>
  ticket.requesterType === 'client' ? ticket.id : null;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** One log line per interval for frames a schema refused. */
const LOG_INTERVAL_MS = 30_000;

/**
 * The ticket source of the live streams.
 *
 * Why: owner request (2026-11-15): support is a live conversation. The doorbell carries ids only; this source re-reads the ticket and the
 * message once and renders two views: staff (`support:staff`, every message, the inbox row, colleagues' typing with their name) and the
 * requester (`ticket:<id>` of the ticket link's streams and the requester's account key: public messages only, the ticket page's fields,
 * "Support is typing…" only for a reply). Nothing of another ticket can be rendered: every read names the ticket, and a replay is scoped
 * by the viewer (all tickets for staff, the requester's own tickets, the one ticket of a link). Each frame is parsed by its schema first
 * (the requester views are strict), so a frame that does not fit is logged and skipped, never sent.
 *
 * Side effects: reads `support_tickets`, `ticket_messages`, the files of a message and the requester's and author's names; registers
 * itself with the hub's source registry at module start.
 *
 * @see GET /admin/stream, GET /client/stream, GET /store/v1/me/stream, GET /store/v1/tickets/:token/stream
 */
@Injectable()
export class TicketRealtimeSource implements RealtimeSource, OnModuleInit {
  readonly topic = TICKET_TOPIC;
  readonly cursorKey = 't';
  private readonly logger = new Logger(TicketRealtimeSource.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);

  constructor(
    private readonly db: DbService,
    private readonly attachments: TicketAttachmentService,
    private readonly sources: RealtimeSources,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the source before the API listens. */
  onModuleInit(): void {
    this.sources.register(this);
  }

  /**
   * The keys of a viewer beyond its account key: `support:staff` for staff with `support:read`, `ticket:<id>` for a ticket link.
   *
   * @param viewer the viewer of a new stream
   * @returns the keys
   */
  keysFor(viewer: StreamViewer): readonly string[] {
    if (viewer.kind === 'staff') return grants(viewer.permissions, 'support:read') ? [SUPPORT_STAFF_KEY] : [];
    if (viewer.kind === 'ticket') return [ticketStreamKey(viewer.id)];
    return [];
  }

  /**
   * The newest message id: a stream without a cursor replays nothing before it.
   *
   * @returns the largest `ticket_messages.id` (0 without messages)
   */
  head(): Promise<number> {
    return newestMessageId(this.db.db);
  }

  /**
   * The messages the viewer may see after the cursor, oldest first, as `ticket.message.created` with `live: false`.
   *
   * @param viewer the viewer of the reconnecting stream
   * @param after the last message id it saw
   * @param limit the hub's limit (at most {@link TICKET_REPLAY_LIMIT})
   * @returns the frames, or `resync` when more were missed
   */
  async replay(viewer: StreamViewer, after: number, limit: number): Promise<Frame[] | 'resync'> {
    const scope = scopeOf(viewer);
    if (!scope) return [];
    const most = Math.min(limit, TICKET_REPLAY_LIMIT);
    const rows = await messageRowsAfter(this.db.db, scope, after, most + 1);
    if (rows.length > most) return 'resync';
    if (rows.length === 0) return [];
    const files = await this.attachments.filesOf(
      this.db.db,
      rows.map((row) => row.message),
    );
    return rows.flatMap((row) => {
      const frame =
        scope.kind === 'all'
          ? this.staffMessageFrame(row.ticket.id, row, files, false)
          : this.requesterMessageFrame(row.ticket, row.message, files, false);
      return frame ? [frame] : [];
    });
  }

  /**
   * Nothing is sent after the replay: the page has read the ticket itself.
   *
   * @returns no frame
   */
  snapshot(): Promise<Frame[]> {
    return Promise.resolve([]);
  }

  /**
   * Turns a ticket doorbell into deliveries.
   *
   * @param doorbell `message`, `updated`, `read`, `typing` or `revoked`, with `ticketId`
   * @param has whether an open stream listens to a key (nothing is read for a ticket nobody watches)
   * @returns the deliveries: the staff view to `support:staff`, the requester view to the ticket's link and account keys
   */
  async resolve(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const ticketId = doorbell['ticketId'];
    if (!isId(ticketId)) return [];
    switch (doorbell.op) {
      case 'message':
        return isId(doorbell['messageId']) ? this.message(ticketId, doorbell['messageId'], has) : [];
      case 'updated':
        return this.updated(ticketId, has);
      case 'read':
        return doorbell['by'] === 'requester' || doorbell['by'] === 'staff'
          ? this.read(ticketId, doorbell['by'], has)
          : [];
      case 'typing':
        return this.typing(ticketId, doorbell, has);
      case 'revoked':
        return has(ticketStreamKey(ticketId)) ? [{ keys: [ticketStreamKey(ticketId)], close: 'session_ended' }] : [];
      default:
        return [];
    }
  }

  /** The keys that listen: staff, and the requester's streams (the ticket link's and the account's). */
  private audience(ticket: SupportTicket, has: (key: string) => boolean): { staff: boolean; requester: string[] } {
    return {
      staff: has(SUPPORT_STAFF_KEY),
      requester: [ticketStreamKey(ticket.id), accountKey(ticket)].filter((key) => has(key)),
    };
  }

  /** `message`: the message (staff always; the requester only a public one), then the ticket. */
  private async message(ticketId: number, messageId: number, has: (key: string) => boolean): Promise<Delivery[]> {
    const row = await findTicketRow(this.db.db, ticketId);
    if (!row) return [];
    const audience = this.audience(row.ticket, has);
    const message = await findMessageRow(this.db.db, messageId);
    // A message of another ticket is never rendered for this one (a forged doorbell finds nothing).
    if (!message || message.message.ticketId !== ticketId) return [];
    const requesterSees = requesterMay(message.message) && audience.requester.length > 0;
    if (!audience.staff && !requesterSees) return [];
    const files = await this.attachments.filesOf(this.db.db, [message.message]);
    const deliveries: Delivery[] = [];
    if (audience.staff) {
      const created = this.staffMessageFrame(ticketId, message, files, true);
      if (created) deliveries.push({ keys: [SUPPORT_STAFF_KEY], frame: created });
      const updated = await this.staffUpdatedFrame(row);
      if (updated) deliveries.push({ keys: [SUPPORT_STAFF_KEY], frame: updated });
    }
    // The security core: a note or a system message gives the requester's streams nothing at all.
    if (requesterSees) {
      const created = this.requesterMessageFrame(row.ticket, message.message, files, true);
      if (created) deliveries.push({ keys: audience.requester, frame: created });
      const updated = this.requesterUpdatedFrame(row.ticket);
      if (updated) deliveries.push({ keys: audience.requester, frame: updated });
    }
    return deliveries;
  }

  /** `updated`: the inbox row for staff, the page's fields for the requester. */
  private async updated(ticketId: number, has: (key: string) => boolean): Promise<Delivery[]> {
    const row = await findTicketRow(this.db.db, ticketId);
    if (!row) return [];
    const audience = this.audience(row.ticket, has);
    const deliveries: Delivery[] = [];
    if (audience.staff) {
      const frame = await this.staffUpdatedFrame(row);
      if (frame) deliveries.push({ keys: [SUPPORT_STAFF_KEY], frame });
    }
    if (audience.requester.length > 0) {
      const frame = this.requesterUpdatedFrame(row.ticket);
      if (frame) deliveries.push({ keys: audience.requester, frame });
    }
    return deliveries;
  }

  /** `read`: the side's mark as stored now, for both sides (the other tabs of the side that marked included). */
  private async read(ticketId: number, by: 'requester' | 'staff', has: (key: string) => boolean): Promise<Delivery[]> {
    const ticket = await findTicket(this.db.db, ticketId);
    if (!ticket) return [];
    const upTo = by === 'requester' ? ticket.requesterSeenMessageId : ticket.staffSeenMessageId;
    const at = by === 'requester' ? ticket.requesterSeenAt : ticket.staffSeenAt;
    if (upTo === null || at === null) return [];
    const audience = this.audience(ticket, has);
    const deliveries: Delivery[] = [];
    if (audience.staff) {
      const frame = this.frame(TICKET_READ_EVENT, zStaffTicketRead, {
        ticketId,
        by,
        upToMessageId: upTo,
        at: at.toISOString(),
      });
      if (frame) deliveries.push({ keys: [SUPPORT_STAFF_KEY], frame });
    }
    if (audience.requester.length > 0) {
      const frame = this.frame(TICKET_READ_EVENT, zRequesterTicketRead, {
        ticketId: requesterTicketId(ticket),
        number: ticket.number,
        by: by === 'requester' ? 'you' : 'support',
        upToMessageId: upTo,
        at: at.toISOString(),
      });
      if (frame) deliveries.push({ keys: audience.requester, frame });
    }
    return deliveries;
  }

  /** `typing`: staff see who types; the requester sees only that support types a reply (never a note, never who). */
  private async typing(ticketId: number, doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]> {
    const by = doorbell['by'];
    const staffId = doorbell['staffId'];
    const mode = doorbell['mode'];
    if (by !== 'requester' && by !== 'staff') return [];
    if (by === 'staff' && (!isId(staffId) || (mode !== 'reply' && mode !== 'note'))) return [];
    const ticket = await findTicket(this.db.db, ticketId);
    if (!ticket) return [];
    const audience = this.audience(ticket, has);
    const deliveries: Delivery[] = [];
    if (audience.staff) {
      const staffName = by === 'staff' ? ((await findStaffName(this.db.db, staffId as number)) ?? 'Staff') : null;
      const frame = this.frame(TICKET_TYPING_EVENT, zStaffTicketTyping, {
        ticketId,
        by,
        staffId: by === 'staff' ? (staffId as number) : null,
        staffName,
        mode: by === 'staff' ? (mode as 'reply' | 'note') : null,
      });
      if (frame) deliveries.push({ keys: [SUPPORT_STAFF_KEY], frame });
    }
    if (by === 'staff' && mode === 'reply' && audience.requester.length > 0) {
      const frame = this.frame(TICKET_TYPING_EVENT, zRequesterTicketTyping, {
        ticketId: requesterTicketId(ticket),
        number: ticket.number,
      });
      if (frame) deliveries.push({ keys: audience.requester, frame });
    }
    return deliveries;
  }

  /** The staff view of a message: the thread's shape (author name, internal flag, attachments). */
  private staffMessageFrame(
    ticketId: number,
    row: MessageRow,
    files: AttachmentFiles,
    live: boolean,
  ): Frame | undefined {
    return this.frame(
      TICKET_MESSAGE_CREATED_EVENT,
      zStaffMessageCreated,
      { ticketId, message: toMessageView(row, files), live },
      row.message.id,
    );
  }

  /** The requester view of a message; `undefined` for anything that is not public (a second guard behind the callers'). */
  private requesterMessageFrame(
    ticket: Pick<SupportTicket, 'id' | 'number' | 'requesterType'>,
    message: TicketMessage,
    files: AttachmentFiles,
    live: boolean,
  ): Frame | undefined {
    if (!requesterMay(message)) return undefined;
    return this.frame(
      TICKET_MESSAGE_CREATED_EVENT,
      zRequesterMessageCreated,
      {
        ticketId: requesterTicketId(ticket),
        number: ticket.number,
        message: { ...toStoreMessage(message, files), attachments: toAttachments(message.fileIds, files) },
        live,
      },
      message.id,
    );
  }

  /** The staff view of a ticket: the inbox row, with the time of its latest public message and `late` from the clock. */
  private async staffUpdatedFrame(row: TicketRow): Promise<Frame | undefined> {
    const times = await lastPublicTimes(this.db.db, [row.ticket.id]);
    return this.frame(TICKET_UPDATED_EVENT, zStaffTicketUpdated, {
      // Decision 047: one frame for every staff stream, so a customer's address goes masked; the REST answers give it in full to holders of
      // customers:read.
      ticket: toTicketView(row, times.get(row.ticket.id), this.clock.now(), 'masked'),
    });
  }

  /** The requester view of a ticket: the fields of the ticket page and the requester's own `hasUnread`. */
  private requesterUpdatedFrame(ticket: SupportTicket): Frame | undefined {
    return this.frame(TICKET_UPDATED_EVENT, zRequesterTicketUpdated, {
      ticketId: requesterTicketId(ticket),
      number: ticket.number,
      status: toWireStatus(ticket.status),
      updatedAt: ticket.updatedAt.toISOString(),
      resolvedAt: iso(ticket.resolvedAt),
      canRate: ticket.status === 'resolved' && ticket.csatScore === null,
      csatScore: ticket.csatScore,
      hasUnread: hasUnread(ticket.lastStaffMessageId, ticket.requesterSeenMessageId),
    });
  }

  /** Parses a frame's data with its schema; a mismatch is logged (throttled) and the frame skipped. */
  private frame<S extends z.ZodType>(event: string, schema: S, data: z.input<S>, cursor?: number): Frame | undefined {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const allowed = this.throttle.attempt(event);
      if (allowed)
        this.logger.error(`A ${event} frame did not fit its schema and was skipped: ${parsed.error.message}`);
      return undefined;
    }
    return cursor === undefined ? { event, data: parsed.data } : { event, data: parsed.data, cursor };
  }
}

/** What a viewer may replay: every message for staff with `support:read`, public messages of its own tickets or of its link's ticket. */
function scopeOf(viewer: StreamViewer): MessageScope | undefined {
  switch (viewer.kind) {
    case 'staff':
      return grants(viewer.permissions, 'support:read') ? { kind: 'all' } : undefined;
    case 'ticket':
      return { kind: 'ticket', ticketId: viewer.id };
    case 'customer':
    case 'client':
      return { kind: 'requester', type: viewer.kind, id: viewer.id };
  }
}
