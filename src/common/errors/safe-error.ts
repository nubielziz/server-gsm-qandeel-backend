// One description of a failure that is safe for logs, error reports, job records and queue failures (decision 054): a
// database failure is its SQLSTATE, the names Postgres gives and a fixed sentence; any other error keeps its message without statement text.
import { DrizzleQueryError } from 'drizzle-orm/errors';

/** Where Drizzle's message of a failed statement starts; everything after it is the statement and its bound values. */
export const STATEMENT_MARK = 'Failed query: ';
/** What replaces a removed statement. */
export const STATEMENT_REMOVED = '[database statement removed]';

/** What a database failure is reduced to; every name is an identifier of the schema, never data. */
export interface DatabaseFailure {
  readonly sqlState: string | undefined;
  /** A Node system code (ECONNREFUSED) of a failure that has no SQLSTATE. */
  readonly driverCode: string | undefined;
  readonly table: string | undefined;
  readonly constraint: string | undefined;
  readonly column: string | undefined;
  /** The PL/pgSQL function (a trigger) that raised it, read from the error's context. */
  readonly functionName: string | undefined;
  /** True when the error itself is the database failure; false when it wraps one as its cause. */
  readonly direct: boolean;
}

// Node's system codes all start with E; no SQLSTATE class does.
const SQLSTATE = /^(?!E)[0-9A-Z]{5}$/;
const DRIVER_CODE = /^E[A-Z0-9_]{2,30}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const PLPGSQL_FUNCTION = /PL\/pgSQL function ([A-Za-z_][A-Za-z0-9_$.]{0,126})\(/;
const MAX_CAUSES = 6;
const FRAME = /^\s+at .*:\d+:\d+\)?$/;
const MAX_FRAMES = 20;
const DEFAULT_MAX_LENGTH = 1000;

/** The fixed sentence of each SQLSTATE the system knows by its full code. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  '23505': 'a unique index refused the row',
  '23503': 'a foreign key refused the row',
  '23502': 'a required column was empty',
  '23514': 'a check constraint refused the row',
  '23P01': 'an exclusion constraint refused the row',
  '22001': 'a text was longer than its column allows',
  '22003': 'a number was outside the range of its column',
  '22P02': 'a value was not in the form its column needs',
  '22021': 'a text held a character the database does not accept',
  '22007': 'a date or time was not valid',
  '22008': 'a date or time was not valid',
  '40001': 'the transaction could not be serialized',
  '40P01': 'a deadlock was detected',
  '55P03': 'a lock was not granted in time',
  '57014': 'the statement was cancelled (a timeout)',
  '25P02': 'the transaction had already failed',
  '42501': 'the database role lacks a privilege',
  '42P01': 'a table does not exist',
  '42703': 'a column does not exist',
  P0001: 'a database rule refused the change',
};

/** The fixed sentence of each SQLSTATE class (its first two characters) when the full code has none. */
const CLASS_SENTENCES: Readonly<Record<string, string>> = {
  '08': 'the database connection failed',
  '22': 'a value was not valid for its column',
  '23': 'an integrity rule refused the row',
  '25': 'the transaction was in the wrong state',
  '40': 'the transaction was rolled back',
  '42': 'the statement does not match the schema or lacks a privilege',
  '53': 'the database ran out of a resource',
  '55': 'an object was not in the state the statement needs',
  '57': 'the database stopped the statement',
  '58': 'the database had a system error',
  P0: 'a database function raised an error',
  XX: 'the database had an internal error',
};

const OTHER_SENTENCE = 'the database refused the statement';
const NO_SQLSTATE_SENTENCE = 'the statement did not complete';

type Node = Record<string, unknown>;

function read(node: Node, key: string): unknown {
  try {
    return node[key];
  } catch {
    // A getter that throws is treated as an absent field: the sanitiser must never throw.
    return undefined;
  }
}

function isDatabaseNode(node: Node): boolean {
  if (node instanceof DrizzleQueryError) return true;
  const constructorName = constructorNameOf(node);
  if (constructorName === 'DrizzleQueryError') return true;
  const message = read(node, 'message');
  if (typeof message === 'string' && message.startsWith(STATEMENT_MARK)) return true;
  const code = read(node, 'code');
  return typeof code === 'string' && SQLSTATE.test(code);
}

function constructorNameOf(node: Node): string | undefined {
  try {
    const constructor = (node as { constructor?: { name?: unknown } }).constructor;
    return typeof constructor?.name === 'string' ? constructor.name : undefined;
  } catch {
    return undefined;
  }
}

function identifier(node: Node, key: string): string | undefined {
  const value = read(node, key);
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

/**
 * Cuts a database statement out of a text.
 *
 * Why: decision 054: Drizzle's message of a failed statement is the statement followed by every bound value; no log, report or
 * job record may carry it, also when a caller wrapped that message in its own text.
 *
 * @param text any text
 * @returns the text before the statement followed by a fixed marker, or the text unchanged when it holds no statement
 */
export function withoutStatementText(text: string): string {
  const index = text.indexOf(STATEMENT_MARK);
  return index < 0 ? text : `${text.slice(0, index)}${STATEMENT_REMOVED}`;
}

/**
 * Finds the database failure inside an error and reads only the identifiers Postgres names.
 *
 * Why: decision 054: a failed statement is described by its SQLSTATE, table, constraint, column and trigger function; the
 * message, detail, hint, statement and values are never read (they quote data).
 *
 * @param error anything that was thrown
 * @returns the reduced failure, or `undefined` when neither the error nor its causes (at most six) came from the database
 */
export function databaseFailureOf(error: unknown): DatabaseFailure | undefined {
  const nodes: Node[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (nodes.length < MAX_CAUSES && typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    nodes.push(current as Node);
    current = read(current as Node, 'cause');
  }
  const firstDatabase = nodes.findIndex(isDatabaseNode);
  if (firstDatabase < 0) return undefined;
  const direct = firstDatabase === 0;
  const withState = nodes.find((node) => {
    const code = read(node, 'code');
    return typeof code === 'string' && SQLSTATE.test(code);
  });
  if (withState !== undefined) {
    const where = read(withState, 'where');
    const functionMatch = typeof where === 'string' ? PLPGSQL_FUNCTION.exec(where) : null;
    return {
      sqlState: read(withState, 'code') as string,
      driverCode: undefined,
      table: identifier(withState, 'table'),
      constraint: identifier(withState, 'constraint'),
      column: identifier(withState, 'column'),
      functionName: functionMatch?.[1],
      direct,
    };
  }
  const withDriverCode = nodes.slice(firstDatabase).find((node) => {
    const code = read(node, 'code');
    return typeof code === 'string' && DRIVER_CODE.test(code);
  });
  return {
    sqlState: undefined,
    driverCode: withDriverCode === undefined ? undefined : (read(withDriverCode, 'code') as string),
    table: undefined,
    constraint: undefined,
    column: undefined,
    functionName: undefined,
    direct,
  };
}

function sentenceOf(failure: DatabaseFailure): string {
  const code = failure.sqlState;
  if (code === undefined) return NO_SQLSTATE_SENTENCE;
  return CODE_SENTENCES[code] ?? CLASS_SENTENCES[code.slice(0, 2)] ?? OTHER_SENTENCE;
}

/**
 * Writes a database failure as one fixed sentence with the names Postgres gave.
 *
 * Why: decision 054: the same text goes to logs, job records, queue failures, run texts and error reports, so a developer finds
 * the table and rule that refused a statement and never sees what was in it.
 *
 * @param failure the reduced failure
 * @returns for example `Database error 23514: a check constraint refused the row (table job_runs, constraint job_runs_trigger_check).`
 */
export function databaseFailureText(failure: DatabaseFailure): string {
  const code = failure.sqlState ?? failure.driverCode;
  const names: string[] = [];
  if (failure.table !== undefined) names.push(`table ${failure.table}`);
  if (failure.constraint !== undefined) names.push(`constraint ${failure.constraint}`);
  if (failure.column !== undefined) names.push(`column ${failure.column}`);
  if (failure.functionName !== undefined) names.push(`function ${failure.functionName}`);
  const suffix = names.length === 0 ? '' : ` (${names.join(', ')})`;
  return `Database error${code === undefined ? '' : ` ${code}`}: ${sentenceOf(failure)}${suffix}.`;
}

/**
 * The name of an error's type.
 *
 * Why: Drizzle's failure keeps the name `Error` and the driver's the name `error`; their constructor names are the useful ones.
 *
 * @param error anything that was thrown
 * @returns the constructor's name unless it is `Error` or `Object`, else the error's `name`, else `Error`
 */
export function errorTypeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const constructorName = constructorNameOf(error as Node);
    if (
      constructorName !== undefined &&
      constructorName !== '' &&
      constructorName !== 'Error' &&
      constructorName !== 'Object'
    ) {
      return constructorName;
    }
    const name = read(error as Node, 'name');
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'Error';
}

function messageOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = read(error as Node, 'message');
  return typeof message === 'string' ? message : undefined;
}

function cut(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

/**
 * The text of an error that is safe to write anywhere.
 *
 * Why: decision 054: a database failure reads as its SQLSTATE and names; any other error keeps its message with an embedded
 * statement cut out, so the existing behaviour "the full message is logged" holds for everything that is not a database failure.
 *
 * @param error anything that was thrown
 * @param maxLength the longest result (longer text ends in `...`)
 * @returns the safe text
 */
export function safeErrorText(error: unknown, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (typeof error === 'string') return cut(withoutStatementText(error), maxLength);
  if (error === null || error === undefined) return 'unknown error';
  const message = messageOf(error);
  if (message === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a thrown non-error is described by its own text, whatever it is
      return cut(withoutStatementText(String(error)), maxLength);
    } catch {
      return 'unknown error';
    }
  }
  const failure = databaseFailureOf(error);
  if (failure === undefined) return cut(withoutStatementText(message), maxLength);
  if (failure.direct) return cut(databaseFailureText(failure), maxLength);
  const head = withoutStatementText(message).trim();
  const text = databaseFailureText(failure);
  return cut(head === '' ? text : `${head}: ${text}`, maxLength);
}

/**
 * The stack frames of a stack text, without the message lines that precede them.
 *
 * Why: the first lines of a stack repeat the error's message, which for a database failure is the statement and its values.
 *
 * @param stack an error's `stack`
 * @returns at most twenty lines of the form `at … file:line:column`
 */
export function framesOnly(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    if (FRAME.test(line)) {
      frames.push(line);
      if (frames.length >= MAX_FRAMES) break;
    }
  }
  return frames;
}

/**
 * Replaces an error that carries a database statement by a safe copy of it.
 *
 * Why: decision 054: the worker, the error reporter and every other sink that stores an error object by its message and stack
 * receive this copy, so a failed job's reason, its stack and its report never carry a statement or its values.
 *
 * @param error anything that was thrown
 * @returns the same value when it is not an error or holds no database statement; otherwise a new `Error` named after the
 * original type, with the safe text as message, the original frames as stack and no cause or other property
 */
export function sanitizeError(error: unknown): unknown {
  const message = messageOf(error);
  if (message === undefined) return error;
  const stack = read(error as Node, 'stack');
  const holdsStatement =
    databaseFailureOf(error) !== undefined ||
    message.includes(STATEMENT_MARK) ||
    (typeof stack === 'string' && stack.includes(STATEMENT_MARK));
  if (!holdsStatement) return error;
  const safeMessage = safeErrorText(error);
  const name = errorTypeOf(error);
  const copy = new Error(safeMessage);
  copy.name = name;
  copy.stack = [`${name}: ${safeMessage}`, ...framesOnly(stack)].join('\n');
  return copy;
}
