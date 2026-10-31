// listQuery(): the zod schema of the simple-rest list dialect of ALIGNMENT § 2 (_start/_end, _sort/_order, q, filters).
// Parses a raw query string object into one typed value; unknown or disallowed parameters become 422 errors.
import { z } from 'zod';
import { toJsonSchema, type JsonSchema } from './json-schema';

/**
 * Default page when `_start`/`_end` are missing: rows 0 to 25.
 *
 * Why: ALIGNMENT § 2 names rows 0 to 25 as the default page.
 */
export const DEFAULT_PAGE_SIZE = 25;
/**
 * Default largest page (ALIGNMENT § 2: up to 1000 rows).
 *
 * Why: ALIGNMENT § 2 allows pages of up to 1000 rows (the console asks for 500 on IP rules).
 */
export const DEFAULT_MAX_PAGE = 1000;
/** Offsets above this are refused: a deep OFFSET scans every skipped row. */
const MAX_OFFSET = 10_000_000;
const MAX_IN_VALUES = 100;
const MAX_TEXT_LENGTH = 200;
const MAX_SORT_FIELDS = 5;

/**
 * Comparison of a filter; `eq` with several values is IN, `ne` with several values is NOT IN.
 *
 * Why: the console's simple-rest dialect (ALIGNMENT § 2) writes operators as key suffixes (`_ne`, `_gte`, `_like`);
 * this is the closed list of them.
 */
export type FilterOp = 'eq' | 'ne' | 'gte' | 'lte' | 'gt' | 'lt' | 'like';
/**
 * How the text of a filter value is read.
 *
 * Why: every filter value arrives as text in the query string and must be read as its real type before it reaches SQL.
 */
export type FilterType = 'string' | 'enum' | 'boolean' | 'number' | 'decimal' | 'id' | 'datetime';
/**
 * One parsed filter value: strings (also `decimal`, kept exact), numbers, booleans or dates.
 *
 * Why: repositories compare typed values, never raw strings; decimals stay strings so no precision is lost (decision
 * 011).
 */
export type FilterValue = string | number | boolean | Date;

/**
 * What may be filtered on one field. Field names are the camelCase response fields (dotted paths allowed).
 *
 * Why: only the filters an endpoint declares are accepted, so a client cannot filter on a column the endpoint never
 * meant to expose.
 */
export interface FilterSpec {
  readonly type: FilterType;
  /** Allowed operators; defaults by type (string: eq, ne, like; numbers, ids: all but like; datetime: no ne, like). */
  readonly ops?: readonly FilterOp[];
  /** The allowed values of an `enum` filter. */
  readonly values?: readonly string[];
}

/**
 * Configuration of {@link listQuery}.
 *
 * Why: one declaration per list endpoint gives validation, the parsed request type and the OpenAPI parameters (decision
 * 008).
 */
export interface ListQueryConfig<S extends string, X extends z.ZodRawShape> {
  /** Fields `_sort` may name. */
  readonly sorts: readonly S[];
  /** Order used when `_sort` is absent. */
  readonly defaultSort: ListSort<S> | readonly ListSort<S>[];
  /** Filterable fields. */
  readonly filters?: Readonly<Record<string, FilterSpec>>;
  /** Fields `q` searches (case-insensitive substring). Without it, `q` is refused. */
  readonly search?: readonly string[];
  /** Largest page, default 1000. */
  readonly maxPage?: number;
  /** Extra non-dialect parameters of the endpoint (`from`, `to`, `open`, ...) with their own zod schemas. */
  readonly extra?: X;
}

/**
 * One sort key.
 *
 * Why: repositories turn sort keys into ORDER BY from a closed list of fields, never from client text.
 */
export interface ListSort<S extends string = string> {
  readonly field: S;
  readonly order: 'asc' | 'desc';
}

/**
 * One parsed filter: `values` has one element except for `eq`/`ne` with a repeated key.
 *
 * Why: repositories apply filters from this shape; equality with several values means IN, because the console repeats
 * the key.
 */
export interface ParsedFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly values: readonly FilterValue[];
}

/**
 * The parsed list request a handler receives.
 *
 * Why: list handlers get paging, sorting, filters and search already validated, so no handler parses `_start` or
 * `_sort` by hand.
 */
export interface ParsedListQuery<S extends string = string, X = Record<string, never>> {
  /** `start` is 0-based and inclusive, `end` exclusive, `limit = end - start`. */
  readonly range: { readonly start: number; readonly end: number; readonly limit: number };
  /** Sort keys; repositories append the primary key last so the order is stable. */
  readonly sort: readonly ListSort<S>[];
  readonly filters: readonly ParsedFilter[];
  readonly search: { readonly text: string; readonly fields: readonly string[] } | undefined;
  /** The parsed extra parameters of the endpoint. */
  readonly extra: X;
}

/**
 * What documentation needs to know about a list query.
 *
 * Why: the zod schema is a transform over a free-form object, so the OpenAPI builder reads the dialect from this
 * descriptor instead.
 */
export interface ListQueryDescriptor {
  readonly sorts: readonly string[];
  readonly defaultSort: readonly ListSort[];
  readonly filters: Readonly<Record<string, Required<Pick<FilterSpec, 'type' | 'ops'>> & Pick<FilterSpec, 'values'>>>;
  readonly search: readonly string[] | undefined;
  readonly maxPage: number;
  readonly extra: z.ZodObject | undefined;
}

const LIST_QUERY = Symbol.for('gsm.listQuery');

/**
 * The marker property that tells routes and docs a schema came from {@link listQuery}.
 *
 * Why: `defineRoute` and the response interceptor must know that a route answers an array plus `x-total-count`.
 */
export type ListQueryBrand = { readonly [LIST_QUERY]: ListQueryDescriptor };

/**
 * The schema returned by {@link listQuery}; carries its descriptor so routes and docs can recognise it.
 *
 * Why: a route contract needs one value that is both the zod schema (validation) and the carrier of the descriptor
 * (documentation).
 */
export type ListQuerySchema<S extends string = string, X = Record<string, never>> = z.ZodType<
  ParsedListQuery<S, X>,
  Record<string, unknown>
> &
  ListQueryBrand;

/**
 * Tells whether a schema was built by {@link listQuery}.
 *
 * Why: such a route answers an array plus `x-total-count`; `defineRoute` and the response interceptor switch on it.
 *
 * @param schema any zod schema
 * @returns true for list query schemas
 */
export function isListQuerySchema(schema: unknown): schema is ListQueryBrand {
  return typeof schema === 'object' && schema !== null && LIST_QUERY in schema;
}

/**
 * Reads the descriptor of a list query schema.
 *
 * Why: the OpenAPI document needs the whitelist and defaults that the schema's transform hides.
 *
 * @param schema a schema returned by {@link listQuery}
 * @returns its sorts, filters, search fields and page limit
 */
export function describeListQuery(schema: ListQueryBrand): ListQueryDescriptor {
  return schema[LIST_QUERY];
}

const SUFFIXES: ReadonlyArray<readonly [string, FilterOp]> = [
  ['_gte', 'gte'],
  ['_lte', 'lte'],
  ['_like', 'like'],
  ['_gt', 'gt'],
  ['_lt', 'lt'],
  ['_ne', 'ne'],
];
const SUFFIX_OF: Readonly<Record<FilterOp, string>> = {
  eq: '',
  ne: '_ne',
  gte: '_gte',
  lte: '_lte',
  gt: '_gt',
  lt: '_lt',
  like: '_like',
};
const NUMERIC_OPS: readonly FilterOp[] = ['eq', 'ne', 'gte', 'lte', 'gt', 'lt'];
const DEFAULT_OPS: Readonly<Record<FilterType, readonly FilterOp[]>> = {
  string: ['eq', 'ne', 'like'],
  enum: ['eq', 'ne'],
  boolean: ['eq'],
  number: NUMERIC_OPS,
  decimal: NUMERIC_OPS,
  id: NUMERIC_OPS,
  datetime: ['eq', 'gte', 'lte', 'gt', 'lt'],
};
const RESERVED = new Set(['_start', '_end', '_sort', '_order', 'q']);

type Converted = { readonly ok: true; readonly value: FilterValue } | { readonly ok: false; readonly message: string };

function convert(spec: Required<Pick<FilterSpec, 'type'>> & Pick<FilterSpec, 'values'>, text: string): Converted {
  switch (spec.type) {
    case 'string':
      return text.length <= MAX_TEXT_LENGTH
        ? { ok: true, value: text }
        : { ok: false, message: `Must be at most ${MAX_TEXT_LENGTH} characters.` };
    case 'enum':
      return spec.values?.includes(text)
        ? { ok: true, value: text }
        : { ok: false, message: `Must be one of: ${(spec.values ?? []).join(', ')}.` };
    case 'boolean':
      return text === 'true' || text === 'false'
        ? { ok: true, value: text === 'true' }
        : { ok: false, message: 'Must be true or false.' };
    case 'number': {
      const value = Number(text);
      return /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: 'Must be a number.' };
    }
    case 'decimal':
      return /^-?\d+(\.\d+)?$/.test(text) && text.length <= 40
        ? { ok: true, value: text }
        : { ok: false, message: 'Must be a decimal number.' };
    case 'id': {
      const value = Number(text);
      return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(value)
        ? { ok: true, value }
        : { ok: false, message: 'Must be a numeric id.' };
    }
    case 'datetime': {
      // A "+" in an offset arrives as a space in a query string (ALIGNMENT § 2).
      const iso = text.replace(/ (\d{2}:\d{2})$/, '+$1');
      const value = new Date(iso);
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(iso) &&
        !Number.isNaN(value.getTime())
        ? { ok: true, value }
        : { ok: false, message: 'Must be an ISO 8601 time like 2026-03-01T09:30:00.000Z.' };
    }
  }
}

/** Splits the raw value of a key into texts; `undefined` when it is not a string or an array of strings. */
function textsOf(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return raw;
  return undefined;
}

function parseInteger(text: string, min: number, max: number): number | undefined {
  if (!/^\d{1,15}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

function buildDescriptor<S extends string, X extends z.ZodRawShape>(
  config: ListQueryConfig<S, X>,
): ListQueryDescriptor {
  const maxPage = config.maxPage ?? DEFAULT_MAX_PAGE;
  if (!Number.isInteger(maxPage) || maxPage < 1) throw new Error('listQuery: maxPage must be a positive integer');
  if (config.sorts.length === 0) throw new Error('listQuery: sorts must name at least one field');
  // `Array.isArray` does not narrow a readonly array, so a single sort is told apart by its `field`.
  const defaultSort: readonly ListSort<S>[] = 'field' in config.defaultSort ? [config.defaultSort] : config.defaultSort;
  for (const sort of defaultSort) {
    if (!config.sorts.includes(sort.field)) throw new Error(`listQuery: default sort "${sort.field}" is not in sorts`);
  }
  const filters: Record<string, Required<Pick<FilterSpec, 'type' | 'ops'>> & Pick<FilterSpec, 'values'>> = {};
  for (const [field, spec] of Object.entries(config.filters ?? {})) {
    if (RESERVED.has(field)) throw new Error(`listQuery: "${field}" is a reserved parameter name`);
    if (spec.type === 'enum' && (!spec.values || spec.values.length === 0))
      throw new Error(`listQuery: enum filter "${field}" needs values`);
    const allowed = DEFAULT_OPS[spec.type];
    const ops = spec.ops ?? allowed;
    for (const op of ops) {
      if (!allowed.includes(op))
        throw new Error(`listQuery: operator "${op}" does not apply to ${spec.type} filter "${field}"`);
    }
    filters[field] = { type: spec.type, ops, ...(spec.values ? { values: spec.values } : {}) };
  }
  const extra = config.extra && Object.keys(config.extra).length > 0 ? z.object(config.extra) : undefined;
  for (const name of Object.keys(config.extra ?? {})) {
    if (RESERVED.has(name) || name in filters)
      throw new Error(`listQuery: extra parameter "${name}" collides with a list parameter`);
  }
  return Object.freeze({
    sorts: Object.freeze([...config.sorts]),
    defaultSort: Object.freeze([...defaultSort]),
    filters: Object.freeze(filters),
    search: config.search ? Object.freeze([...config.search]) : undefined,
    maxPage,
    extra,
  });
}

/** Finds which filter a query key names and with which operator, or `undefined` when it names none. */
function resolveFilterKey(descriptor: ListQueryDescriptor, key: string): { field: string; op: FilterOp } | undefined {
  if (Object.hasOwn(descriptor.filters, key)) return { field: key, op: 'eq' };
  for (const [suffix, op] of SUFFIXES) {
    if (key.endsWith(suffix)) {
      const field = key.slice(0, -suffix.length);
      if (Object.hasOwn(descriptor.filters, field)) return { field, op };
    }
  }
  return undefined;
}

function parse(
  descriptor: ListQueryDescriptor,
  raw: Record<string, unknown>,
  ctx: z.RefinementCtx,
): ParsedListQuery<string, unknown> | typeof z.NEVER {
  let failed = false;
  const fail = (path: string, message: string, values?: readonly string[]) => {
    failed = true;
    if (values) ctx.addIssue({ code: 'invalid_value', values: [...values], path: [path], message });
    else ctx.addIssue({ code: 'custom', path: [path], message });
  };
  const single = (key: string): string | undefined => {
    const texts = textsOf(raw[key]);
    if (raw[key] === undefined) return undefined;
    if (!texts || texts.length !== 1) {
      fail(key, 'Send this parameter once.');
      return undefined;
    }
    return texts[0];
  };

  // Range: _start (0-based, inclusive), _end (exclusive); default page 0-25.
  const startText = single('_start');
  const endText = single('_end');
  let start = 0;
  if (startText !== undefined) {
    const value = parseInteger(startText, 0, MAX_OFFSET);
    if (value === undefined) fail('_start', `Must be a whole number from 0 to ${MAX_OFFSET}.`);
    else start = value;
  }
  let end = start + DEFAULT_PAGE_SIZE;
  if (endText !== undefined) {
    const value = parseInteger(endText, 1, MAX_OFFSET + descriptor.maxPage);
    if (value === undefined) fail('_end', 'Must be a whole number greater than 0.');
    else if (value <= start) fail('_end', 'Must be greater than _start.');
    else if (value - start > descriptor.maxPage) fail('_end', `A page can hold at most ${descriptor.maxPage} rows.`);
    else end = value;
  }

  // Sort: comma-separated fields with comma-separated directions in the same order.
  const sortTexts = textsOf(raw._sort) ?? [];
  const orderTexts = textsOf(raw._order) ?? [];
  if (raw._sort !== undefined && !textsOf(raw._sort)) fail('_sort', 'Must be a comma-separated list of fields.');
  if (raw._order !== undefined && !textsOf(raw._order))
    fail('_order', 'Must be a comma-separated list of asc or desc.');
  const fields = sortTexts
    .flatMap((text) => text.split(','))
    .map((text) => text.trim())
    .filter(Boolean);
  const orders = orderTexts
    .flatMap((text) => text.split(','))
    .map((text) => text.trim().toLowerCase())
    .filter(Boolean);
  let sort: ListSort[] = [...descriptor.defaultSort];
  if (fields.length > 0) {
    sort = [];
    if (fields.length > MAX_SORT_FIELDS) fail('_sort', `Sort by at most ${MAX_SORT_FIELDS} fields.`);
    if (orders.length > fields.length) fail('_order', 'There are more directions than sort fields.');
    fields.forEach((field, index) => {
      if (!descriptor.sorts.includes(field)) {
        fail('_sort', `Unknown sort field "${field}". Allowed: ${descriptor.sorts.join(', ')}.`, descriptor.sorts);
        return;
      }
      const order = orders[index] ?? 'asc';
      if (order !== 'asc' && order !== 'desc') {
        fail('_order', `Unknown direction "${order}". Use asc or desc.`, ['asc', 'desc']);
        return;
      }
      if (!sort.some((existing) => existing.field === field)) sort.push({ field, order });
    });
  }

  // Search text.
  let search: ParsedListQuery['search'];
  const searchText = single('q')?.trim();
  if (searchText) {
    if (!descriptor.search) fail('q', 'This list does not support search.');
    else if (searchText.length > MAX_TEXT_LENGTH) fail('q', `Must be at most ${MAX_TEXT_LENGTH} characters.`);
    else search = { text: searchText, fields: descriptor.search };
  }

  // Extra parameters of the endpoint, then filters; everything else is an unknown parameter.
  const extraKeys = new Set(descriptor.extra ? Object.keys(descriptor.extra.shape) : []);
  const filters: ParsedFilter[] = [];
  for (const key of Object.keys(raw)) {
    if (RESERVED.has(key) || extraKeys.has(key)) continue;
    const target = resolveFilterKey(descriptor, key);
    if (!target) {
      failed = true;
      ctx.addIssue({ code: 'unrecognized_keys', keys: [key], path: [], message: `Unknown parameter "${key}".` });
      continue;
    }
    const spec = descriptor.filters[target.field]!;
    if (!spec.ops.includes(target.op)) {
      fail(
        key,
        `"${target.field}" cannot be filtered with ${target.op === 'eq' ? 'an exact value' : SUFFIX_OF[target.op]}. Allowed: ${spec.ops.map((op) => `${target.field}${SUFFIX_OF[op]}`).join(', ')}.`,
      );
      continue;
    }
    const texts = textsOf(raw[key]);
    if (!texts) {
      fail(key, 'Must be a value or a repeated key.');
      continue;
    }
    // Empty values are skipped, as the console does not send them.
    const given = texts.filter((text) => text !== '');
    if (given.length === 0) continue;
    if (given.length > 1 && target.op !== 'eq' && target.op !== 'ne') {
      fail(key, 'Repeat a key only for exact (IN) or _ne (NOT IN) filters.');
      continue;
    }
    if (given.length > MAX_IN_VALUES) {
      fail(key, `Send at most ${MAX_IN_VALUES} values.`);
      continue;
    }
    const values: FilterValue[] = [];
    for (const text of given) {
      const converted = convert(spec, text);
      if (converted.ok) values.push(converted.value);
      else fail(key, converted.message, spec.type === 'enum' ? spec.values : undefined);
    }
    if (values.length === given.length) filters.push({ field: target.field, op: target.op, values });
  }

  let extra: unknown = {};
  if (descriptor.extra) {
    const picked: Record<string, unknown> = {};
    for (const key of extraKeys) if (raw[key] !== undefined) picked[key] = raw[key];
    const result = descriptor.extra.safeParse(picked);
    if (result.success) extra = result.data;
    else {
      failed = true;
      for (const issue of result.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  }

  if (failed) return z.NEVER;
  return { range: { start, end, limit: end - start }, sort, filters, search, extra };
}

/**
 * Builds the zod schema of a list endpoint's query string (simple-rest dialect, ALIGNMENT § 2).
 *
 * Why: the console sends `_start/_end`, `_sort/_order`, `q` and field filters with the suffixes `_ne _gte _lte _gt
 * _lt _like` (a repeated key means IN, `_ne` repeated NOT IN). Every list endpoint whitelists its sorts and filters;
 * an unknown sort field, filter or operator is `422 VALIDATION_FAILED` naming the parameter. The handler gets a typed
 * object and returns `{ rows, total }`; the response interceptor answers the array and `x-total-count`.
 *
 * @param config the endpoint's sorts, default sort, filters, search fields, page limit and extra parameters
 * @returns a schema for `defineRoute({ query })`; do not chain `.meta()` on it (the clone would lose the list marker)
 * @throws {Error} at definition time when the configuration is inconsistent (programming error)
 *
 * @example
 * const staffList = listQuery({
 *   sorts: ['name', 'createdAt'],
 *   defaultSort: { field: 'createdAt', order: 'desc' },
 *   filters: { status: { type: 'enum', values: ['active', 'suspended'] }, createdAt: { type: 'datetime' } },
 *   search: ['name', 'email'],
 * });
 */
export function listQuery<const S extends string, X extends z.ZodRawShape = Record<never, never>>(
  config: ListQueryConfig<S, X>,
): ListQuerySchema<S, z.output<z.ZodObject<X>>> {
  const descriptor = buildDescriptor(config);
  const schema = z.record(z.string(), z.unknown()).transform((raw, ctx) => parse(descriptor, raw, ctx));
  return Object.assign(schema, { [LIST_QUERY]: descriptor }) as unknown as ListQuerySchema<S, z.output<z.ZodObject<X>>>;
}

/**
 * One documented query parameter of a list endpoint.
 *
 * Why: every parameter of the dialect (range, sort, search, each filter and operator) appears in the OpenAPI document.
 */
export interface ListQueryParameter {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  /** Repeating the key is allowed (IN / NOT IN). */
  readonly repeatable: boolean;
}

function filterItemSchema(spec: { type: FilterType; values?: readonly string[] }): JsonSchema {
  switch (spec.type) {
    case 'enum':
      return { type: 'string', enum: [...(spec.values ?? [])] };
    case 'boolean':
      return { type: 'string', enum: ['true', 'false'] };
    case 'number':
      return { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' };
    case 'decimal':
      return { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' };
    case 'id':
      return { type: 'string', pattern: '^[1-9]\\d{0,15}$' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'string':
      return { type: 'string', maxLength: MAX_TEXT_LENGTH };
  }
}

/**
 * Lists the query parameters a list endpoint accepts, for the OpenAPI document.
 *
 * Why: the zod schema is a transform over a free-form object, so the generic converter cannot describe the dialect.
 *
 * @param schema a schema returned by {@link listQuery}
 * @returns one entry per documented parameter (range, sort, search, every filter and operator, extras)
 */
export function listQueryParameters(schema: ListQueryBrand): ListQueryParameter[] {
  const d = describeListQuery(schema);
  const out: ListQueryParameter[] = [
    {
      name: '_start',
      description: 'First row to return (0-based, inclusive). Default 0.',
      schema: { type: 'integer', minimum: 0, maximum: MAX_OFFSET },
      repeatable: false,
    },
    {
      name: '_end',
      description: `Row after the last one to return (exclusive). Default _start + ${DEFAULT_PAGE_SIZE}; a page holds at most ${d.maxPage} rows.`,
      schema: { type: 'integer', minimum: 1 },
      repeatable: false,
    },
    {
      name: '_sort',
      description: `Comma-separated sort fields. Allowed: ${d.sorts.join(', ')}. Default: ${d.defaultSort.map((s) => `${s.field} ${s.order}`).join(', ')}.`,
      schema: { type: 'string' },
      repeatable: false,
    },
    {
      name: '_order',
      description: 'Comma-separated directions (asc or desc), one per sort field in the same order.',
      schema: { type: 'string' },
      repeatable: false,
    },
  ];
  if (d.search) {
    out.push({
      name: 'q',
      description: `Case-insensitive text search over: ${d.search.join(', ')}.`,
      schema: { type: 'string', maxLength: MAX_TEXT_LENGTH },
      repeatable: false,
    });
  }
  for (const [field, spec] of Object.entries(d.filters)) {
    for (const op of spec.ops) {
      const many = op === 'eq' || op === 'ne';
      const meaning: Record<FilterOp, string> = {
        eq: 'equals (repeat the key for IN)',
        ne: 'is not (repeat the key for NOT IN)',
        gte: 'is greater than or equal to',
        lte: 'is less than or equal to',
        gt: 'is greater than',
        lt: 'is less than',
        like: 'contains (case-insensitive)',
      };
      out.push({
        name: `${field}${SUFFIX_OF[op]}`,
        description: `Keep rows where ${field} ${meaning[op]} the value.`,
        schema: filterItemSchema(spec),
        repeatable: many,
      });
    }
  }
  if (d.extra) {
    const json = toJsonSchema(d.extra, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, property] of Object.entries(json.properties ?? {})) {
      out.push({
        name,
        description: typeof property.description === 'string' ? property.description : `Endpoint parameter ${name}.`,
        schema: property,
        repeatable: false,
      });
    }
  }
  return out;
}
