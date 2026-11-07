// Shared zod schemas for the wire types of ALIGNMENT § 1 (Money, Decimal, IsoDateTime, Id, DateOnly, JsonObject).
// Each carries the JSON Schema extension `x-gsm-alias`, so the OpenAPI/contract tests know the shared type name.
import { z } from 'zod';
import { UploadedFile } from '../multipart';

/**
 * Largest id a JSON number carries exactly (2^53 - 1); ids are positive integers below it (decision 010).
 *
 * Why: decision 010: ids travel as JSON numbers, which are exact only up to 2^53 - 1.
 */
export const MAX_ID = Number.MAX_SAFE_INTEGER;

/**
 * Any JSON value, as the frontend's `JsonValue` type.
 *
 * Why: jsonb columns and free-form payloads travel as exactly this shape, so the frontend's type and ours match
 * (ALIGNMENT § 1).
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/**
 * A JSON object, as the frontend's `JsonObject` type.
 *
 * Why: settings, payloads and metadata are JSON objects, never arbitrary values (ALIGNMENT § 1).
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Money on the wire: a decimal string with exactly 4 fraction digits, e.g. `"12.4900"` (decision 011).
 * Why: the console and the ledger agree on text, never floats. Parse with `Money.fromWire` to calculate.
 */
export const zMoney = z
  .string()
  .regex(/^-?\d+\.\d{4}$/, 'Must be a decimal amount with exactly 4 decimals, like 12.4900.')
  .meta({
    'x-gsm-alias': 'Money',
    description: 'Decimal string with exactly 4 fraction digits.',
    examples: ['12.4900'],
  });

/**
 * Any other exact decimal sent as a string (rates, percents), e.g. `"19.0000"` or `"3.67250000"`.
 * Why: pricing, tax and FX fields keep their precision as text (decision 011).
 */
export const zDecimal = z
  .string()
  .max(40, 'Too long.')
  .regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal number written with digits only, like 19.5.')
  .meta({ 'x-gsm-alias': 'Decimal', description: 'Exact decimal number as a string.', examples: ['19.0000'] });

/**
 * A moment in time: ISO 8601 UTC with milliseconds and a `Z`, e.g. `"2026-03-01T09:30:00.000Z"`.
 * Why: one time format everywhere (ALIGNMENT § 1); a missing time is `null`, never `""`.
 */
export const zIsoDateTime = z.iso
  .datetime({ precision: 3, error: 'Must be an ISO 8601 UTC time with milliseconds, like 2026-03-01T09:30:00.000Z.' })
  .meta({
    'x-gsm-alias': 'IsoDateTime',
    description: 'ISO 8601 UTC time with milliseconds.',
    examples: ['2026-03-01T09:30:00.000Z'],
  });

/**
 * A database id as a JSON number: a positive integer up to 2^53 - 1 (decision 010).
 * Why: the frontend types every id as `number`.
 */
export const zId = z
  .number()
  .int('Must be a whole number.')
  .positive('Must be greater than zero.')
  .max(MAX_ID, 'Too large.')
  .meta({ 'x-gsm-alias': 'Id', description: 'Numeric record id.', examples: [42] });

/**
 * An id as it arrives in a path or query string (text), parsed to the same number as {@link zId}.
 * Why: `GET /admin/staff/:id` carries `"42"`; handlers receive `42`.
 */
export const zIdParam = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'Must be a numeric id.')
  .transform((text) => Number(text))
  .pipe(zId)
  .meta({ 'x-gsm-alias': 'Id', description: 'Numeric record id.', examples: ['42'] });

/**
 * A calendar day, `YYYY-MM-DD`, validated as a real date (UTC day; both ends of a range are inclusive).
 * Why: audit and report ranges take days (ALIGNMENT § 1).
 */
export const zDateOnly = z.iso
  .date({ error: 'Must be a date like 2026-03-01.' })
  .meta({ 'x-gsm-alias': 'DateOnly', description: 'Calendar day (UTC), YYYY-MM-DD.', examples: ['2026-03-01'] });

const MAX_JSON_DEPTH = 32;

function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A free-form JSON object (`jsonb` columns, request bodies the API does not model), at most 32 levels deep.
 * Why: the frontend's `JsonObject` type; anything that is not plain JSON is rejected before it reaches the database.
 */
export const zJsonObject = z
  .custom<JsonObject>((value) => isPlainObject(value) && isJsonValue(value, 0), 'Must be a JSON object.')
  .meta({
    'x-gsm-alias': 'JsonObject',
    type: 'object',
    additionalProperties: true,
    description: 'Free-form JSON object.',
  });

/**
 * A file part of a `multipart/form-data` body.
 * Why: B157: the upload routes (`POST /v1/files`, `POST /client/files`) read one part named `file`; the multipart parser
 * (`src/common/multipart.ts`) turns it into an {@link UploadedFile} before the contract validates the body. In OpenAPI it is a
 * binary string.
 */
export const zUploadedFile = z
  .custom<UploadedFile>((value) => value instanceof UploadedFile, 'Send the file as a multipart form part.')
  .meta({ type: 'string', format: 'binary', description: 'The file to upload (one multipart form part).' });
