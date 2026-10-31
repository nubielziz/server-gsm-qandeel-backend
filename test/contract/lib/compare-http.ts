// Route-level comparison (docs/contract/TESTS.md § 2): a frontend function's return type and parameters against a
// route's success answer and request declaration, on top of the shape comparison in compare.ts.
import type { JsonSchema } from '../../../src/common/contract';
import { type Difference, compareShape } from './compare';
import type { FrontendShape } from './normalize';

const isRootSchema = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compares the success status the frontend contract documents with the one the route declares.
 *
 * Why: ALIGNMENT § 1: the console accepts any 2xx, but the contract fixes one (201 for creates, 204 for bodiless
 * actions), and a drift in either direction breaks the documented API.
 *
 * @param expected the status documented for the frontend function (`docs/contract/extraction/*.json` `successStatus`)
 * @param declared the route's `success.status`
 * @returns one `status` difference, or none
 */
export function compareStatus(expected: number, declared: number): Difference[] {
  if (expected === declared) return [];
  return [
    {
      path: 'status',
      rule: 'status',
      severity: 'error',
      message: `the frontend contract documents ${expected}, the route declares ${declared}`,
    },
  ];
}

/** What a response comparison needs to know about the backend route. */
export interface BackendResponse {
  /** The route's declared success status. */
  readonly status: number;
  /** JSON Schema of the body (of ONE row for a list route); absent for 204 and for file answers. */
  readonly schema?: JsonSchema;
  /** Media type of a non-JSON success. */
  readonly contentType?: string;
  /** True for a `listQuery()` route: the answer is an array of rows plus `x-total-count`. */
  readonly list: boolean;
}

/** What a response comparison needs to know about the frontend function. */
export interface FrontendResponse {
  /** The resolved, awaited return type. */
  readonly returns: FrontendShape | null;
  /** The return type as written (`ListResult<StaffMember>`). */
  readonly returnsText: string;
}

/** Is this the `ListResult<T>` the frontend's `apiList` returns (`{ data: T[], total }`)? */
function listRows(response: FrontendResponse): FrontendShape | undefined {
  const shape = response.returns;
  if (!response.returnsText.startsWith('ListResult<') || !shape?.object) return undefined;
  return shape.object.data?.array;
}

/**
 * Compares a frontend function's return type with a route's success answer.
 *
 * Why: the console reads exactly this answer; `ListResult<T>` means an array of `T` plus an `x-total-count` header
 * (ALIGNMENT § 2), a `string` is a file or text answer, and a `void` is a bodiless 204.
 *
 * @param frontend the frontend function's return type
 * @param backend the route's success declaration
 * @param expectedStatus the success status the frontend contract documents
 * @returns the differences found, `status` and `list-result` included
 */
export function compareResponse(
  frontend: FrontendResponse,
  backend: BackendResponse,
  expectedStatus: number,
): Difference[] {
  const diffs: Difference[] = [...compareStatus(expectedStatus, backend.status)];
  const returns = frontend.returns;
  if (!returns || returns.type === 'undefined') return diffs;

  const rows = listRows(frontend);
  if (rows) {
    if (!backend.list) {
      diffs.push({
        path: 'data[]',
        rule: 'list-result',
        severity: 'error',
        message: 'the frontend expects ListResult<T> (an array plus x-total-count); the route is not a list route',
      });
    }
    if (backend.schema) {
      const rowSchema = backend.list ? backend.schema : arrayItems(backend.schema);
      if (rowSchema)
        diffs.push(
          ...compareShape(rows, rowSchema, { direction: 'response', root: backend.schema }).map(prefix('data[]')),
        );
    }
    return diffs;
  }

  if (returns.type === 'string' && !returns.alias && backend.contentType !== undefined) return diffs;
  if (!backend.schema) {
    diffs.push({
      path: '',
      rule: 'type',
      severity: 'error',
      message: `the frontend reads ${frontend.returnsText}; the route declares no JSON body (${backend.contentType ?? 'no content'})`,
    });
    return diffs;
  }
  const body = backend.list ? ({ type: 'array', items: backend.schema } satisfies JsonSchema) : backend.schema;
  diffs.push(...compareShape(returns, body, { direction: 'response', root: backend.schema }));
  return diffs;
}

function arrayItems(schema: JsonSchema): JsonSchema | undefined {
  const items = schema.items;
  return schema.type === 'array' && isRootSchema(items) ? items : undefined;
}

/** Puts a root name in front of the paths of a nested comparison (`data[]` + `.status`). */
function prefix(root: string): (diff: Difference) => Difference {
  return (diff) => ({
    ...diff,
    path: diff.path === '' ? root : diff.path.startsWith('[') ? `${root}${diff.path}` : `${root}.${diff.path}`,
  });
}

/** One parameter of a frontend function, from `frontend-endpoints.json`. */
export interface FrontendParam {
  readonly name: string;
  readonly optional: boolean;
  readonly typeText: string;
  readonly shape: FrontendShape;
}

/** What a request comparison needs to know about the backend route. */
export interface BackendRequest {
  /** The `:names` of the path, in order. */
  readonly pathParams: readonly string[];
  /** JSON Schema (input side) of the path parameters. */
  readonly params?: JsonSchema;
  /** JSON Schema (input side) of the query; unused for a list route. */
  readonly query?: JsonSchema;
  /** True when the query is the list dialect (`_start`, `_end`, `_sort`, filters). */
  readonly queryIsList: boolean;
  readonly body?: JsonSchema;
}

/** Parameters of a frontend function that are not part of the request. */
const IGNORED_PARAMS = new Set(['init', 'signal', 'fallbackName']);

/**
 * Compares what a frontend function sends with what the route accepts.
 *
 * Why: every field the console sends must be accepted with a compatible type and every field the backend requires must
 * be sent (TESTS.md § 2). Function parameters map to the request by role: `body` is the JSON body, `query` and `params`
 * the query string, anything else a path parameter (in order of the `:names`).
 *
 * @param frontend the frontend function's parameters
 * @param backend the route's request declaration
 * @returns the differences found, with paths starting at `body`, `query` or `params`
 */
export function compareRequest(frontend: readonly FrontendParam[], backend: BackendRequest): Difference[] {
  const diffs: Difference[] = [];
  const used = frontend.filter((param) => !IGNORED_PARAMS.has(param.name));
  const body = used.find((param) => param.name === 'body');
  const query = used.find((param) => param.name === 'query' || param.name === 'params');
  const scalars = used.filter((param) => param !== body && param !== query);

  // Body.
  if (body && !backend.body) {
    diffs.push({
      path: 'body',
      rule: 'missing-field',
      severity: 'error',
      message: 'the frontend sends a body but the route declares none',
    });
  } else if (backend.body) {
    if (body) {
      diffs.push(...compareShape(body.shape, backend.body, { direction: 'request' }).map(prefix('body')));
      if (body.optional && !allOptional(backend.body)) {
        diffs.push({
          path: 'body',
          rule: 'required',
          severity: 'error',
          message: 'the backend requires a body but the frontend may send none',
        });
      }
    } else if (!allOptional(backend.body)) {
      diffs.push({
        path: 'body',
        rule: 'required',
        severity: 'error',
        message: 'the backend requires a body but the frontend sends none',
      });
    }
  }

  // Query (the list dialect is checked through ListResult and the list query contract, not field by field).
  if (query && !query.typeText.startsWith('ListQuery') && !backend.queryIsList) {
    if (backend.query) {
      diffs.push(
        ...compareShape(query.shape, backend.query, { direction: 'request', wire: true }).map(prefix('query')),
      );
    } else {
      diffs.push({
        path: 'query',
        rule: 'missing-field',
        severity: 'error',
        message: 'the frontend sends a query but the route declares none',
      });
    }
  } else if (!query && backend.query && !backend.queryIsList && !allOptional(backend.query)) {
    diffs.push({
      path: 'query',
      rule: 'required',
      severity: 'error',
      message: 'the backend requires query parameters but the frontend sends none',
    });
  }

  // Path parameters, matched by position.
  backend.pathParams.forEach((name, index) => {
    const given = scalars[index];
    const declared = (backend.params?.properties as Record<string, unknown> | undefined)?.[name];
    if (!given || declared === undefined) return;
    diffs.push(
      ...compareShape(given.shape, declared, { direction: 'request', wire: true, root: backend.params }).map(
        prefix(`params.${name}`),
      ),
    );
  });
  return diffs;
}

/** True when a request schema has no required field: the whole input may be left out. */
function allOptional(schema: JsonSchema): boolean {
  const required = schema.required;
  return !(Array.isArray(required) && required.length > 0) && schema.type !== 'array' && schema.type !== 'string';
}
