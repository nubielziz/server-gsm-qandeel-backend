// Error catalog (decision 028): every code the backend may emit, with its HTTP status and a fixed English title.
// Mirrors docs/contract/error-codes.md (a unit test keeps both lists equal); routes, mocks and docs use these names.

/**
 * One catalog entry: the HTTP status of the code and the fixed, user-facing title of its problem+json body.
 *
 * Why: the console reacts to the code and shows the title, so each code has one fixed status and wording (decision
 * 028).
 */
export interface ErrorCatalogEntry {
  readonly status: number;
  readonly title: string;
}

/**
 * Every error code with its status and title.
 *
 * Why: the console reacts to `code` and shows `title` verbatim (plain English, one short sentence, no jargon), so
 * the pair is fixed here once and reviewed like an API. `detail` carries the occurrence-specific sentence.
 *
 * @see docs/contract/error-codes.md
 */
export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, title: 'The request could not be understood.' },
  WEBHOOK_SIGNATURE_INVALID: { status: 400, title: 'The webhook signature is not valid.' },
  UNAUTHORIZED: { status: 401, title: 'Authentication failed.' },
  INSUFFICIENT_FUNDS: { status: 402, title: 'The wallet balance is too low for this order.' },
  PAYMENT_DECLINED: { status: 402, title: 'The payment was declined.' },
  ACCOUNT_SUSPENDED: { status: 403, title: 'This account is suspended.' },
  CSRF_FAILED: { status: 403, title: 'The security check for this request failed.' },
  FORBIDDEN: { status: 403, title: 'You do not have permission to do this.' },
  IP_NOT_ALLOWED: { status: 403, title: 'Access from this network address is not allowed.' },
  TURNSTILE_FAILED: { status: 403, title: 'The anti-bot check failed.' },
  NOT_FOUND: { status: 404, title: 'The requested item was not found.' },
  ACCOUNT_EXISTS: { status: 409, title: 'This customer already has an account.' },
  ALERT_ACKNOWLEDGED: { status: 409, title: 'This alert is already acknowledged.' },
  ALERT_RESOLVED: { status: 409, title: 'This alert is already resolved.' },
  ALREADY_ASSIGNED: { status: 409, title: 'This plan is already assigned to this agent.' },
  ALREADY_BLOCKED: { status: 409, title: 'This value is already blocked.' },
  ALREADY_CURRENT: { status: 409, title: 'This version is already the current one.' },
  ALREADY_DECIDED: { status: 409, title: 'A decision was already made on this request.' },
  ALREADY_REVOKED: { status: 409, title: 'This key is already revoked.' },
  ALREADY_SENT: { status: 409, title: 'This order was already sent to a supplier.' },
  ALREADY_SUSPENDED: { status: 409, title: 'This account is already suspended.' },
  ANONYMIZED: { status: 409, title: 'This customer is anonymized and cannot be changed.' },
  APPROVAL_REQUIRED: { status: 409, title: 'This adjustment needs a second approval.' },
  CANNOT_CHANGE_OWN_ROLE: { status: 409, title: 'You cannot change your own role.' },
  CANNOT_SUSPEND_SELF: { status: 409, title: 'You cannot suspend your own account.' },
  CATALOG_LOCKED: { status: 409, title: 'The catalog is locked and cannot be changed.' },
  CATEGORY_IN_USE: { status: 409, title: 'This category still has services.' },
  CODE_TAKEN: { status: 409, title: 'This code is already used by another service.' },
  CONFLICT: { status: 409, title: 'The request conflicts with the current state.' },
  CREDIT_LIMIT_EXCEEDED: { status: 409, title: 'This debit is over the credit limit.' },
  DEFAULT_GROUP_REQUIRED: { status: 409, title: 'There must always be one default group.' },
  DELIVERY_SUCCEEDED: { status: 409, title: 'This webhook was already delivered.' },
  DISPUTE_NOT_OPEN: { status: 409, title: 'This dispute is no longer open for evidence.' },
  DUPLICATE_ORDER: { status: 409, title: 'An identical order is already open.' },
  EMAIL_TAKEN: { status: 409, title: 'This email address is already in use.' },
  ERASURE_NOT_DONE: { status: 409, title: 'The customer must be anonymized first.' },
  EVIDENCE_DEADLINE_PASSED: { status: 409, title: 'The deadline for evidence has passed.' },
  GATEWAY_IN_USE: { status: 409, title: 'This payment gateway is still in use.' },
  GROUP_IN_USE: { status: 409, title: 'This group still has merchants.' },
  HAS_PENDING: { status: 409, title: 'This assignment still has pending commissions.' },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, title: 'A request with this key is still being processed.' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: 'This idempotency key was already used with a different request.' },
  IN_USE: { status: 409, title: 'This item is still in use.' },
  INCIDENT_CLOSED: { status: 409, title: 'This incident is already resolved.' },
  INVALID_TRANSITION: { status: 409, title: 'This status change is not allowed.' },
  IP_NOT_IN_ALLOWLIST: { status: 409, title: 'Your current address is not on the allowlist.' },
  JOB_ALREADY_RUNNING: { status: 409, title: 'This job is already running.' },
  KEY_IN_USE: { status: 409, title: 'This key is still in use.' },
  KYC_REQUIRED: { status: 409, title: 'Identity verification must be approved first.' },
  LAST_ACTIVE: { status: 409, title: 'The last active item cannot be changed this way.' },
  LAST_CURRENCY: { status: 409, title: 'At least one currency must stay available.' },
  LAST_OWNER: { status: 409, title: 'There must always be one active owner.' },
  LAST_SUPPLIER: { status: 409, title: 'Some services would be left without a supplier.' },
  LINK_CONFLICT: { status: 409, title: 'These supplier links conflict with each other.' },
  LISTING_EXISTS: { status: 409, title: 'This service is already listed.' },
  LISTING_LOCKED: { status: 409, title: 'This listing is locked to business customers.' },
  LOCKED: { status: 409, title: 'This item is locked and cannot be changed.' },
  NO_ACCOUNT: { status: 409, title: 'This customer has no account.' },
  NO_REFERENCE: { status: 409, title: 'This order has no supplier reference yet.' },
  NO_SUPPLIER: { status: 409, title: 'No active supplier is linked to this service.' },
  NOT_A_DRAFT: { status: 409, title: 'Only draft versions can be published.' },
  NOT_ACTIVE: { status: 409, title: 'This account is not active.' },
  NOT_BLOCKED: { status: 409, title: 'This customer is not blocked.' },
  NOT_HELD: { status: 409, title: 'This order is not on hold.' },
  NOT_IN_VERIFICATION: { status: 409, title: 'This order is not waiting for verification.' },
  NOT_MANUAL: { status: 409, title: 'This order is not in the manual queue.' },
  NOT_SUSPENDED: { status: 409, title: 'This account is not suspended.' },
  OPEN_DISPUTE: { status: 409, title: 'The customer has an open dispute.' },
  ORDER_HELD: { status: 409, title: 'This order is on hold for review.' },
  ORDER_NOT_COMPLETED: { status: 409, title: 'This order is not completed.' },
  ORDER_NOT_OPEN: { status: 409, title: 'This order is no longer open.' },
  PAYMENT_ALREADY_REVIEWED: { status: 409, title: 'This payment was already reviewed.' },
  PAYMENT_AUTO_CREDIT_PENDING: { status: 409, title: 'This payment is credited automatically.' },
  PLAN_IN_USE: { status: 409, title: 'This plan is still assigned.' },
  PLAN_LOCKED: { status: 409, title: 'The plan of this assignment cannot be changed.' },
  PRICE_CHANGED: { status: 409, title: 'The price changed since your last service list: refresh it and order again.' },
  PRICE_EXISTS: { status: 409, title: 'A price already exists for this merchant and service.' },
  RECONCILE_RUNNING: { status: 409, title: 'A reconciliation is already running.' },
  REFUND_NOT_FAILED: { status: 409, title: 'This refund did not fail.' },
  REFUND_NOT_PENDING: { status: 409, title: 'This refund is no longer waiting for a decision.' },
  REQUEST_CLOSED: { status: 409, title: 'This request is already closed.' },
  REVIEW_REQUIRED: { status: 409, title: 'This document needs a review before it can be published.' },
  ROLE_IN_USE: { status: 409, title: 'This role is still assigned to staff.' },
  SELF_LOCKOUT: { status: 409, title: 'This rule would lock you out of the console.' },
  SERVICE_DISABLED: { status: 409, title: 'This service is disabled.' },
  SERVICE_IN_USE: { status: 409, title: 'This service is still in use.' },
  SETTLEMENT_PENDING: { status: 409, title: 'This gateway still has pending settlements.' },
  SHORTCUT_TAKEN: { status: 409, title: 'This shortcut is already used.' },
  SLUG_TAKEN: { status: 409, title: 'This page address is already used.' },
  SUPPLIER_DISABLED: { status: 409, title: 'This supplier is disabled.' },
  SUPPLIER_IN_USE: { status: 409, title: 'Services still use this supplier.' },
  SUPPLIER_REFUSED: { status: 409, title: 'The supplier refused this order.' },
  SUPPLIER_UNAVAILABLE: { status: 409, title: 'The supplier cannot be reached right now.' },
  SYNC_NEEDED: { status: 409, title: 'Sync the supplier before importing.' },
  TAC_TAKEN: { status: 409, title: 'This TAC is already in the catalog.' },
  TEMPLATE_BROKEN: { status: 409, title: 'This change would break the template.' },
  TICKET_LOCKED: { status: 409, title: 'This ticket is locked.' },
  TICKET_RESOLVED: { status: 409, title: 'This ticket is already resolved.' },
  TWOFA_ALREADY_ENABLED: { status: 409, title: 'Two-factor sign-in is already on for this account.' },
  TWOFA_NOT_ENABLED: { status: 409, title: 'Two-factor sign-in is already off for this account.' },
  USE_REFUNDS: { status: 409, title: 'Use the refunds page for storefront orders.' },
  VERSION_EXISTS: { status: 409, title: 'This version already exists.' },
  TOKEN_INVALID: { status: 410, title: 'This link is invalid or has expired.' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'The request is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'This content type is not supported.' },
  INVALID_IMEI: { status: 422, title: 'This IMEI is not valid.' },
  TEMPLATE_INVALID: { status: 422, title: 'This template has a syntax error.' },
  VALIDATION_FAILED: { status: 422, title: 'Some fields are not valid.' },
  WEAK_PASSWORD: { status: 422, title: 'This password is too weak.' },
  RATE_LIMITED: { status: 429, title: 'You are sending requests too quickly.' },
  INTERNAL_ERROR: { status: 500, title: 'Something went wrong on our side.' },
  LEDGER_UNBALANCED: { status: 500, title: 'A ledger entry did not balance and was refused.' },
  RESPONSE_CONTRACT_VIOLATION: { status: 500, title: 'The server produced an unexpected response.' },
  SUPPLIERS_FAILED: { status: 500, title: 'The suppliers could not be loaded.' },
  FX_PROVIDER_DOWN: { status: 502, title: 'The exchange-rate provider is not responding.' },
  GATEWAY_ERROR: { status: 502, title: 'The payment gateway reported an error.' },
  SUPPLIER_UNREACHABLE: { status: 502, title: 'The supplier did not answer.' },
  DATABASE_UNAVAILABLE: { status: 503, title: 'The database is not available right now.' },
  MAINTENANCE: { status: 503, title: 'The service is in maintenance.' },
  MONITORING_UNAVAILABLE: { status: 503, title: 'Monitoring data is not available right now.' },
  UNAVAILABLE: { status: 503, title: 'The service is temporarily unavailable.' },
  SUPPLIER_TIMEOUT: { status: 504, title: 'The supplier took too long to answer.' },
} as const satisfies Record<string, ErrorCatalogEntry>;

/**
 * The union of all catalog codes, so `new AppError('NOT_FOUND')` is checked by the compiler.
 *
 * Why: an unknown code is a compile error, so no handler can answer with a code the catalog and
 * `docs/contract/error-codes.md` do not know.
 */
export type ErrorCode = keyof typeof ERROR_CATALOG;

/**
 * Tells whether a string is a catalog code.
 *
 * Why: code that receives a plain string (a header, a column) can narrow it to a catalog code.
 *
 * @param value any string
 * @returns true when the catalog has this code
 */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CATALOG, value);
}

/**
 * Looks up the HTTP status of a code.
 *
 * Why: one source of status per code (decision 028), so the filter and the docs never disagree.
 *
 * @param code a catalog code
 * @returns the status, e.g. 409 for `EMAIL_TAKEN`
 */
export function statusOf(code: ErrorCode): number {
  return ERROR_CATALOG[code].status;
}

/**
 * Looks up the fixed title of a code.
 *
 * Why: the title is fixed per code (decision 028); occurrences differ only in `detail`.
 *
 * @param code a catalog code
 * @returns the English title
 */
export function titleOf(code: ErrorCode): string {
  return ERROR_CATALOG[code].title;
}

/**
 * Turns a code into the last segment of the problem `type` URI.
 *
 * Why: decision 028: the problem `type` URI ends with the code in kebab-case.
 *
 * @param code a catalog code
 * @returns the code in kebab-case, e.g. `VALIDATION_FAILED` becomes `validation-failed`
 */
export function problemSlug(code: ErrorCode): string {
  return code.toLowerCase().replaceAll('_', '-');
}
