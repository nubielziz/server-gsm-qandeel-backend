// How an error is written to a log line (decision 054): a database failure is rebuilt from the original error as its SQLSTATE,
// names and a fixed sentence, never from pino's text of it; any other error is logged in full, as before.
import { stdSerializers } from 'pino';
import {
  STATEMENT_MARK,
  STATEMENT_REMOVED,
  databaseFailureOf,
  errorTypeOf,
  framesOnly,
  safeErrorText,
} from '../../common/errors/safe-error';

/** A JSON string value of a log line from "Failed query: " to its closing quote (escapes are kept in the match). */
const STATEMENT_IN_JSON = /Failed query: (?:[^"\\]|\\.)*/g;

const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

interface ErrorLike {
  readonly message: string;
  readonly stack?: unknown;
  readonly code?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

/** pino-http hands a configured `err` serializer the standard serializer's output, whose non-enumerable `raw` is the error. */
function rawOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as { raw?: unknown }).raw;
  } catch {
    return undefined;
  }
}

function holdsStatement(value: { message?: unknown; stack?: unknown }): boolean {
  return (
    (typeof value.message === 'string' && value.message.includes(STATEMENT_MARK)) ||
    (typeof value.stack === 'string' && value.stack.includes(STATEMENT_MARK))
  );
}

/**
 * Describes an error for a log line without its database statement.
 *
 * Why: decision 054: a failed statement's message is the SQL text followed by every bound value, and pino copies the
 * error's own properties (`query`, `params`) too; the log keeps the SQLSTATE, the names Postgres gave and a fixed sentence.
 *
 * @param error an error, or the standard serializer's form of one
 * @returns `{ type, message, stack, code?, database? }` for a database failure; the standard serialization of any other error
 * (every property, as before); the value itself when it is not error-like
 */
export function safeErrorObject(error: unknown): Record<string, unknown> {
  const type = errorTypeOf(error);
  const message = safeErrorText(error);
  const stack = typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined;
  const result: Record<string, unknown> = {
    type,
    message,
    stack: [`${type}: ${message}`, ...framesOnly(stack)].join('\n'),
  };
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && SAFE_CODE.test(code)) result.code = code;
  const failure = databaseFailureOf(error);
  if (failure !== undefined) {
    const database: Record<string, string> = {};
    if (failure.sqlState !== undefined) database.sqlState = failure.sqlState;
    if (failure.driverCode !== undefined) database.driverCode = failure.driverCode;
    if (failure.table !== undefined) database.table = failure.table;
    if (failure.constraint !== undefined) database.constraint = failure.constraint;
    if (failure.column !== undefined) database.column = failure.column;
    if (failure.functionName !== undefined) database.functionName = failure.functionName;
    result.database = database;
  }
  return result;
}

/**
 * The `err` serializer of every logger.
 *
 * Why: decision 054: the logger never writes a database statement or its values, however the error reaches it (`{ err }`, a
 * wrapped error, the standard serializer's output under pino-http).
 *
 * @param value what was logged under `err`
 * @returns the safe object of a database failure or of an error whose text holds a statement; the standard serialization of
 * any other error; the value unchanged when it is not error-like
 */
export function serializeLoggedError(value: unknown): unknown {
  const raw = rawOf(value);
  const original = isErrorLike(raw) ? raw : value;
  if (!isErrorLike(original)) return value;
  const wrapped = original !== value;
  const wrapperHoldsStatement = wrapped && isErrorLike(value) && holdsStatement(value);
  if (databaseFailureOf(original) === undefined && !holdsStatement(original) && !wrapperHoldsStatement) {
    return wrapped ? value : (stdSerializers.err as (error: unknown) => unknown)(original);
  }
  return safeErrorObject(original);
}

/**
 * Removes any database statement from a finished log line.
 *
 * Why: decision 054: pino copies an error's raw message into `msg` outside every serializer, and some code interpolates an
 * error's message into its own text; this is the last check, on the JSON line.
 *
 * @param line one finished JSON log line
 * @returns the line, with every string from `Failed query: ` to its closing quote replaced by a fixed marker (still valid JSON)
 */
export function withoutStatementTextInLine(line: string): string {
  return line.includes(STATEMENT_MARK) ? line.replace(STATEMENT_IN_JSON, STATEMENT_REMOVED) : line;
}
