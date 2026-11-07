// The Dhru Fusion v6.1 wire format that is not specific to one action (decision 026): the envelope of a success, the headers, how the
// base64 JSON `parameters` and `customfield` fields are read, and the status numbers of an order. Pure; no I/O.
import { AppError } from '../errors';
import { DHRU_API_VERSION } from '../errors/dhru-formatter';

/**
 * The headers of every answer on the Dhru surface.
 *
 * Why: decision 026: client software looks for them; the error formatter sends the same two.
 */
export const DHRU_HEADERS: Readonly<Record<string, string>> = {
  'x-powered-by': 'DHRU-FUSION',
  'dhru-fusion-api-version': DHRU_API_VERSION,
};

/** What one entry of a bulk answer holds: a success list or an error list. */
export type DhruItemAnswer =
  { readonly SUCCESS: readonly unknown[] } | { readonly ERROR: ReadonlyArray<{ readonly MESSAGE: string }> };

/**
 * Wraps the entry of a successful action.
 *
 * @param entry the action's success entry (`{ MESSAGE, REFERENCEID }`, ...)
 * @returns the body `{ SUCCESS: [entry], apiversion: '6.1' }`
 */
export function dhruSuccess(entry: unknown): { SUCCESS: unknown[]; apiversion: string } {
  return { SUCCESS: [entry], apiversion: DHRU_API_VERSION };
}

/**
 * Builds the answer of a bulk action.
 *
 * Why: decision 026: `{ "<reqId>": { "SUCCESS"|"ERROR": [ ... ] }, ..., "apiversion": "6.1" }`, one key per request id the caller sent.
 *
 * @param items the answer of each item, by the caller's request id
 * @returns the body
 */
export function dhruBulk(items: ReadonlyMap<string, DhruItemAnswer>): Record<string, unknown> {
  return { ...Object.fromEntries(items), apiversion: DHRU_API_VERSION };
}

/**
 * Turns an error message into the error entry of an answer.
 *
 * @param message the text the client shows
 * @returns `{ ERROR: [{ MESSAGE }] }`
 */
export function dhruError(message: string): { ERROR: Array<{ MESSAGE: string }> } {
  return { ERROR: [{ MESSAGE: message }] };
}

const BAD_PARAMETERS = 'Invalid parameters';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a base64 text that holds a JSON object.
 *
 * Why: decision 026: `parameters` and `customfield` are base64 of a JSON object. A form body that lost the `+` of a base64 text (the
 * client did not escape it) arrives with spaces; they are put back. URL-safe base64 is accepted too.
 *
 * @param text the field as sent
 * @returns the JSON object
 * @throws {AppError} `VALIDATION_FAILED` ("Invalid parameters") when the text is not base64 of a JSON object
 */
export function decodeBase64Object(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  if (clean === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw new AppError('VALIDATION_FAILED', { detail: BAD_PARAMETERS });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(clean, 'base64').toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: BAD_PARAMETERS });
  }
  if (!isObject(value)) throw new AppError('VALIDATION_FAILED', { detail: BAD_PARAMETERS });
  return value;
}

/**
 * Reads the `parameters` field of a request.
 *
 * @param raw the field: the base64 text of the standard, an object (a JSON caller), or nothing
 * @returns the parameters; `{}` when none were sent
 * @throws {AppError} `VALIDATION_FAILED` ("Invalid parameters") when the field cannot be read as an object
 */
export function readParameters(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') return decodeBase64Object(raw);
  if (isObject(raw)) return raw;
  throw new AppError('VALIDATION_FAILED', { detail: BAD_PARAMETERS });
}

/**
 * Reads the `CUSTOMFIELD` parameter: the values of a service's custom fields by field key.
 *
 * Why: decision 026: it is again base64 JSON inside `parameters`; an object is accepted as it is. Numbers and booleans become text
 * (the order stores text); `null` and empty values are left out; a nested value is not a field value.
 *
 * @param raw the parameter
 * @returns the values by key, as text
 * @throws {AppError} `VALIDATION_FAILED` ("Invalid custom fields") when the value is not an object of simple values
 */
export function readCustomFields(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null || raw === '') return {};
  const fields = typeof raw === 'string' ? decodeBase64Object(raw) : raw;
  if (!isObject(fields)) throw new AppError('VALIDATION_FAILED', { detail: 'Invalid custom fields' });
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === '') continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else throw new AppError('VALIDATION_FAILED', { detail: `Invalid custom field ${key}` });
  }
  return out;
}

/**
 * The `STATUS` number of an order.
 *
 * Why: decision 025 and 026: 0 new, 1 in process, 4 completed, 3 rejected (refunded).
 *
 * @param status the order status
 * @returns the number a Dhru client reads
 */
export function dhruStatusOf(status: 'pending' | 'processing' | 'completed' | 'rejected'): 0 | 1 | 3 | 4 {
  switch (status) {
    case 'pending':
      return 0;
    case 'processing':
      return 1;
    case 'rejected':
      return 3;
    case 'completed':
      return 4;
  }
}
