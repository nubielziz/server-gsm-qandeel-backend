// Validation and packing of outbox events (platform module, decision 020): what may be written, how the request id is
// stored with the payload, and how a stored row becomes the data of a BullMQ job.
import { isSafeRequestId } from '../../../common/request-id';
import type { OutboxEvent } from '../db/schema';
import type { OutboxEventInput, OutboxJobData, OutboxPayload } from './outbox.types';

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const AGGREGATE_TYPE = /^[a-z][a-z0-9_]*$/;
const PAYLOAD_KEY = /^[a-z][A-Za-z0-9]*$/;
/** The key under which the stored payload keeps bookkeeping next to the caller's ids. */
export const OUTBOX_META_KEY = 'meta';
const MAX_KEYS = 20;
const MAX_STRING = 64;
const MAX_LIST = 50;
const MAX_JSON_BYTES = 2_048;

/**
 * Checks an outbox event before it is written.
 *
 * Why: the outbox row becomes a BullMQ job in Redis and a line in logs, so it must carry ids only. The guard cannot know
 * what a string means, but it refuses what ids never need: decimals (so no money), free text (strings over 64
 * characters), nested objects and big payloads. The names of the consumer's inputs are the aggregate and its ids; the
 * consumer re-reads everything else from Postgres.
 *
 * @param event the event a use case wants to write
 * @throws {RangeError} naming the first problem found; this is a programming error, so the use case's transaction rolls back
 */
export function assertOutboxEvent(event: OutboxEventInput): void {
  if (event.type.length > 100 || !EVENT_TYPE.test(event.type)) {
    throw new RangeError(`Outbox event type "${event.type}" must be dotted lower case, like order.status_changed.`);
  }
  if (event.aggregateType.length > 64 || !AGGREGATE_TYPE.test(event.aggregateType)) {
    throw new RangeError(
      `Outbox aggregate type "${event.aggregateType}" must be lower case with underscores, like orders.`,
    );
  }
  if (!Number.isSafeInteger(event.aggregateId) || event.aggregateId <= 0) {
    throw new RangeError(`Outbox aggregate id must be a positive whole number, got ${String(event.aggregateId)}.`);
  }
  if (event.payload !== undefined) assertOutboxPayload(event.payload);
}

/**
 * Checks the payload of an outbox event.
 *
 * @param payload the payload to check
 * @throws {RangeError} when it is not a flat object of ids, codes, flags and short lists
 */
export function assertOutboxPayload(payload: OutboxPayload): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RangeError('An outbox payload must be a flat object.');
  }
  const entries = Object.entries(payload);
  if (entries.length > MAX_KEYS) throw new RangeError(`An outbox payload may have at most ${MAX_KEYS} keys.`);
  for (const [key, value] of entries) {
    if (key === OUTBOX_META_KEY) throw new RangeError(`"${OUTBOX_META_KEY}" is reserved in an outbox payload.`);
    if (!PAYLOAD_KEY.test(key)) throw new RangeError(`Outbox payload key "${key}" must be camelCase.`);
    if (Array.isArray(value)) {
      if (value.length > MAX_LIST)
        throw new RangeError(`Outbox payload "${key}" may have at most ${MAX_LIST} elements.`);
      for (const element of value as ReadonlyArray<unknown>) assertScalar(key, element, false);
    } else {
      assertScalar(key, value, true);
    }
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_JSON_BYTES) {
    throw new RangeError(`An outbox payload may be at most ${MAX_JSON_BYTES} bytes.`);
  }
}

function assertScalar(key: string, value: unknown, allowFlags: boolean): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new RangeError(`Outbox payload "${key}" must be a whole number (ids only, no money).`);
  } else if (typeof value === 'string') {
    if (value.length > MAX_STRING)
      throw new RangeError(`Outbox payload "${key}" is longer than ${MAX_STRING} characters: ids and codes only.`);
  } else if (!(allowFlags && (typeof value === 'boolean' || value === null))) {
    throw new RangeError(`Outbox payload "${key}" must be an id, a code, a flag or a list of ids.`);
  }
}

/**
 * Builds the JSON stored in `outbox_events.payload`: the caller's ids plus `meta.requestId`.
 *
 * Why: decision 012 carries the request id from the request through the outbox to the worker, so one id joins the logs.
 *
 * @param payload the caller's payload (already checked)
 * @param requestId the current request id, if any
 * @returns the object to store
 */
export function packOutboxPayload(
  payload: OutboxPayload | undefined,
  requestId: string | undefined,
): Record<string, unknown> {
  return { ...payload, [OUTBOX_META_KEY]: requestId === undefined ? {} : { requestId } };
}

/**
 * Turns a stored row into the data of its BullMQ job.
 *
 * @param row the `outbox_events` row
 * @returns the job data; `requestId` is the stored request id when it is safe, else `outbox-<id>`
 */
export function jobDataOf(
  row: Pick<OutboxEvent, 'id' | 'type' | 'aggregateType' | 'aggregateId' | 'payload'>,
): OutboxJobData {
  const { [OUTBOX_META_KEY]: meta, ...rest } = row.payload;
  const stored = typeof meta === 'object' && meta !== null ? (meta as { requestId?: unknown }).requestId : undefined;
  return {
    eventId: row.id,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: rest as OutboxPayload,
    requestId: isSafeRequestId(stored) ? stored : `outbox-${row.id}`,
  };
}
