// NotificationLogAdminService: the read-only log behind `/admin/notifications*` (feature 12a): rows with the recipient masked by the server.
import { Injectable } from '@nestjs/common';
import type { JsonObject, JsonValue, ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { NotificationChannel, NotificationRecipientType, NotificationStatus } from '../db/schema';
import { maskEmail, maskTelegram } from './masking';
import { asString } from './notification-payload';
import { type LogRow, type NotificationSortField, findLogRow, listLogRows } from './notification.repository';

/** A log entry on the wire. */
export interface WireNotification {
  readonly id: number;
  readonly recipientType: NotificationRecipientType;
  readonly recipientId: number;
  readonly channel: NotificationChannel;
  readonly event: string;
  readonly status: NotificationStatus;
  readonly recipient: string;
  readonly attempts: number;
  readonly sentAt: string | null;
  readonly error: string | null;
  readonly payload?: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reads the notification log.
 *
 * Why: RULES settings 11 and M172: staff see what the system sent and why a message failed, never a whole address: the server masks
 * the recipient (`r***@example.com`, `@1***`) from the recipient's current row before the answer leaves the API. The list omits the
 * payload; the single read has it.
 *
 * Side effects: none (read only).
 */
@Injectable()
export class NotificationLogAdminService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists the log.
   *
   * @param query the parsed list request
   * @returns the page (without payloads) and the exact total for the filter
   */
  async list(query: ParsedListQuery<NotificationSortField>): Promise<{ rows: WireNotification[]; total: number }> {
    const { rows, total } = await listLogRows(this.db.db, query);
    return { rows: rows.map((row) => toWire(row, false)), total };
  }

  /**
   * Reads one notification.
   *
   * @param id the notification id
   * @returns the entry with its payload
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireNotification> {
    const row = await findLogRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No notification with this id.' });
    return toWire(row, true);
  }
}

/** Masks each address of a comma list (an operations email names the addresses in its payload). */
const maskAddresses = (addresses: string): string =>
  addresses
    .split(',')
    .map((address) => maskEmail(address.trim()))
    .join(', ');

/** The masked recipient of a row: the address of an email, the chat of a Telegram message. */
function recipientOf(row: LogRow): string {
  if (row.notification.channel === 'email') {
    // An alert's message has no recipient row: its addresses are in the payload.
    const payloadTo = (row.notification.payload as { to?: unknown }).to;
    return row.email === null && asString(payloadTo) ? maskAddresses(payloadTo) : maskEmail(row.email ?? '');
  }
  const payloadChat = (row.notification.payload as { chatId?: unknown }).chatId;
  return maskTelegram(row.telegramChatId ?? (asString(payloadChat) ? payloadChat : null));
}

/**
 * The payload as staff may see it: every Telegram chat id and every operations address list is masked, at any depth.
 *
 * Why: the recipient is masked (RULES settings 11), so a chat id in the payload (the bot's answers carry the chat they were sent to, and
 * a template variable or a nested object may carry one too) or the `to` addresses of an alert's email must not give back what the mask hides.
 */
function publicPayload(payload: JsonObject): JsonObject {
  return maskRecipients(payload) as JsonObject;
}

/** Copies a JSON value and replaces the value of every `chatId` and `to` key, in objects and in arrays, with its mask. */
function maskRecipients(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(maskRecipients);
  if (value === null || typeof value !== 'object') return value;
  const copy: JsonObject = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'chatId') copy[key] = maskTelegram(asString(inner) ? inner : null);
    else if (key === 'to') copy[key] = asString(inner) ? maskAddresses(inner) : maskRecipients(inner);
    else copy[key] = maskRecipients(inner);
  }
  return copy;
}

function toWire(row: LogRow, withPayload: boolean): WireNotification {
  const n = row.notification;
  return {
    id: n.id,
    recipientType: n.recipientType,
    recipientId: n.recipientId,
    channel: n.channel,
    event: n.event,
    status: n.status,
    recipient: recipientOf(row),
    attempts: n.attempts,
    sentAt: n.sentAt?.toISOString() ?? null,
    error: n.status === 'failed' ? n.error : null,
    // jsonb holds JSON by definition, so the cast only tells the compiler what Postgres guarantees.
    ...(withPayload ? { payload: publicPayload(n.payload as JsonObject) } : {}),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}
