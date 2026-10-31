// defineRoute(): one frozen, registered contract per endpoint (decision 008). The manifest key is the identity;
// request schemas, success shape, error codes and docs metadata live here and drive validation, types and OpenAPI.
import type { z } from 'zod';
import { ERROR_CATALOG, isErrorCode, type ErrorCode } from '../errors/catalog';
import { surfaceOfPath, type Surface } from '../surface';
import { isListQuerySchema, type ListQueryBrand } from './list-query';

/**
 * HTTP methods of the map's routes.
 *
 * Why: the map's routes use exactly these five methods; any other method in a route key is a typo the compiler should
 * catch.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * `METHOD /path`, exactly as in `docs/route-manifest.json` (`GET /admin/staff/:id`).
 *
 * Why: the key is a route's identity in the contract registry, in the contract tests (decision 009) and in the OpenAPI
 * `x-gsm-key`.
 */
export type RouteKey = `${HttpMethod} /${string}`;
/**
 * Every access kind a route contract can declare (the `access` values of the manifest for HTTP routes).
 *
 * Why: the guard dispatcher (decision 018) needs one handler per kind and a test checks that none is missing, so the
 * list exists at run time and the {@link AccessKind} type is derived from it.
 */
export const ACCESS_KINDS = [
  'public',
  'staff-session',
  'staff-permission',
  'merchant-session',
  'customer-session',
  'api-key',
  'dhru-credentials',
  'gateway-signature',
  'url-secret',
  'checkout-token',
  'tracking-token',
  'link-token',
  'ticket-token',
  'internal-or-token',
] as const;

/**
 * Who may call a route (the `access` values of the manifest for HTTP routes).
 *
 * Why: guards pick how a route authenticates from this value (decision 018) and the OpenAPI document names the security
 * scheme from it.
 */
export type AccessKind = (typeof ACCESS_KINDS)[number];

/**
 * The access kinds that authenticate with a session cookie (`sessions` table, decision 018).
 *
 * Why: only these routes have a session stage to check, a CSRF token to match and (for staff) an audit duty.
 */
export const SESSION_ACCESS_KINDS = [
  'staff-session',
  'staff-permission',
  'merchant-session',
  'customer-session',
] as const satisfies readonly AccessKind[];

/**
 * Tells whether an access kind authenticates with a session cookie.
 *
 * Why: see {@link SESSION_ACCESS_KINDS}; guards, the contract checks and the OpenAPI metadata ask the same question.
 *
 * @param access an access kind
 * @returns true for `staff-session`, `staff-permission`, `merchant-session` and `customer-session`
 */
export function isSessionAccess(access: AccessKind): boolean {
  return (SESSION_ACCESS_KINDS as readonly string[]).includes(access);
}

/**
 * The sign-in steps a session can be in; only `active` is a full session.
 *
 * Why: decision 018 and MISMATCHES B106: the staff sign-in is a multi-step flow, and a route says which steps it accepts
 * (`sessionStages`). The identity schema keeps the same list for the database CHECK; a test keeps the two equal.
 */
export const SESSION_STAGES = ['pending_password', 'pending_totp_setup', 'pending_totp', 'active'] as const;

/** One value of {@link SESSION_STAGES}. */
export type SessionStage = (typeof SESSION_STAGES)[number];

/**
 * The stages a session route accepts when it declares none: a full session only.
 *
 * Why: a pending session unlocks only its next sign-in step and the logout (decision 018), so every other route refuses it.
 */
export const DEFAULT_SESSION_STAGES: readonly SessionStage[] = Object.freeze(['active'] as const);

/**
 * Success statuses the API uses: 200, 201 (create), 202 (accepted) and 204 (no body).
 *
 * Why: ALIGNMENT § 1 fixes one success status per endpoint (201 for creates, 204 for deletes and bodiless actions) and
 * `defineRoute` refuses any other.
 */
export type SuccessStatus = 200 | 201 | 202 | 204;

type MaybeSchema = z.ZodType | undefined;
type MaybeObject = z.ZodObject | undefined;

/**
 * How a route answers when it works.
 *
 * Why: a route answers with one status and one body shape, so the response schema can strip unknown fields and the docs
 * can describe it (decision 008).
 */
export interface SuccessSpec<S extends MaybeSchema> {
  readonly status: SuccessStatus;
  /** JSON body schema (strips unknown keys). For a list route (`listQuery`) it is the schema of ONE row. */
  readonly schema?: S;
  /** Media type of a non-JSON success (CSV, PDF, HTML, Prometheus text); such a route has no schema. */
  readonly contentType?: string;
  /** Other statuses that carry the same body (sent with `respondWith`), e.g. `[503]` for `GET /health?strict=1`. */
  readonly alsoStatuses?: readonly number[];
}

/**
 * The input of {@link defineRoute}.
 *
 * Why: everything about an endpoint is written once, here, and feeds validation, handler types, serialisation and
 * OpenAPI (decision 008).
 */
export interface RouteSpec<
  P extends MaybeObject,
  Q extends MaybeSchema,
  B extends MaybeSchema,
  H extends MaybeObject,
  S extends MaybeSchema,
> {
  /** Manifest key; the Nest method and path are derived from it. */
  readonly key: RouteKey;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly surface: Surface;
  readonly access: AccessKind;
  /** `resource:action` the caller needs; required for `staff-permission`, forbidden otherwise. */
  readonly permission?: string | null;
  /** Path parameters; an object schema with exactly the `:names` of the path. */
  readonly params?: P;
  /** Query string; use `listQuery()` for lists. */
  readonly query?: Q;
  readonly body?: B;
  /** Headers the route reads (object schema with lower-case names). */
  readonly headers?: H;
  readonly success: SuccessSpec<S>;
  /** Catalog codes this route can answer with (documented per status in OpenAPI). */
  readonly errors: readonly ErrorCode[];
  /** A request body and a success body example for the docs; both are validated against the schemas. */
  readonly examples?: { readonly request?: unknown; readonly response?: unknown };
  /**
   * The `sessions.stage` values a session route accepts (default `['active']`). The sign-in routes name their pending
   * stages (for example `2fa` accepts `pending_totp` and `pending_totp_setup`). Only for session access kinds; a
   * `staff-permission` route always needs `active`.
   */
  readonly sessionStages?: readonly SessionStage[];
  /**
   * `false` marks an admin route that changes data but writes no audit row (the sign-in steps). The description must say
   * why. Every other staff mutation must call `AuditService.record` or the request fails in development and tests.
   */
  readonly audit?: boolean;
  /**
   * `false` declares a mutation that has no session to bind a CSRF token to (sign-in, password set by token). Only for
   * routes that do not authenticate with a session cookie: they get the exact-`Origin` check instead on `/admin` and
   * `/client`.
   */
  readonly csrf?: boolean;
}

/**
 * The frozen contract of one route.
 *
 * Why: guards, the response interceptor, the OpenAPI builder and the contract tests (decision 009) read this one shape,
 * never the author's spec.
 */
export interface RouteContract<
  P extends MaybeObject,
  Q extends MaybeSchema,
  B extends MaybeSchema,
  H extends MaybeObject,
  S extends MaybeSchema,
> {
  readonly key: RouteKey;
  readonly method: HttpMethod;
  /** Nest/Fastify path (`/admin/staff/:id`). */
  readonly path: string;
  readonly summary: string;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  readonly surface: Surface;
  readonly access: AccessKind;
  readonly permission: string | null;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  readonly headers: H;
  readonly success: {
    readonly status: SuccessStatus;
    readonly schema: S;
    readonly contentType: string | undefined;
    readonly alsoStatuses: readonly number[];
    /** True when `query` is a `listQuery()`: the handler returns `{ rows, total }` and the answer is an array. */
    readonly list: boolean;
  };
  readonly errors: readonly ErrorCode[];
  readonly examples: { readonly request: unknown; readonly response: unknown };
  /** Stages a session route accepts; `['active']` unless the spec says otherwise (meaningless for other access kinds). */
  readonly sessionStages: readonly SessionStage[];
  /** False when a staff mutation is exempt from the audit duty (`audit: false`). */
  readonly audit: boolean;
  /** False when the route declared that it has no session to bind a CSRF token to (`csrf: false`). */
  readonly csrf: boolean;
}

/**
 * A contract whose schemas are not known statically (what decorators and the registry accept).
 *
 * Why: decorators and the registry handle contracts of every shape, so they need a type that does not depend on one
 * route's schemas.
 */
export type AnyRouteContract = RouteContract<MaybeObject, MaybeSchema, MaybeSchema, MaybeObject, MaybeSchema>;

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
/**
 * The validated path parameters a handler receives.
 *
 * Why: handlers receive path ids already parsed to numbers; deriving the type from the contract keeps handler and
 * contract in step (decision 008).
 */
export type ParamsOf<C extends AnyRouteContract> = Out<C['params']>;
/**
 * The validated query a handler receives (the parsed list request for `listQuery()`).
 *
 * Why: list routes receive a parsed list request instead of raw strings; deriving the type from the contract keeps
 * handler and contract in step.
 */
export type QueryOf<C extends AnyRouteContract> = Out<C['query']>;
/**
 * The validated body a handler receives.
 *
 * Why: a handler must never see an unvalidated body; the type comes from the same schema the validation pipe runs.
 */
export type BodyOf<C extends AnyRouteContract> = Out<C['body']>;
/**
 * The validated headers a handler receives through `@ContractHeaders()`.
 *
 * Why: headers such as `Idempotency-Key` are validated like any other input; the type comes from the same schema the
 * pipe runs.
 */
export type HeadersOf<C extends AnyRouteContract> = Out<C['headers']>;
/**
 * What a handler returns: `{ rows, total }` for a list route, otherwise the body before the response schema strips
 * it (anything for a non-JSON or 204 route).
 *
 * Why: the compiler checks that a handler returns what its contract promises, before the response schema strips what
 * the contract does not name.
 */
export type ResultOf<C extends AnyRouteContract> = C['query'] extends ListQueryBrand
  ? {
      readonly rows: readonly (C['success']['schema'] extends z.ZodType ? z.input<C['success']['schema']> : never)[];
      readonly total: number;
    }
  : C['success']['schema'] extends z.ZodType
    ? z.input<C['success']['schema']>
    : unknown;

const KEY_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const SEGMENT_PATTERN = /^(?::([A-Za-z_][A-Za-z0-9_]*)|[A-Za-z0-9._~-]+)$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*:(?:\*|[a-z][a-z0-9_]*)$/;
const ALLOWED_STATUSES: readonly number[] = [200, 201, 202, 204];

/**
 * Splits a manifest key into method, path and path parameter names.
 *
 * Why: the key is a route's identity in the map; one parser keeps the registry, path derivation and checks consistent.
 *
 * @param key a manifest key such as `GET /admin/staff/:id`
 * @returns the HTTP method, the path template and the `:name` parameters in order of appearance
 * @throws {Error} when the key is not `METHOD /path`, has an invalid segment or repeats a parameter
 */
export function parseRouteKey(key: string): { method: HttpMethod; path: string; paramNames: string[] } {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new Error(`Route key "${key}" must look like "GET /admin/staff/:id"`);
  const method = match[1] as HttpMethod;
  const path = match[2]!;
  const paramNames: string[] = [];
  if (path !== '/') {
    for (const segment of path.slice(1).split('/')) {
      const parsed = SEGMENT_PATTERN.exec(segment);
      if (!parsed) throw new Error(`Route key "${key}" has an invalid path segment "${segment}"`);
      if (parsed[1]) paramNames.push(parsed[1]);
    }
  }
  if (new Set(paramNames).size !== paramNames.length) throw new Error(`Route key "${key}" repeats a path parameter`);
  return { method, path, paramNames };
}

/**
 * Process-wide list of every defined contract, keyed by manifest key (read by docs and contract tests).
 *
 * Why: decision 009's contract tests and the OpenAPI generation read the registry instead of scanning controllers.
 */
export class ContractRegistry {
  private readonly contracts = new Map<RouteKey, AnyRouteContract>();

  /**
   * Adds a contract.
   *
   * @param contract the frozen contract
   * @throws {Error} when the key is already registered
   */
  register(contract: AnyRouteContract): void {
    if (this.contracts.has(contract.key)) throw new Error(`Route contract "${contract.key}" is defined twice`);
    this.contracts.set(contract.key, contract);
  }

  /**
   * Looks a contract up by its manifest key.
   *
   * @param key a manifest key such as `GET /admin/staff/:id`
   * @returns the contract, or `undefined` when none is registered
   */
  get(key: string): AnyRouteContract | undefined {
    return this.contracts.get(key as RouteKey);
  }

  /**
   * Tells whether a manifest key has a contract.
   *
   * @param key a manifest key such as `GET /admin/staff/:id`
   * @returns true when the key is registered
   */
  has(key: string): boolean {
    return this.contracts.has(key as RouteKey);
  }

  /**
   * Lists every contract.
   *
   * @returns the contracts in definition order
   */
  all(): readonly AnyRouteContract[] {
    return [...this.contracts.values()];
  }

  /**
   * Lists every registered manifest key.
   *
   * @returns the keys in definition order
   */
  keys(): readonly RouteKey[] {
    return [...this.contracts.keys()];
  }

  /** Removes every contract. Tests only: the registry is process-wide. */
  clear(): void {
    this.contracts.clear();
  }
}

/**
 * The global registry of route contracts.
 *
 * Why: decision 009's contract tests compare it with the manifest and the frontend's types, and the OpenAPI
 * document is generated from it.
 */
export const contractRegistry = new ContractRegistry();

/**
 * Defines, checks and registers the contract of one endpoint.
 *
 * Why: decision 008 makes one zod contract per route the source of validation, handler types, response
 * serialisation and OpenAPI. Mistakes (a path parameter without a schema, a permission on a public route, an
 * example that fails its own schema) fail at boot, not when someone calls the route.
 *
 * @param spec the route description
 * @returns the frozen contract, also stored in {@link contractRegistry}
 * @throws {Error} when the definition is inconsistent or the key was already defined (a programming error)
 *
 * @example
 * export const showStaff = defineRoute({
 *   key: 'GET /admin/staff/:id',
 *   summary: 'Show a staff member',
 *   tags: ['staff'],
 *   surface: 'admin',
 *   access: 'staff-permission',
 *   permission: 'staff:read',
 *   params: z.object({ id: zIdParam }),
 *   success: { status: 200, schema: StaffDto },
 *   errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
 * });
 */
export function defineRoute<
  P extends MaybeObject = undefined,
  Q extends MaybeSchema = undefined,
  B extends MaybeSchema = undefined,
  H extends MaybeObject = undefined,
  S extends MaybeSchema = undefined,
>(spec: RouteSpec<P, Q, B, H, S>): RouteContract<P, Q, B, H, S> {
  const where = `defineRoute("${spec.key}")`;
  const problem = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const { method, path, paramNames } = parseRouteKey(spec.key);

  if (spec.summary.trim() === '' || spec.summary.length > 120) problem('summary must be 1-120 characters');
  if (spec.tags.length === 0) problem('tags must name at least one tag');
  if (surfaceOfPath(path) !== spec.surface)
    problem(`surface "${spec.surface}" does not match the path (expected "${surfaceOfPath(path)}")`);

  // Access and permission.
  const permission = spec.permission ?? null;
  if (spec.access === 'staff-permission') {
    if (!permission || !PERMISSION_PATTERN.test(permission))
      problem('staff-permission routes need a permission like "staff:read"');
  } else if (permission !== null) {
    problem(`only staff-permission routes carry a permission (access is "${spec.access}")`);
  }

  // Session stages, audit duty and CSRF declaration (decision 018).
  const sessionAccess = isSessionAccess(spec.access);
  let sessionStages: readonly SessionStage[] = DEFAULT_SESSION_STAGES;
  if (spec.sessionStages !== undefined) {
    if (!sessionAccess) problem(`sessionStages only applies to session routes (access is "${spec.access}")`);
    if (spec.sessionStages.length === 0) problem('sessionStages must name at least one stage');
    for (const stage of spec.sessionStages) {
      if (!(SESSION_STAGES as readonly string[]).includes(stage)) problem(`unknown session stage "${String(stage)}"`);
    }
    if (new Set(spec.sessionStages).size !== spec.sessionStages.length) problem('sessionStages lists a stage twice');
    if (spec.access === 'staff-permission' && (spec.sessionStages.length !== 1 || spec.sessionStages[0] !== 'active'))
      problem('a staff-permission route needs a full session: sessionStages can only be ["active"]');
    sessionStages = Object.freeze([...spec.sessionStages]);
  }
  if (spec.audit === false) {
    if (spec.surface !== 'admin')
      problem('audit: false only applies to admin routes (the audit log records staff writes)');
    if (method === 'GET') problem('audit: false only applies to routes that change data (a GET is never audited)');
    if (!spec.description || spec.description.trim() === '')
      problem('audit: false needs a description that says why no audit row is written');
  }
  if (spec.csrf === false) {
    if (sessionAccess)
      problem(
        `csrf: false is only for routes without a session (access is "${spec.access}"): a session route always needs the token`,
      );
    if (method === 'GET') problem('csrf: false only applies to routes that change data (a GET is never CSRF-checked)');
  }

  // Inputs.
  const declared = spec.params ? Object.keys(spec.params.shape) : [];
  if (paramNames.length > 0 && !spec.params) problem(`path parameters (${paramNames.join(', ')}) need a params schema`);
  if (spec.params && (declared.length !== paramNames.length || !paramNames.every((name) => declared.includes(name)))) {
    problem(
      `params must declare exactly the path parameters (${paramNames.join(', ') || 'none'}), got (${declared.join(', ')})`,
    );
  }
  if (spec.headers) {
    for (const name of Object.keys(spec.headers.shape)) {
      if (name !== name.toLowerCase()) problem(`header "${name}" must be written in lower case`);
    }
  }
  if (spec.body && method === 'GET') problem('a GET route cannot have a body');

  // Success.
  const { status, schema, contentType } = spec.success;
  if (!ALLOWED_STATUSES.includes(status)) problem(`success status ${String(status)} is not one of 200, 201, 202, 204`);
  const list = spec.query !== undefined && isListQuerySchema(spec.query);
  if (status === 204) {
    if (schema || contentType) problem('a 204 route has no body: remove success.schema and success.contentType');
  } else if (!schema && !contentType) {
    problem('declare success.schema (JSON body) or success.contentType (file, text)');
  } else if (schema && contentType) {
    problem('declare success.schema or success.contentType, not both');
  }
  if (list) {
    if (method !== 'GET' || status !== 200 || !schema)
      problem('a list route is GET, answers 200 and declares the row schema');
  }
  for (const other of spec.success.alsoStatuses ?? []) {
    if (!Number.isInteger(other) || other < 200 || other > 599 || other === status)
      problem(`alsoStatuses has an invalid status ${other}`);
    if (!schema) problem('alsoStatuses needs success.schema');
  }

  // Errors.
  for (const code of spec.errors) {
    if (!isErrorCode(code))
      problem(`unknown error code "${String(code)}" (add it to the catalog and docs/contract/error-codes.md)`);
  }
  if (new Set(spec.errors).size !== spec.errors.length) problem('errors lists a code twice');

  // Examples must satisfy the schemas they document.
  const examples = spec.examples ?? {};
  if (examples.request !== undefined) {
    if (!spec.body) problem('examples.request needs a body schema');
    else if (!spec.body.safeParse(examples.request).success)
      problem('examples.request does not satisfy the body schema');
  }
  if (examples.response !== undefined && schema) {
    // A list route documents an array of rows; every other route one body.
    const samples: unknown[] | undefined = list
      ? Array.isArray(examples.response)
        ? examples.response
        : undefined
      : [examples.response];
    if (!samples?.every((item) => schema.safeParse(item).success)) {
      problem(
        list
          ? 'examples.response must be an array of rows that satisfy the row schema'
          : 'examples.response does not satisfy the success schema',
      );
    }
  }

  const contract: RouteContract<P, Q, B, H, S> = Object.freeze({
    key: spec.key,
    method,
    path,
    summary: spec.summary,
    description: spec.description,
    tags: Object.freeze([...spec.tags]),
    surface: spec.surface,
    access: spec.access,
    permission,
    params: spec.params as P,
    query: spec.query as Q,
    body: spec.body as B,
    headers: spec.headers as H,
    success: Object.freeze({
      status,
      schema: schema as S,
      contentType,
      alsoStatuses: Object.freeze([...(spec.success.alsoStatuses ?? [])]),
      list,
    }),
    errors: Object.freeze([...spec.errors]),
    examples: Object.freeze({ request: examples.request, response: examples.response }),
    sessionStages,
    audit: spec.audit ?? true,
    csrf: spec.csrf ?? true,
  });
  contractRegistry.register(contract);
  return contract;
}

/**
 * Lists the HTTP statuses a route can answer with, from its success and error declarations.
 *
 * Why: the contract tests compare these statuses with what the frontend expects (docs/contract/TESTS.md).
 *
 * @param contract a route contract
 * @returns sorted unique statuses
 */
export function declaredStatuses(contract: AnyRouteContract): number[] {
  const statuses = new Set<number>([contract.success.status, ...contract.success.alsoStatuses]);
  for (const code of contract.errors) statuses.add(ERROR_CATALOG[code].status);
  return [...statuses].sort((a, b) => a - b);
}
