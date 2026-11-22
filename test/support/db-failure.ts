// Builds the failure of a rejected statement the way Drizzle and pg raise it, with a marker where the bound value sits (decision 054).
import { DrizzleQueryError } from 'drizzle-orm/errors';

/** A value that must never appear in a log line, a report, a job record or a queue failure. */
export const DB_FAILURE_MARKER = 'marker-0e6c51f3a9';

/** What Postgres reports for a refused row: SQLSTATE and the identifiers, with the values quoted in the message and detail. */
export function pgRefusal(
  fields: { code?: string; table?: string | undefined; constraint?: string | undefined; where?: string } = {},
): Error {
  const error = new Error(`new row for relation "job_runs" violates check constraint "x" (${DB_FAILURE_MARKER})`);
  return Object.assign(error, {
    code: '23514',
    table: 'job_runs',
    constraint: 'job_runs_trigger_check',
    detail: `Failing row contains (${DB_FAILURE_MARKER})`,
    ...fields,
  });
}

/** The error Drizzle throws for a statement Postgres refused: the statement and every bound value in its message. */
export function drizzleFailure(cause: Error = pgRefusal()): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "job_runs" ("job", "trigger") values ($1, $2)',
    [DB_FAILURE_MARKER, 'bogus'],
    cause,
  );
}
