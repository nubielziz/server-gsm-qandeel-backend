// The contract comparator (docs/contract/TESTS.md § 2, decision 009): compares what the frontend reads or sends with
// the backend's JSON Schema and reports every difference with a path and a rule name. Pure functions, no I/O.
import type { JsonSchema } from '../../../src/common/contract';
import {
  type Alias,
  type FrontendShape,
  type TypeNode,
  type Variant,
  fromFrontendShape,
  fromJsonSchema,
} from './normalize';

/**
 * Every rule a difference can name; an allowlist entry cites one of these (`test/contract/allowlist.ts`).
 *
 * Why: stable names let a deviation be accepted precisely (route, part, path, rule) and keep the report readable.
 */
export const RULES = [
  'required', // a field is optional on the producing side but required by the consuming side
  'missing-field', // a field the consumer needs (or the sender adds) is not declared on the other side
  'extra-field', // a field the producer sends that the consumer does not declare (reported, never failing)
  'type', // different kinds: string vs number, object vs string, ...
  'alias', // Money / Decimal / IsoDateTime / Id mismatch
  'enum', // a value outside the other side's value set
  'nullable', // null is possible on the producing side but not accepted by the consuming side
  'array', // an array on one side only
  'record', // a free-form map on one side and fixed fields on the other
  'unconstrained', // the producing schema accepts anything, so it cannot be proven to fit
  'list-result', // `ListResult<T>` needs an array body plus `x-total-count`
  'status', // success status differs from what the frontend contract documents
  'fixture', // a harvested fixture does not satisfy the backend schema
] as const;

/** The name of a comparison rule. */
export type Rule = (typeof RULES)[number];

/**
 * One difference between the frontend and the backend.
 *
 * Why: the failure message and the allowlist both work on `(path, rule)`; `info` differences are listed but never fail.
 */
export interface Difference {
  /** Dotted path from the compared root; `[]` marks array items and `.*` map values (`data[].status`, `checks.*`). */
  readonly path: string;
  readonly rule: Rule;
  /** `error` fails the test unless allowlisted; `info` is only reported. */
  readonly severity: 'error' | 'info';
  readonly message: string;
}

/**
 * Which way values flow.
 *
 * Why: in a `response` the backend produces and the frontend consumes; in a `request` the frontend produces and the
 * backend consumes. The same subtype rules apply with the roles swapped.
 */
export type Direction = 'response' | 'request';

/** How to compare one shape with one schema. */
export interface CompareOptions {
  readonly direction: Direction;
  /**
   * Path and query values travel as text: numbers, booleans and strings are interchangeable and enum values are
   * compared as strings. Bodies and responses are JSON (default).
   */
  readonly wire?: boolean;
  /** The document that the schema's `$ref`s point into (default: the schema itself). */
  readonly root?: JsonSchema;
}

interface Ctx {
  readonly direction: Direction;
  readonly wire: boolean;
  readonly diffs: Difference[];
}

const MAX_DEPTH = 40;

/** Names of the producing side (`sub`) and the consuming side (`sup`) in a message. */
function sides(ctx: Ctx): { sub: string; sup: string } {
  return ctx.direction === 'response' ? { sub: 'backend', sup: 'frontend' } : { sub: 'frontend', sup: 'backend' };
}

function join(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

/** The path of the values of a map: `checks.*`. */
const mapValue = (path: string): string => join(path, '*');

function report(ctx: Ctx, path: string, rule: Rule, message: string, severity: 'error' | 'info' = 'error'): void {
  ctx.diffs.push({ path, rule, severity, message });
}

const quote = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/** A short phrase for a variant, for messages ("a string", "an Id", "one of "a" | "b""). */
function describe(variant: Variant): string {
  switch (variant.kind) {
    case 'string':
      if (variant.values) return `one of ${variant.values.map(quote).join(' | ')}`;
      return variant.alias ? `a ${variant.alias} string` : 'a string';
    case 'number':
      if (variant.values) return `one of ${variant.values.join(' | ')}`;
      return variant.alias ? `an ${variant.alias}` : variant.integer ? 'an integer' : 'a number';
    case 'boolean':
      return variant.values ? `${variant.values.join(' | ')}` : 'a boolean';
    case 'object':
      return variant.props.size === 0 && variant.record ? 'a map' : 'an object';
    case 'array':
      return 'an array';
    case 'tuple':
      return 'a tuple';
    case 'json':
      return variant.objectOnly ? 'a JSON object' : 'any JSON value';
    case 'any':
      return 'anything';
  }
}

const describeAll = (variants: readonly Variant[]): string =>
  variants.length === 0 ? 'only null' : variants.map(describe).join(' or ');

/** Is `sub` an alias that a `sup`-aliased consumer accepts? `Money` is a `Decimal`; the rest only match themselves. */
function aliasFits(sub: Alias | undefined, sup: Alias): boolean {
  return sub === sup || (sub === 'Money' && sup === 'Decimal');
}

function checkAlias(
  sub: Extract<Variant, { kind: 'string' | 'number' }>,
  sup: Extract<Variant, { kind: 'string' | 'number' }>,
  path: string,
  ctx: Ctx,
): void {
  if (!sup.alias) return;
  // A number is an Id when the backend sends an integer: zod's `z.number().int()` has no marker, `zId` has.
  if (sup.alias === 'Id' && sub.kind === 'number' && (sub.alias === 'Id' || sub.integer)) return;
  // The console has no date-only type (ALIGNMENT § 1): its `YYYY-MM-DD` params (report and audit ranges) are plain
  // strings, so a backend `DateOnly` accepts an unmarked string. Requests only: in a response the backend must prove the
  // format. A string with another alias (`IsoDateTime`) still differs.
  if (ctx.direction === 'request' && sup.alias === 'DateOnly' && sub.kind === 'string' && sub.alias === undefined)
    return;
  if (aliasFits(sub.alias, sup.alias)) return;
  const { sub: from, sup: to } = sides(ctx);
  report(ctx, path, 'alias', `${to} expects ${sup.alias}, ${from} sends ${sub.alias ?? describe(sub)}`);
}

function checkValues(
  sub: readonly (string | number | boolean)[] | undefined,
  sup: readonly (string | number | boolean)[] | undefined,
  path: string,
  ctx: Ctx,
  subVariant: Variant,
): void {
  if (!sup) return;
  const { sub: from, sup: to } = sides(ctx);
  const text = (value: string | number | boolean): string => String(value);
  if (!sub) {
    report(
      ctx,
      path,
      'enum',
      `${from} sends ${describe(subVariant)}; ${to} accepts only ${sup.map(quote).join(' | ')}`,
    );
    return;
  }
  const allowed = new Set(ctx.wire ? sup.map(text) : sup);
  const outside = sub.filter((value) => !allowed.has(ctx.wire ? text(value) : value));
  if (outside.length === 0) return;
  const known = ctx.direction === 'response' ? 'unknown to the frontend' : 'not accepted by the backend';
  report(ctx, path, 'enum', `${from} value${outside.length > 1 ? 's' : ''} ${outside.map(quote).join(', ')} ${known}`);
}

const SCALARS = ['string', 'number', 'boolean'];

function checkObject(
  sub: Extract<Variant, { kind: 'object' }>,
  sup: Extract<Variant, { kind: 'object' }>,
  path: string,
  ctx: Ctx,
  depth: number,
): void {
  const { sub: from, sup: to } = sides(ctx);
  // A free-form map cannot promise fixed fields.
  if (sub.props.size === 0 && sub.record && sup.props.size > 0 && !sup.record) {
    report(ctx, path, 'record', `${from} sends a free-form map where the ${to} expects fixed fields`);
    return;
  }
  for (const [name, expected] of sup.props) {
    const at = join(path, name);
    const given = sub.props.get(name);
    if (!given) {
      if (sub.record) {
        if (!expected.optional)
          report(ctx, at, 'required', `${from}'s map may not contain "${name}", which the ${to} requires`);
      } else if (!expected.optional) {
        const message =
          ctx.direction === 'response'
            ? `the frontend reads "${name}" but the backend never sends it`
            : `the backend requires "${name}" but the frontend never sends it`;
        report(ctx, at, 'missing-field', message);
      } else if (ctx.direction === 'response') {
        report(ctx, at, 'missing-field', `the frontend may read "${name}" but the backend never sends it`, 'info');
      }
      continue;
    }
    // A producer that may omit a field breaks a consumer that requires it; a default makes a backend producer safe.
    const mayOmit = given.optional && !(ctx.direction === 'response' && given.defaulted);
    // For a backend consumer a field with a default is optional.
    const requires = !expected.optional && !(ctx.direction === 'request' && expected.defaulted);
    if (requires && mayOmit) {
      const message =
        ctx.direction === 'response'
          ? `the frontend reads "${name}" as required but the backend may omit it`
          : `the backend requires "${name}" but the frontend may omit it`;
      report(ctx, at, 'required', message);
    }
    check(given.node, expected.node, at, ctx, depth + 1);
  }
  for (const [name, given] of sub.props) {
    if (sup.props.has(name)) continue;
    const at = join(path, name);
    if (sup.record) {
      check(given.node, sup.record, at, ctx, depth + 1);
    } else if (ctx.direction === 'response') {
      report(ctx, at, 'extra-field', `backend sends "${name}", which the frontend type does not declare`, 'info');
    } else {
      report(ctx, at, 'missing-field', `the frontend sends "${name}" but the backend does not declare it`);
    }
  }
  if (sub.record && sup.record) check(sub.record, sup.record, mapValue(path), ctx, depth + 1);
}

function checkVariants(sub: Variant, sup: Variant, path: string, ctx: Ctx, depth: number): void {
  const { sub: from, sup: to } = sides(ctx);
  if (sup.kind === 'any') return;
  if (sub.kind === 'any') {
    if (sub.cut || (sup.kind === 'json' && !sup.objectOnly)) return;
    report(
      ctx,
      path,
      'unconstrained',
      `${from}'s schema accepts anything here, so it cannot be proven to fit ${describe(sup)}`,
    );
    return;
  }
  if (sup.kind === 'json') {
    if (!sup.objectOnly || sub.kind === 'object' || (sub.kind === 'json' && sub.objectOnly)) return;
    report(ctx, path, 'type', `${from} sends ${describe(sub)} where the ${to} expects a JSON object`);
    return;
  }
  if (sub.kind === 'json') {
    report(ctx, path, 'type', `${from} sends ${describe(sub)} where the ${to} expects ${describe(sup)}`);
    return;
  }
  if (sub.kind === sup.kind) {
    switch (sub.kind) {
      case 'string':
      case 'number': {
        const target = sup as typeof sub;
        checkAlias(sub, target, path, ctx);
        checkValues(sub.values, target.values, path, ctx, sub);
        return;
      }
      case 'boolean':
        checkValues(sub.values, (sup as typeof sub).values, path, ctx, sub);
        return;
      case 'object':
        checkObject(sub, sup as typeof sub, path, ctx, depth);
        return;
      case 'array':
        check(sub.items, (sup as typeof sub).items, `${path}[]`, ctx, depth + 1);
        return;
      case 'tuple': {
        const target = sup as typeof sub;
        if (sub.items.length !== target.items.length) {
          report(
            ctx,
            path,
            'array',
            `${from} sends a tuple of ${sub.items.length}; the ${to} expects ${target.items.length}`,
          );
        }
        sub.items.forEach((item, index) => {
          const other = target.items[index];
          if (other) check(item, other, `${path}[${index}]`, ctx, depth + 1);
        });
        return;
      }
    }
    return;
  }
  // Text on the wire: path and query values may be written as any scalar.
  if (ctx.wire && SCALARS.includes(sub.kind) && SCALARS.includes(sup.kind)) {
    const subValues = 'values' in sub ? sub.values : undefined;
    const supValues = 'values' in sup ? sup.values : undefined;
    checkValues(subValues, supValues, path, ctx, sub);
    if (sub.kind !== 'boolean' && sup.kind !== 'boolean') {
      checkAlias(
        sub as Extract<Variant, { kind: 'string' | 'number' }>,
        sup as Extract<Variant, { kind: 'string' | 'number' }>,
        path,
        ctx,
      );
    }
    return;
  }
  const rule: Rule =
    sub.kind === 'array' || sup.kind === 'array' || sub.kind === 'tuple' || sup.kind === 'tuple' ? 'array' : 'type';
  report(ctx, path, rule, `${from} sends ${describe(sub)} where the ${to} expects ${describe(sup)}`);
}

function trial(ctx: Ctx): Ctx {
  return { direction: ctx.direction, wire: ctx.wire, diffs: [] };
}

function check(sub: TypeNode, sup: TypeNode, path: string, ctx: Ctx, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const { sub: from, sup: to } = sides(ctx);
  if (sub.nullable && !sup.nullable) {
    report(
      ctx,
      path,
      'nullable',
      ctx.direction === 'response'
        ? 'backend may send null, the frontend type is not nullable'
        : `${from} may send null, the ${to} does not accept null`,
    );
  }
  for (const variant of sub.variants) {
    if (sup.variants.length === 0) {
      report(ctx, path, 'type', `${from} sends ${describe(variant)} where the ${to} accepts only null`);
      continue;
    }
    if (sup.variants.length === 1) {
      checkVariants(variant, sup.variants[0] as Variant, path, ctx, depth);
      continue;
    }
    // A union: the value fits when any alternative accepts it; otherwise explain against the closest one.
    let accepted = false;
    const attempts: Ctx[] = [];
    for (const candidate of sup.variants) {
      const attempt = trial(ctx);
      checkVariants(variant, candidate, path, attempt, depth);
      attempts.push(attempt);
      if (!attempt.diffs.some((d) => d.severity === 'error')) {
        ctx.diffs.push(...attempt.diffs);
        accepted = true;
        break;
      }
    }
    if (accepted) continue;
    const sameKind = sup.variants.findIndex((candidate) => candidate.kind === variant.kind);
    if (sameKind >= 0) ctx.diffs.push(...(attempts[sameKind] as Ctx).diffs);
    else
      report(
        ctx,
        path,
        'type',
        `${from} sends ${describe(variant)} where the ${to} expects ${describeAll(sup.variants)}`,
      );
  }
}

/**
 * Compares a frontend shape with a backend JSON Schema.
 *
 * Why: this is the heart of decision 009: the rules of TESTS.md § 2 (required fields, types, aliases, enum subset,
 * nullability, arrays, records) applied in the direction the data flows.
 *
 * @param frontend a shape from `frontend-endpoints.json` (a return type, a body or a query object)
 * @param backend the route's JSON Schema (`toJsonSchema(schema, 'output')` for a response, `'input'` for a request)
 * @param options the direction (`response`: the backend produces; `request`: the frontend produces), wire mode, `$ref` root
 * @returns every difference, errors and infos, in walk order; empty when the two agree
 */
export function compareShape(frontend: FrontendShape, backend: unknown, options: CompareOptions): Difference[] {
  const ctx: Ctx = { direction: options.direction, wire: options.wire === true, diffs: [] };
  const fe = fromFrontendShape(frontend);
  const be = fromJsonSchema(backend, options.root ?? (isRootSchema(backend) ? backend : {}));
  if (options.direction === 'response') check(be, fe, '', ctx, 0);
  else check(fe, be, '', ctx, 0);
  return ctx.diffs;
}

function isRootSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
