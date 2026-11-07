// Reads the Postgres error behind a Drizzle/pg failure: use cases turn a unique or foreign-key violation (a race that the
// pre-check could not see) into the catalog error the console expects, instead of a 500.

/** The parts of a Postgres error that use cases decide on. */
export interface PgErrorInfo {
  /** The SQLSTATE, for example `23505` (unique violation) or `23503` (foreign key violation). */
  readonly code: string;
  /** The violated constraint or index name, when Postgres names one. */
  readonly constraint: string | undefined;
}

const MAX_CAUSE_DEPTH = 4;

/**
 * Finds the Postgres error inside an error (Drizzle wraps the driver error as the `cause`).
 *
 * Why: the unique indexes are the final word on "email already in use" and "name already used"; a parallel request passes the
 * pre-check, so the use case must recognise the violation when the insert fails.
 *
 * @param error anything that was thrown
 * @returns the SQLSTATE and constraint name, or `undefined` when the error did not come from Postgres
 */
export function pgErrorInfo(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const candidate = current as Error & { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Tells whether an error is a unique violation, optionally of one named index.
 *
 * @param error anything that was thrown
 * @param constraint the index or constraint name to match; any unique violation when omitted
 * @returns true for SQLSTATE `23505` (of that constraint)
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error);
  return info?.code === '23505' && (constraint === undefined || info.constraint === constraint);
}

/**
 * Tells whether an error is a foreign key violation, optionally of one named constraint.
 *
 * @param error anything that was thrown
 * @param constraint the constraint name to match; any foreign key violation when omitted
 * @returns true for SQLSTATE `23503` (of that constraint)
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error);
  return info?.code === '23503' && (constraint === undefined || info.constraint === constraint);
}
