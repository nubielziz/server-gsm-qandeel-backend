// Maintenance mode (platform module, scenario system-integrity): the state stored in settings key `maintenance`, which requests
// each scope refuses, and the 503 MAINTENANCE answer. Pure functions; the service and the pipeline hook use them.
import { z } from 'zod';
import { AppError } from '../../../common/errors';

/**
 * The settings key that holds the maintenance state.
 *
 * Why: `PUT /admin/system/maintenance` (system health feature) stores the state under this key; `PATCH /admin/settings`
 * refuses it (MISMATCHES B67) so only the guarded route changes it.
 */
export const MAINTENANCE_KEY = 'maintenance';

/**
 * What maintenance covers: the storefront API, starting a storefront checkout only, merchant order placement over REST v1
 * and Dhru, or all of it.
 *
 * Why: the console's maintenance dialog offers exactly these four (`MaintenanceScope`, docs/contract/endpoints/health.md);
 * the admin console, the merchant portal, incoming webhooks and running orders are never affected.
 */
export const MAINTENANCE_SCOPES = ['store', 'checkout', 'api_orders', 'all'] as const;

/** One value of {@link MAINTENANCE_SCOPES}. */
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];

/**
 * The maintenance state as the console reads and writes it (`MaintenanceState` of the System health types).
 *
 * Why: the state is stored in settings exactly as `GET /admin/system/health` returns it; "off" is `enabled: false` with
 * the other five fields null.
 */
export interface MaintenanceState {
  readonly enabled: boolean;
  readonly scope: MaintenanceScope | null;
  /** Shown to customers with the 503 answer. */
  readonly message: string | null;
  /** Informs customers only; maintenance ends when staff switch it off. */
  readonly expectedEndAt: string | null;
  readonly startedAt: string | null;
  readonly startedBy: { readonly id: number; readonly name: string } | null;
}

/**
 * Maintenance switched off.
 *
 * Why: the documented default when the `maintenance` setting was never set.
 */
export const MAINTENANCE_OFF: MaintenanceState = Object.freeze({
  enabled: false,
  scope: null,
  message: null,
  expectedEndAt: null,
  startedAt: null,
  startedBy: null,
});

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? null);
const StoredState = z
  .object({
    enabled: z.boolean(),
    scope: nullable(z.enum(MAINTENANCE_SCOPES)),
    message: nullable(z.string()),
    expectedEndAt: nullable(z.string()),
    startedAt: nullable(z.string()),
    startedBy: nullable(z.object({ id: z.number(), name: z.string() })),
  })
  // A switched-on state without a scope covers nothing and cannot have been written by the guarded route.
  .refine((state) => !state.enabled || state.scope !== null);

/**
 * Reads a stored `maintenance` setting.
 *
 * Why: the value is JSON written by another feature; a malformed row must not switch maintenance on or off by accident, so
 * the caller decides what to do with `undefined` (use "off" and log).
 *
 * @param value the raw JSON value of the setting
 * @returns the state, or `undefined` when the value is not a well-formed state
 */
export function parseMaintenanceState(value: unknown): MaintenanceState | undefined {
  const parsed = StoredState.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Dhru endpoint: one path for every action, the action sits in the body.
 *
 * Why: decision 026 puts all eight actions on `POST /api/index.php`, so maintenance can only tell a placement from a status
 * call by reading the body.
 */
export const DHRU_PATH = '/api/index.php';
/**
 * The Dhru actions that place an order (the others read an account, a price list or the status of a running order).
 *
 * Why: scope `api_orders` stops merchants placing orders while running orders keep working (scenario system-integrity).
 */
export const DHRU_PLACEMENT_ACTIONS: ReadonlySet<string> = new Set([
  'placeimeiorder',
  'placeimeiorderbulk',
  'placefileorder',
]);

const STORE = /^\/store\/v1(?:\/|$)/;
const CHECKOUT_START: readonly RegExp[] = [
  /^\/store\/v1\/checkout-sessions$/,
  /^\/store\/v1\/checkout-sessions\/[^/]+\/pay$/,
];
// The upload of a File service's input is part of placing the order (B157), so scope `api_orders` refuses it too.
const ORDER_PLACEMENT: ReadonlySet<string> = new Set(['/v1/orders', '/v1/orders/bulk', '/v1/files']);

/**
 * A request, as far as maintenance cares.
 *
 * Why: the scopes are decided by method and path, and for Dhru by the action of the body.
 */
export interface MaintenanceRequest {
  readonly method: string;
  /** The route template or decoded path (`requestPath`). */
  readonly path: string;
  /** The Dhru `action` of the body, lower case, when it is known (the `preValidation` phase). */
  readonly dhruAction?: string | undefined;
}

/**
 * The scopes whose maintenance refuses a request.
 *
 * Why: `store` is the whole storefront API; `checkout` is only starting a checkout (opening a session and starting the
 * payment of one, so nothing is created and nothing is held); `api_orders` is placing an order over REST v1 or Dhru;
 * `all` is the three; the upload of a File service's input (`POST /v1/files`, B157) counts as placing. Everything else (admin, merchant portal, webhooks, health, metrics, docs, reads and cancellations of
 * running orders) is in no scope. A Dhru request counts only once its action is known and is a placement.
 *
 * @param request method and path (and the Dhru action when known)
 * @returns the scopes that cover the request; empty when maintenance never refuses it
 */
export function scopesCovering(request: MaintenanceRequest): readonly MaintenanceScope[] {
  const post = request.method.toUpperCase() === 'POST';
  if (STORE.test(request.path)) {
    return post && CHECKOUT_START.some((pattern) => pattern.test(request.path))
      ? ['store', 'checkout', 'all']
      : ['store', 'all'];
  }
  if (post && ORDER_PLACEMENT.has(request.path)) return ['api_orders', 'all'];
  if (post && request.path === DHRU_PATH && request.dhruAction && DHRU_PLACEMENT_ACTIONS.has(request.dhruAction)) {
    return ['api_orders', 'all'];
  }
  return [];
}

/**
 * Reads the Dhru `action` of a parsed request body.
 *
 * Why: Dhru sends form fields (`username`, `apiaccesskey`, `action`, `parameters`), as a form, JSON or multipart body
 * (all three are parsed before the pipeline's validation stage); the pipeline looks only at `action`, and a body it
 * cannot read means "unknown", which maintenance does not refuse here.
 *
 * @param body the parsed body
 * @returns the action, trimmed and lower-cased; `undefined` when the body has none
 */
export function dhruActionOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const action = (body as Record<string, unknown>)['action'];
  return typeof action === 'string' && action.trim() !== '' ? action.trim().toLowerCase() : undefined;
}

/**
 * The sentence shown when the staff member wrote no message.
 *
 * Why: the 503 answer always has a human sentence in `detail`, and the console's dialog requires a message, so this is only
 * a safety net for a state written by hand.
 */
export const DEFAULT_MAINTENANCE_MESSAGE = 'The service is in maintenance. Please try again later.';
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MIN_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * How long a client should wait before trying again.
 *
 * Why: `expectedEndAt` only informs, and maintenance may end earlier, so the hint is the time to the expected end kept
 * between 30 seconds and 5 minutes; 60 seconds when no end is known or it has passed.
 *
 * @param expectedEndAt the ISO time staff expect to be done, or null
 * @param nowMs the current time in milliseconds
 * @returns seconds for the `Retry-After` header
 */
export function maintenanceRetryAfter(expectedEndAt: string | null, nowMs: number): number {
  const end = expectedEndAt === null ? Number.NaN : Date.parse(expectedEndAt);
  if (!Number.isFinite(end) || end <= nowMs) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil((end - nowMs) / 1000)));
}

/**
 * Decides whether maintenance refuses a request, and builds the answer.
 *
 * Why: the 503 MAINTENANCE problem carries the staff member's message as `detail` and `expectedEndAt` as an extension
 * member, with `Retry-After`; on the Dhru surface the registered formatter turns the same error into the Dhru envelope
 * (decision 026).
 *
 * @param state the current maintenance state
 * @param request the request
 * @param nowMs the current time in milliseconds, from the injected clock (decision 031)
 * @returns the error to throw, or `undefined` when the request may go on
 */
export function maintenanceRefusal(
  state: MaintenanceState,
  request: MaintenanceRequest,
  nowMs: number,
): AppError | undefined {
  if (!state.enabled || state.scope === null) return undefined;
  if (!scopesCovering(request).includes(state.scope)) return undefined;
  const message = state.message?.trim();
  return new AppError('MAINTENANCE', {
    detail: message ? message : DEFAULT_MAINTENANCE_MESSAGE,
    retryAfterSeconds: maintenanceRetryAfter(state.expectedEndAt, nowMs),
    extensions: { expectedEndAt: state.expectedEndAt },
  });
}
