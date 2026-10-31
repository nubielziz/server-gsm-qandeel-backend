// Common tree the contract comparator works on (docs/contract/TESTS.md § 2): a frontend shape (the JSON of
// docs/contract/frontend-endpoints.json) and a backend JSON Schema (zod -> JSON Schema 2020-12, `x-gsm-alias`
// markers) are both turned into the same small type tree, so one function can compare them in either direction.
import type { JsonSchema } from '../../../src/common/contract';

/**
 * The wire types of ALIGNMENT § 1 that carry a name in the frontend (`Id`, `Money`, ...) and an `x-gsm-alias` marker in
 * the backend (`src/common/contract/zod.ts`).
 */
export type Alias = 'Id' | 'Money' | 'Decimal' | 'IsoDateTime' | 'DateOnly';

/** Every alias, for membership tests. */
export const ALIASES: readonly string[] = ['Id', 'Money', 'Decimal', 'IsoDateTime', 'DateOnly'];

/**
 * One node of the frontend shape format written by `scripts/extract-frontend-contract.mjs`.
 *
 * Why: the extraction describes the frontend's TypeScript types as plain JSON; the comparator reads exactly this.
 */
export interface FrontendShape {
  /** `string`, `number`, `boolean`, `null`, `undefined`, `json` (JsonValue/JsonObject), `any`, or an opaque type name. */
  readonly type?: string;
  readonly const?: string | number | boolean;
  readonly enum?: readonly (string | number)[];
  readonly array?: FrontendShape;
  readonly tuple?: readonly FrontendShape[];
  readonly object?: Readonly<Record<string, FrontendShape>>;
  /** Index signature (`Record<string, T>`): the value shape. */
  readonly record?: FrontendShape;
  readonly anyOf?: readonly FrontendShape[];
  readonly nullable?: boolean;
  /** `T | undefined`: cannot travel in JSON, so it behaves like an optional property. */
  readonly undefinable?: boolean;
  readonly optional?: boolean;
  readonly alias?: string;
  /** A type the extraction did not expand (recursion) or cut at its depth limit. */
  readonly ref?: string;
  readonly truncated?: string;
}

/** A property of an object node. */
export interface Prop {
  readonly node: TypeNode;
  /** The key may be absent (frontend `?:`/`| undefined`; backend: not in `required`). */
  readonly optional: boolean;
  /** Backend only: the schema carries a `default`, so a producer always sends it and a consumer may omit it. */
  readonly defaulted: boolean;
}

/** One alternative of a {@link TypeNode}. */
export type Variant =
  | { readonly kind: 'string'; readonly alias?: Alias; readonly values?: readonly string[] }
  | {
      readonly kind: 'number';
      readonly alias?: Alias;
      readonly integer: boolean;
      readonly values?: readonly number[];
    }
  | { readonly kind: 'boolean'; readonly values?: readonly boolean[] }
  | { readonly kind: 'object'; readonly props: ReadonlyMap<string, Prop>; readonly record?: TypeNode }
  | { readonly kind: 'array'; readonly items: TypeNode }
  | { readonly kind: 'tuple'; readonly items: readonly TypeNode[] }
  /** A free-form JSON value (`JsonValue`), or only an object (`JsonObject`). */
  | { readonly kind: 'json'; readonly objectOnly: boolean }
  /** Unconstrained (`z.unknown()`, `{}`); `cut` marks a recursive reference the walk stopped following. */
  | { readonly kind: 'any'; readonly cut: boolean };

/**
 * A type: a set of alternatives plus nullability.
 *
 * Why: unions, `T | null` and optional values all reduce to this, so the comparator has one rule per kind.
 */
export interface TypeNode {
  readonly variants: readonly Variant[];
  readonly nullable: boolean;
}

const MONEY_PATTERN = '^-?\\d+\\.\\d{4}$';
const DECIMAL_PATTERN = '^-?\\d+(\\.\\d+)?$';
const MAX_SCHEMA_DEPTH = 24;

/** The node for "anything": used where a type cannot be read. */
const ANY: TypeNode = { variants: [{ kind: 'any', cut: false }], nullable: false };
const CUT: TypeNode = { variants: [{ kind: 'any', cut: true }], nullable: false };

function isAlias(value: unknown): value is Alias {
  return typeof value === 'string' && ALIASES.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function constVariant(value: string | number | boolean): Variant {
  if (typeof value === 'string') return { kind: 'string', values: [value] };
  if (typeof value === 'number') return { kind: 'number', integer: Number.isInteger(value), values: [value] };
  return { kind: 'boolean', values: [value] };
}

/** Groups a list of constants by JavaScript type: `['a', 1]` is a string variant and a number variant. */
function valueVariants(values: readonly unknown[]): { variants: Variant[]; nullable: boolean } {
  const strings = values.filter((v): v is string => typeof v === 'string');
  const numbers = values.filter((v): v is number => typeof v === 'number');
  const booleans = values.filter((v): v is boolean => typeof v === 'boolean');
  const variants: Variant[] = [];
  if (strings.length > 0) variants.push({ kind: 'string', values: strings });
  if (numbers.length > 0) variants.push({ kind: 'number', integer: numbers.every(Number.isInteger), values: numbers });
  if (booleans.length > 0) variants.push({ kind: 'boolean', values: booleans });
  return { variants, nullable: values.includes(null) };
}

/**
 * Turns a frontend shape into the common tree.
 *
 * Why: the comparator reasons about one tree type; this is the frontend half of that conversion.
 *
 * @param shape a shape from `frontend-endpoints.json`
 * @returns the equivalent type tree (`optional` is a property of the parent object, not of the node)
 */
export function fromFrontendShape(shape: FrontendShape): TypeNode {
  const variants: Variant[] = [];
  let nullable = shape.nullable === true;
  const alias = isAlias(shape.alias) ? shape.alias : undefined;

  if (shape.anyOf) {
    for (const part of shape.anyOf) {
      const inner = fromFrontendShape(part);
      variants.push(...inner.variants);
      nullable ||= inner.nullable;
    }
  } else if (shape.const !== undefined) {
    variants.push(constVariant(shape.const));
  } else if (shape.enum) {
    variants.push(...valueVariants(shape.enum).variants);
  } else if (shape.array) {
    variants.push({ kind: 'array', items: fromFrontendShape(shape.array) });
  } else if (shape.tuple) {
    variants.push({ kind: 'tuple', items: shape.tuple.map(fromFrontendShape) });
  } else if (shape.object || shape.record) {
    const props = new Map<string, Prop>();
    for (const [name, child] of Object.entries(shape.object ?? {})) {
      props.set(name, {
        node: fromFrontendShape(child),
        optional: child.optional === true || child.undefinable === true,
        defaulted: false,
      });
    }
    variants.push({
      kind: 'object',
      props,
      ...(shape.record ? { record: fromFrontendShape(shape.record) } : {}),
    });
  } else {
    switch (shape.type ?? '') {
      case 'string':
        variants.push({ kind: 'string', ...(alias && alias !== 'Id' ? { alias } : {}) });
        break;
      case 'number':
        variants.push({ kind: 'number', integer: alias === 'Id', ...(alias === 'Id' ? { alias } : {}) });
        break;
      case 'boolean':
        variants.push({ kind: 'boolean' });
        break;
      case 'null':
        nullable = true;
        break;
      case 'undefined':
        break;
      case 'json':
        variants.push({ kind: 'json', objectOnly: shape.alias === 'JsonObject' });
        break;
      default:
        // `any`, `unknown`, opaque types (AbortSignal, function) and cut references: nothing to compare.
        variants.push({ kind: 'any', cut: shape.ref !== undefined || shape.truncated !== undefined });
    }
  }
  return { variants, nullable };
}

/** Follows a local `$ref` (`#`, `#/$defs/x`, `#/components/schemas/x`) in the root document. */
function resolveRef(ref: string, root: JsonSchema): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    current = current[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return current;
}

function stringAlias(schema: Record<string, unknown>): Alias | undefined {
  const marker = schema['x-gsm-alias'];
  if (isAlias(marker)) return marker;
  if (schema.format === 'date-time') return 'IsoDateTime';
  if (schema.format === 'date') return 'DateOnly';
  if (schema.pattern === MONEY_PATTERN) return 'Money';
  if (schema.pattern === DECIMAL_PATTERN) return 'Decimal';
  return undefined;
}

function mergeNodes(parts: readonly TypeNode[]): TypeNode {
  const objects = parts.map((part) => (part.variants.length === 1 ? part.variants[0] : undefined));
  if (!objects.every((v) => v?.kind === 'object')) return parts[0] ?? ANY;
  const props = new Map<string, Prop>();
  let record: TypeNode | undefined;
  for (const variant of objects) {
    if (variant?.kind !== 'object') continue;
    record ??= variant.record;
    for (const [name, prop] of variant.props) {
      const known = props.get(name);
      props.set(name, known ? { ...known, optional: known.optional && prop.optional } : prop);
    }
  }
  return {
    variants: [{ kind: 'object', props, ...(record ? { record } : {}) }],
    nullable: parts.every((p) => p.nullable),
  };
}

function objectVariant(schema: Record<string, unknown>, root: JsonSchema, depth: number, seen: string[]): Variant {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = new Map<string, Prop>();
  for (const [name, child] of Object.entries(properties)) {
    props.set(name, {
      node: fromJsonSchema(child, root, depth + 1, seen),
      optional: !required.includes(name),
      defaulted: isRecord(child) && 'default' in child,
    });
  }
  const extra = schema.additionalProperties;
  let record: TypeNode | undefined;
  if (extra === true || (Object.keys(properties).length === 0 && extra === undefined && schema.type === 'object')) {
    record = ANY;
  } else if (isRecord(extra)) {
    record = fromJsonSchema(extra, root, depth + 1, seen);
  }
  return { kind: 'object', props, ...(record ? { record } : {}) };
}

/**
 * Turns a backend JSON Schema (zod's output) into the common tree.
 *
 * Why: the comparator reasons about one tree type; this is the backend half of that conversion. It understands what
 * zod emits: `type` as a string or a list, `anyOf`/`oneOf` unions, `allOf`, `enum`/`const`, `$ref` to `#`, `$defs` or
 * `components`, `prefixItems`, and the `x-gsm-alias` markers (`Money`, `IsoDateTime`, `Id`, ...).
 *
 * @param schema a JSON Schema node (any JSON value is accepted; booleans and non-objects mean "anything")
 * @param root the document that `$ref`s point into (default: the schema itself)
 * @param depth recursion depth, used to stop on deep or recursive schemas
 * @param seen the `$ref`s being expanded right now (cuts recursion)
 * @returns the equivalent type tree
 */
export function fromJsonSchema(
  schema: unknown,
  root: JsonSchema = isRecord(schema) ? schema : {},
  depth = 0,
  seen: string[] = [],
): TypeNode {
  if (schema === false) return { variants: [], nullable: false };
  if (!isRecord(schema)) return ANY;
  if (depth > MAX_SCHEMA_DEPTH) return CUT;

  if (typeof schema.$ref === 'string') {
    if (seen.includes(schema.$ref)) return CUT;
    const target = resolveRef(schema.$ref, root);
    return target === undefined ? ANY : fromJsonSchema(target, root, depth + 1, [...seen, schema.$ref]);
  }

  const alias = schema['x-gsm-alias'];
  if (alias === 'JsonObject' || alias === 'JsonValue') {
    return { variants: [{ kind: 'json', objectOnly: alias === 'JsonObject' }], nullable: false };
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const variants: Variant[] = [];
    let nullable = false;
    for (const part of union) {
      const inner = fromJsonSchema(part, root, depth + 1, seen);
      variants.push(...inner.variants);
      nullable ||= inner.nullable;
    }
    return { variants, nullable };
  }
  if (Array.isArray(schema.allOf)) {
    return mergeNodes(schema.allOf.map((part) => fromJsonSchema(part, root, depth + 1, seen)));
  }

  if ('const' in schema) {
    const { variants, nullable } = valueVariants([schema.const]);
    return { variants, nullable };
  }
  if (Array.isArray(schema.enum)) {
    const { variants, nullable } = valueVariants(schema.enum);
    return { variants, nullable };
  }

  const declared = schema.type;
  const types: string[] = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === 'string')
    : typeof declared === 'string'
      ? [declared]
      : schema.properties !== undefined
        ? ['object']
        : schema.items !== undefined || schema.prefixItems !== undefined
          ? ['array']
          : [];
  if (types.length === 0) return ANY;

  const variants: Variant[] = [];
  let nullable = false;
  for (const type of types) {
    switch (type) {
      case 'null':
        nullable = true;
        break;
      case 'string': {
        const found = stringAlias(schema);
        variants.push({ kind: 'string', ...(found ? { alias: found } : {}) });
        break;
      }
      case 'integer':
      case 'number': {
        const marker = schema['x-gsm-alias'];
        variants.push({
          kind: 'number',
          integer: type === 'integer',
          ...(marker === 'Id' ? { alias: 'Id' as const } : {}),
        });
        break;
      }
      case 'boolean':
        variants.push({ kind: 'boolean' });
        break;
      case 'array':
        if (Array.isArray(schema.prefixItems)) {
          variants.push({
            kind: 'tuple',
            items: schema.prefixItems.map((item) => fromJsonSchema(item, root, depth + 1, seen)),
          });
        } else {
          variants.push({
            kind: 'array',
            items: schema.items === undefined ? ANY : fromJsonSchema(schema.items, root, depth + 1, seen),
          });
        }
        break;
      case 'object':
        variants.push(objectVariant(schema, root, depth, seen));
        break;
      default:
        variants.push({ kind: 'any', cut: false });
    }
  }
  return { variants, nullable };
}
