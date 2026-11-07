// The error envelope of the Dhru Fusion surface POST /api/index.php (decision 026): always HTTP 200 with
// { ERROR: [{ MESSAGE }], apiversion }, never problem+json. Registered in the formatter seam by ErrorsModule.
import type { AppError } from './app-error';
import type { ErrorCode } from './catalog';
import type { ErrorFormatContext, ErrorFormatter, ErrorResponse } from './formatter-registry';

/**
 * The Dhru API version this server speaks.
 *
 * Why: decision 026 (v6.1): the version is part of every body and of the `dhru-fusion-api-version` header.
 */
export const DHRU_API_VERSION = '6.1';

/**
 * Messages Dhru clients know by heart, per catalog code, used when the occurrence has no detail of its own.
 *
 * Why: decision 026 uses the standard messages where one exists (`Authentication Failed`, `Not enough credits`) because
 * merchants' Dhru software shows them to their own customers; every other error uses the detail of the occurrence.
 */
const STANDARD_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  UNAUTHORIZED: 'Authentication Failed',
  INSUFFICIENT_FUNDS: 'Not enough credits',
};

/**
 * Messages that replace the detail of the occurrence on the Dhru surface.
 *
 * Why: user rule 9 words the refusal of a changed price for Dhru exactly (a merchant's software matches on it to reload the service
 * list), and `Not enough credits` is the standard text whatever balance the ledger's own detail names. REST v1 keeps the details.
 */
const FIXED_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  PRICE_CHANGED: 'Price changed. Please refresh the service list and order again.',
  INSUFFICIENT_FUNDS: 'Not enough credits',
};

/**
 * The text a Dhru client shows for an error.
 *
 * @param error the application error
 * @returns the fixed Dhru message of the code (a changed price, not enough credits), else the occurrence's detail, else the
 *   standard Dhru message of the code, else the catalog title
 */
export function dhruMessageOf(error: AppError): string {
  return FIXED_MESSAGES[error.code] ?? error.detail ?? STANDARD_MESSAGES[error.code] ?? error.title;
}

/**
 * Answers every error of the Dhru surface in the Dhru envelope.
 *
 * Why: decision 026 isolates the Dhru surface behind one envelope adapter, and the guard dispatcher needs the envelope
 * today: a request that fails authentication on `/api/index.php` must say `Authentication Failed` the way Dhru client
 * software expects, with HTTP 200. The Dhru feature (stage 7) extends the messages; the shape stays here.
 *
 * Side effects: none; the exception filter still counts the error in `api_errors_total` under its catalog code.
 */
export class DhruErrorFormatter implements ErrorFormatter {
  readonly name = 'dhru';

  /**
   * Tells whether the request is on the Dhru surface.
   *
   * @param request the request path and surface
   * @returns true for `/api/index.php`
   */
  matches(request: { readonly surface: string }): boolean {
    return request.surface === 'dhru';
  }

  /**
   * Builds the Dhru error answer.
   *
   * @param context the error and the request
   * @returns HTTP 200 with the Dhru headers and `{ ERROR: [{ MESSAGE }], apiversion: '6.1' }`
   */
  format(context: ErrorFormatContext): ErrorResponse {
    return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: { 'x-powered-by': 'DHRU-FUSION', 'dhru-fusion-api-version': DHRU_API_VERSION },
      body: { ERROR: [{ MESSAGE: dhruMessageOf(context.error) }], apiversion: DHRU_API_VERSION },
    };
  }
}
