// Request id (decision 012): keep a safe incoming X-Request-Id or make a UUIDv7, bind it to the async context.
// The same id reaches the response header, problem+json, every log line and (later) outbox rows and jobs.
import type { IncomingMessage } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from 'uuidv7';

/**
 * Header that carries the request id in both directions.
 *
 * Why: decision 012: the same header carries the id in and out.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Ids chosen per raw request, so Fastify, the logger and the error filter all see the same value. */
const chosen = new WeakMap<object, string>();

/**
 * Checks a caller-supplied request id.
 *
 * Why: the id is echoed in headers and logs, so only 1-64 characters of `[A-Za-z0-9._-]` are trusted.
 *
 * @param value the raw header value
 * @returns true when the value may be kept as the request id
 */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}

/**
 * Makes a fresh request id.
 *
 * Why: decision 012: a request without a usable id gets a time-ordered UUIDv7.
 *
 * @returns a UUIDv7 (time-ordered, so ids sort by arrival)
 */
export function generateRequestId(): string {
  return uuidv7();
}

/**
 * Decides the request id of a raw HTTP request and remembers it for that request.
 *
 * Why: Fastify's `genReqId` and any other component must agree on one id per request; a repeated or oversized
 * `X-Request-Id` (Node joins repeated headers with a comma) fails the safe pattern and gets a new UUIDv7.
 *
 * @param request the raw Node request
 * @returns the kept incoming id, or a new UUIDv7; the same value on every call for the same request
 */
export function resolveRequestId(request: IncomingMessage): string {
  const known = chosen.get(request);
  if (known) return known;
  const incoming = request.headers[REQUEST_ID_HEADER];
  const id = isSafeRequestId(incoming) ? incoming : generateRequestId();
  chosen.set(request, id);
  return id;
}

interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with `requestId` as the current request id for everything it starts (awaits, timers, callbacks).
 *
 * Why: services, the logger and later the outbox writer and job producers read the id without passing it around.
 *
 * @param requestId the id to bind
 * @param fn the work to run
 * @returns what `fn` returns
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * Returns the id of the request being handled.
 *
 * Why: outbox payloads and BullMQ job data carry the id so one investigation joins API, worker and supplier logs
 * (decision 012).
 *
 * @returns the current request id, or `undefined` outside a request (boot, scheduled work without a parent)
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
