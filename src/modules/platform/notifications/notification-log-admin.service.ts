// NotificationLogAdminService: the read-only log behind `/admin/notifications*` (feature 12a): rows with the recipient masked by the server.
import { Injectable } from '@nestjs/common';
import type { JsonObject, JsonValue, ParsedListQuery } from '../../../common/contract';
import type { CustomerContact } from '../../../common/customer-contact';
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
  readonly campaignId: number | null;
  readonly payload?: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The permission that shows the values of a notification's payload.
 *
 * Why: decision 054: what a message was built from holds replies, names and results of other areas; reading it needs the whole
 * notifications area (`notifications:*`), an Owner's `*` included. Others see the payload's keys with hidden values.
 */
export const NOTIFICATION_PAYLOAD_PERMISSION = 'notifications:*';

/** What replaces a text or number of a payload for a caller without {@link NOTIFICATION_PAYLOAD_PERMISSION}. */
export const HIDDEN_VALUE = '[hidden]';

/** How much of the payload one answer carries. */
type PayloadView = 'none' | 'full' | 'hidden';

/**
 * Reads the notification log.
 *
 * Why: RULES settings 11 and M172: staff see what the system sent and why a message failed, never a whole address: the server masks
 * the recipient (`r***@example.com`, `@1***`) from the recipient's current row before the answer leaves the API. The list omits the
 * payload; the single read has it, with its values shown only to holders of `notifications:*` (decision 054). A row that names the
 * address it went to shows that address masked (decision 047), and an account's address is searched only for callers who may read
 * accounts.
 *
 * Side effects: none (read only).
 */
@Injectable()
export class NotificationLogAdminService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists the log.
   *
   * @param query the parsed list request; `q` matches an account recipient's whole address only when `contact` is `full` (decision 047)
   * @param contact what the caller may see of accounts' addresses (identity's `customerContactOf`)
   * @returns the page (without payloads) and the exact total for the filter
   */
  async list(
    query: ParsedListQuery<NotificationSortField>,
    contact: CustomerContact,
  ): Promise<{ rows: WireNotification[]; total: number }> {
    const { rows, total } = await listLogRows(this.db.db, query, contact);
    return { rows: rows.map((row) => toWire(row, 'none')), total };
  }

  /**
   * Reads one notification.
   *
   * @param id the notification id
   * @param options `fullPayload`: the caller holds `notifications:*` (decision 054); otherwise every text and number of the payload
   *   reads `[hidden]`
   * @returns the entry with its payload
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number, options: { readonly fullPayload: boolean }): Promise<WireNotification> {
    const row = await findLogRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No notification with this id.' });
    return toWire(row, options.fullPayload ? 'full' : 'hidden');
  }
}

/** Masks each address of a comma list (an operations email names the addresses in its payload). */
const maskAddresses = (addresses: string): string =>
  addresses
    .split(',')
    .map((address) => maskEmail(address.trim()))
    .join(', ');

/** The masked recipient of a row: the address of an email, the chat of a Telegram message (an operations chat; older rows may name none). */
function recipientOf(row: LogRow): string {
  if (row.notification.channel === 'email') {
    // An alert's message has no recipient row: its addresses are in the payload. Decision 047: so does a row that names the address it
    // went to (the notice of an email change), which is not the recipient's current address.
    const payloadTo = (row.notification.payload as { to?: unknown }).to;
    return asString(payloadTo) ? maskAddresses(payloadTo) : maskEmail(row.email ?? '');
  }
  const payloadChat = (row.notification.payload as { chatId?: unknown }).chatId;
  return maskTelegram(asString(payloadChat) ? payloadChat : null);
}

/**
 * The payload as staff may see it: every Telegram chat id and every operations address list is masked, at any depth.
 *
 * Why: the recipient is masked (RULES settings 11), so a chat id in the payload (the alerts' messages carry the chat they were sent to, and
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

/**
 * A copy of a payload with every value hidden and its shape kept.
 *
 * Why: decision 054: a caller without `notifications:*` still sees which data a message was built from (its keys), never the values:
 * every string or number becomes `[hidden]`; booleans, `null`, keys, arrays and objects keep their shape.
 *
 * @param value a JSON value (after the recipient masks)
 * @returns the copy
 */
export function hiddenPayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(hiddenPayload);
  if (typeof value === 'string' || typeof value === 'number') return HIDDEN_VALUE;
  if (value === null || typeof value !== 'object') return value;
  const copy: JsonObject = {};
  for (const [key, inner] of Object.entries(value)) copy[key] = hiddenPayload(inner);
  return copy;
}

function payloadOf(payload: JsonObject, view: PayloadView): JsonObject | undefined {
  if (view === 'none') return undefined;
  const masked = publicPayload(payload);
  return view === 'full' ? masked : (hiddenPayload(masked) as JsonObject);
}

function toWire(row: LogRow, view: PayloadView): WireNotification {
  const n = row.notification;
  // jsonb holds JSON by definition, so the cast only tells the compiler what Postgres guarantees.
  const payload = payloadOf(n.payload as JsonObject, view);
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
    campaignId: n.campaignId,
    ...(payload === undefined ? {} : { payload }),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}
