// Turns "Postgres cannot be reached" into `503 DATABASE_UNAVAILABLE` for the routes that need live rows (resolution
// health-commissions-17). The pool's connection errors carry no useful text for the console and must never leak hostnames.
import { AppError } from '../../../common/errors';

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
const SERVER_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '53300']);
const MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection ended unexpectedly/i,
];

/**
 * Whether an error means the database is not reachable (a refused or lost connection, a server shutting down, no free slot).
 *
 * @param error anything thrown by a query, with its `cause` chain
 * @returns true for a connection-level failure, false for a query error
 */
export function isDatabaseDown(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && (CONNECTION_CODES.has(code) || SERVER_CODES.has(code))) return true;
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string' && MESSAGES.some((pattern) => pattern.test(message))) return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Runs database work and answers `503 DATABASE_UNAVAILABLE` when the database cannot be reached.
 *
 * @param work the reads
 * @returns what `work` returned
 * @throws {AppError} `DATABASE_UNAVAILABLE` for a connection-level failure; any other error as it is
 */
export async function orUnavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError || !isDatabaseDown(error)) throw error;
    throw new AppError('DATABASE_UNAVAILABLE', { detail: 'The database is not answering right now.', cause: error });
  }
}
