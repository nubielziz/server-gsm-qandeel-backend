// The one error type application code throws (decision 028): a catalog code plus occurrence details.
// The global exception filter turns it into problem+json; codes come from catalog.ts (docs/contract/error-codes.md).
import { ERROR_CATALOG, type ErrorCode } from './catalog';

/**
 * One invalid field in a problem+json `errors[]` list; `field` is a dotted camelCase path such as `items.0.imei`.
 *
 * Why: the console maps `errors[].field` onto form fields (ALIGNMENT § 5), so the path must equal the request key.
 */
export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Optional details of one occurrence of an error.
 *
 * Why: an occurrence adds what went wrong this time (detail, field errors, cause) to the fixed catalog entry (decision
 * 028).
 */
export interface AppErrorOptions {
  /** A human sentence for this occurrence (shown to staff verbatim; plain English, never HTML). */
  readonly detail?: string;
  /** Field-level problems, mapped by the console onto form fields. */
  readonly errors?: readonly FieldError[];
  /** The underlying error; logged with the failure, never sent to the client. */
  readonly cause?: unknown;
  /** Seconds to wait before retrying; sent as `Retry-After` (a 429 always carries one). */
  readonly retryAfterSeconds?: number;
}

/**
 * A business or protocol failure with a catalog code.
 *
 * Why: decision 028 wants one error type everywhere, so the console can react to `code`, show `title` and `detail`
 * and put `errors[]` on its form fields without special cases per route.
 *
 * @example
 * throw new AppError('EMAIL_TAKEN', { detail: 'rami@gsm.example already belongs to another staff member.' });
 */
export class AppError extends Error {
  /** HTTP status from the catalog. */
  readonly status: number;
  /** Fixed English title from the catalog. */
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[];
  readonly retryAfterSeconds: number | undefined;

  /**
   * @param code a catalog code
   * @param options details of this occurrence
   */
  constructor(
    readonly code: ErrorCode,
    options: AppErrorOptions = {},
  ) {
    super(
      options.detail ?? ERROR_CATALOG[code].title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.status = ERROR_CATALOG[code].status;
    this.title = ERROR_CATALOG[code].title;
    this.detail = options.detail;
    this.errors = options.errors ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
