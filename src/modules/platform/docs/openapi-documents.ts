// Builds the two OpenAPI 3.1 documents of the API (decisions 008, 009, 017) from the metadata every @Route writes:
// the internal document (every route) and the public one (the Dhru reference).
// Pure functions over plain JSON plus one call into @nestjs/swagger; the generator script and the app share them.
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type AnySupplierCall, supplierCallRegistry } from '../../../common/contract';
import { type AnyDhruAction, dhruActionRegistry } from '../../../common/dhru';
import { describeDhruActions } from './dhru-reference';
import { describeSupplierCalls } from './supplier-calls-reference';
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiTag,
  OpenApiTagGroup,
  PlainObject,
} from './openapi-types';
import { SECURITY_SCHEMES } from './security-schemes';

/**
 * Version of the public contract: `info.version` of both documents.
 *
 * Why: merchants pin their integration to the documented API; bump it on a breaking change of the Dhru reference.
 */
export const API_VERSION = '1.0.0';

const OPENAPI_VERSION = '3.1.0';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
/** Surfaces whose operations the public document keeps: the Dhru Fusion reference (decision 017). */
const PUBLIC_SURFACES: readonly string[] = ['dhru'];
/** Public surfaces come first in the sidebar, then the merchant, storefront and staff surfaces, then plumbing. */
const SURFACE_TITLES: Readonly<Record<string, string>> = {
  dhru: 'Dhru Fusion API',
  client: 'Merchant portal',
  store: 'Storefront (B2C)',
  admin: 'Admin console',
  hooks: 'Incoming webhooks',
  system: 'System',
};
const SURFACE_ORDER = Object.keys(SURFACE_TITLES);
const DOCUMENT_KEY_ORDER = [
  'openapi',
  'jsonSchemaDialect',
  'info',
  'servers',
  'security',
  'tags',
  'x-tagGroups',
  'paths',
  'components',
];
const CONVENTIONS =
  'JSON bodies use camelCase names. Money is a string with exactly four decimals (`"12.4900"`), timestamps are ISO 8601 UTC with milliseconds (`"2026-03-01T09:30:00.000Z"`) and ids are numbers. Errors are `application/problem+json` with a stable `code`; quote the `requestId` when you contact support.';

/**
 * The one server of both documents: the origin that serves them.
 *
 * A relative URL keeps the committed files free of host names, and the "Try it" panel of Scalar then calls the API it was
 * loaded from.
 */
const SERVERS = [{ url: '/', description: 'The server that serves this document' }];

const PUBLIC_INFO = {
  title: 'IMEI-HUB API',
  version: API_VERSION,
  description: [
    'The Dhru Fusion compatible endpoint for GSM merchants.',
    '**Authentication.** The Dhru Fusion endpoint takes the `username` and `apiaccesskey` form fields; a key has an optional IP allowlist and its own rate limit.',
    `**Conventions.** ${CONVENTIONS}`,
  ].join('\n\n'),
};

const INTERNAL_INFO = {
  title: 'IMEI-HUB API: internal reference',
  version: API_VERSION,
  description: [
    'Every route of the API: admin console, merchant portal, storefront, Dhru Fusion, incoming webhooks and system routes. Generated from the route contracts; the public subset is `/openapi.json`.',
    'Each operation shows its access kind (`x-gsm-access`), the permission a staff route needs (`x-gsm-permission`) and the manifest key (`x-gsm-key`).',
    `**Conventions.** ${CONVENTIONS}`,
  ].join('\n\n'),
};

/**
 * The two documents of one build.
 *
 * Why: the app serves both documents and the generator commits both (decision 009), so one build returns them together.
 */
export interface OpenApiDocuments {
  /** Every route, for staff (`GET /reference`). */
  readonly internal: OpenApiDocument;
  /** The Dhru reference, for merchants (`GET /openapi.json`). */
  readonly public: OpenApiDocument;
}

/**
 * What {@link buildOpenApiDocuments} can be told.
 *
 * Why: the generator and the tests can supply the Dhru actions and the supplier calls explicitly; the app uses the process-wide registries.
 */
export interface BuildOptions {
  /** Dhru actions to describe in the Dhru operation; defaults to the process-wide registry. */
  readonly dhruActions?: readonly AnyDhruAction[];
  /** Supplier calls to list in the internal document only; defaults to the process-wide registry. */
  readonly supplierCalls?: readonly AnySupplierCall[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isOperation(value: unknown): value is OpenApiOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks the operations of a `paths` map in method order. */
function* operationsOf(items: Readonly<Record<string, OpenApiPathItem>> | undefined): Generator<OpenApiOperation> {
  for (const item of Object.values(items ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (isOperation(operation)) yield operation;
    }
  }
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Copies an object with its keys in code-unit order (locale-independent, so output is identical everywhere). */
function sortedKeys<T>(object: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => byCodeUnit(a, b)));
}

/**
 * Removes the `$schema` keyword zod adds to JSON Schemas, everywhere in a document, in place.
 *
 * Why: an OpenAPI 3.1 document has one dialect for all its schemas (the OAS default, as no `jsonSchemaDialect` is set);
 * a `$schema` inside a schema is noise that some tools reject (decision 008). A property that is merely named `$schema` holds an object, so it is kept.
 *
 * @param node any JSON value; objects are changed in place
 */
export function stripSchemaKeyword(node: unknown): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) stripSchemaKeyword(item);
    return;
  }
  const object = node as PlainObject;
  if (typeof object.$schema === 'string') delete object.$schema;
  for (const child of Object.values(object)) stripSchemaKeyword(child);
}

/** Yields every `$ref` string inside a JSON value. */
function* refsIn(node: unknown): Generator<string> {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) yield* refsIn(item);
    return;
  }
  for (const [key, child] of Object.entries(node as PlainObject)) {
    if (key === '$ref' && typeof child === 'string') yield child;
    else yield* refsIn(child);
  }
}

/**
 * Collects the components the given nodes reach through `$ref`, directly or through other components.
 *
 * Why: the public document must not carry the internal models that only admin routes use.
 */
function reachableComponents(
  roots: readonly unknown[],
  source: Readonly<Record<string, Record<string, unknown>>> | undefined,
): Record<string, Record<string, unknown>> {
  const found: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  const queue: unknown[] = [...roots];
  while (queue.length > 0) {
    for (const ref of refsIn(queue.pop())) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
      const section = match?.[1];
      const name = match?.[2];
      const target = section !== undefined && name !== undefined ? source?.[section]?.[name] : undefined;
      if (section !== undefined && name !== undefined && target !== undefined) {
        (found[section] ??= {})[name] = clone(target);
        queue.push(target);
      }
    }
  }
  return found;
}

/** Copies the operations whose surface `keep` accepts; an operation without a surface is never kept by the filters. */
function pickPaths(
  raw: OpenApiDocument,
  keep: (surface: string | undefined) => boolean,
): Record<string, OpenApiPathItem> {
  const paths: Record<string, OpenApiPathItem> = {};
  for (const [path, item] of Object.entries(raw.paths)) {
    const kept: OpenApiPathItem = {};
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (isOperation(operation) && keep(operation['x-gsm-surface'])) kept[method] = clone(operation);
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  return paths;
}

/**
 * Names the tags of a document and groups them by surface in the sidebar.
 *
 * Why: a route's tags come from its contract (the map group, by convention) and are not unique across surfaces:
 * `orders` exists for staff and for merchants. A tag used by several surfaces is prefixed with its surface so that the
 * operations of different surfaces never merge; `x-tagGroups` then lists the tags under their surface title.
 */
function organizeTags(doc: OpenApiDocument): void {
  const surfaceOf = (operation: OpenApiOperation) => operation['x-gsm-surface'] ?? 'system';
  const all = [...operationsOf(doc.paths)];
  const surfacesOfTag = new Map<string, Set<string>>();
  for (const operation of all) {
    for (const tag of operation.tags ?? []) {
      const surfaces = surfacesOfTag.get(tag) ?? new Set<string>();
      surfaces.add(surfaceOf(operation));
      surfacesOfTag.set(tag, surfaces);
    }
  }
  const tagsOfSurface = new Map<string, Set<string>>();
  for (const operation of all) {
    const surface = surfaceOf(operation);
    operation.tags = (operation.tags ?? []).map((tag) =>
      (surfacesOfTag.get(tag)?.size ?? 0) > 1 ? `${surface}: ${tag}` : tag,
    );
    const tags = tagsOfSurface.get(surface) ?? new Set<string>();
    for (const tag of operation.tags) tags.add(tag);
    tagsOfSurface.set(surface, tags);
  }
  const rank = (surface: string) => {
    const index = SURFACE_ORDER.indexOf(surface);
    return index < 0 ? SURFACE_ORDER.length : index;
  };
  const surfaces = [...tagsOfSurface.keys()].sort((a, b) => rank(a) - rank(b) || byCodeUnit(a, b));
  const groups: OpenApiTagGroup[] = surfaces.map((surface) => ({
    name: SURFACE_TITLES[surface] ?? surface,
    tags: [...(tagsOfSurface.get(surface) ?? [])].sort(byCodeUnit),
  }));
  const tags: OpenApiTag[] = groups.flatMap((group) => group.tags.map((name) => ({ name })));
  if (tags.length > 0) {
    doc.tags = tags;
    doc['x-tagGroups'] = groups;
  }
}

/** Copies the definitions of the named security schemes; an undefined name is a programming error. */
function definitionsOf(names: Iterable<string>): Record<string, PlainObject> {
  return Object.fromEntries(
    [...names].map((name) => {
      const scheme = SECURITY_SCHEMES[name];
      if (!scheme) throw new Error(`The security scheme "${name}" has no definition (security-schemes.ts)`);
      return [name, clone(scheme)];
    }),
  );
}

/** The security scheme names the operations of a document use; an undefined name is a programming error. */
function usedSecuritySchemes(doc: OpenApiDocument): Set<string> {
  const used = new Set<string>();
  for (const operation of operationsOf(doc.paths)) {
    for (const requirement of operation.security ?? []) {
      for (const name of Object.keys(requirement)) {
        if (!Object.hasOwn(SECURITY_SCHEMES, name)) {
          throw new Error(`Operation ${operation.operationId ?? '?'} uses the undefined security scheme "${name}"`);
        }
        used.add(name);
      }
    }
  }
  return used;
}

/** Puts the keys of a finished document in a fixed order, so the committed files only change when the API does. */
function orderDocument(doc: OpenApiDocument): OpenApiDocument {
  const orderItem = (item: OpenApiPathItem): OpenApiPathItem => {
    const methods: OpenApiPathItem = {};
    for (const method of HTTP_METHODS) if (item[method] !== undefined) methods[method] = item[method];
    const rest = Object.fromEntries(Object.entries(item).filter(([key]) => !(HTTP_METHODS as readonly string[]).includes(key)));
    return { ...methods, ...sortedKeys(rest) };
  };
  const orderMap = (map: Readonly<Record<string, OpenApiPathItem>>) =>
    Object.fromEntries(Object.entries(sortedKeys(map)).map(([key, item]) => [key, orderItem(item)]));
  const ordered: PlainObject = {};
  for (const key of DOCUMENT_KEY_ORDER) if (doc[key] !== undefined) ordered[key] = doc[key];
  for (const key of Object.keys(doc).sort(byCodeUnit)) if (!(key in ordered)) ordered[key] = doc[key];
  ordered.paths = orderMap(doc.paths);
  if (doc.components) {
    ordered.components = Object.fromEntries(
      Object.entries(sortedKeys(doc.components)).map(([section, entries]) => [section, sortedKeys(entries)]),
    );
  }
  return ordered as OpenApiDocument;
}

/**
 * Builds the internal document from the raw @nestjs/swagger document.
 *
 * Why: staff get every route in one place (decision 017); each operation already carries its surface, access kind and
 * permission as `x-gsm-*` extensions.
 *
 * @param raw the document `SwaggerModule.createDocument` produced (not modified)
 * @param supplierCalls the calls this backend makes to suppliers, listed in `x-gsm-supplier-calls` (none by default)
 * @returns a new document with every operation, all security schemes and surface-grouped tags
 */
export function buildInternalDocument(
  raw: OpenApiDocument,
  supplierCalls: readonly AnySupplierCall[] = [],
): OpenApiDocument {
  // An empty `schemas: {}` (no class-based models) is dropped; the contracts inline their schemas.
  const rawComponents = Object.fromEntries(
    Object.entries(clone(raw.components ?? {})).filter(([, entries]) => Object.keys(entries).length > 0),
  );
  const doc: OpenApiDocument = {
    openapi: raw.openapi,
    info: { ...INTERNAL_INFO },
    servers: clone(SERVERS),
    paths: pickPaths(raw, () => true),
    components: { ...rawComponents, securitySchemes: definitionsOf(Object.keys(SECURITY_SCHEMES)) },
  };
  usedSecuritySchemes(doc);
  organizeTags(doc);
  describeSupplierCalls(doc, supplierCalls);
  return orderDocument(doc);
}

/**
 * Builds the public document: the filter of decision 017.
 *
 * Why: merchants see only what they integrate with. Operations are kept only when their surface is `dhru`
 * (an operation without a surface is dropped), and components and security
 * schemes that no kept operation reaches are left out, so no internal model leaks.
 *
 * @param raw the document `SwaggerModule.createDocument` produced (not modified)
 * @returns a new document with the public operations and what they reference
 */
export function buildPublicDocument(raw: OpenApiDocument): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: raw.openapi,
    info: { ...PUBLIC_INFO },
    servers: clone(SERVERS),
    paths: pickPaths(raw, (surface) => surface !== undefined && PUBLIC_SURFACES.includes(surface)),
  };
  const schemes = usedSecuritySchemes(doc);
  const referenced = reachableComponents([doc.paths], raw.components);
  doc.components = { ...referenced, securitySchemes: definitionsOf(schemes) };
  organizeTags(doc);
  return orderDocument(doc);
}

/**
 * Builds both documents from a Nest application that has been created but not initialised.
 *
 * Why: the app serves them and `scripts/gen-openapi.ts` commits them (decision 009); both must come from the same
 * code. Nothing connects to infrastructure: the contracts live in decorator metadata, so no `init()` is needed.
 *
 * @param app the Nest application with every controller registered
 * @param options the Dhru actions and supplier calls to describe (default: the process-wide registries)
 * @returns the internal and the public document
 * @throws {Error} when an operation uses a security scheme that has no definition
 */
export function buildOpenApiDocuments(app: INestApplication, options: BuildOptions = {}): OpenApiDocuments {
  const base = new DocumentBuilder()
    .setTitle(INTERNAL_INFO.title)
    .setVersion(API_VERSION)
    .setOpenAPIVersion(OPENAPI_VERSION)
    .build();
  // autoTagControllers: false keeps the contract's own tags (the default adds a tag per controller).
  const raw = clone(SwaggerModule.createDocument(app, base, { autoTagControllers: false })) as OpenApiDocument;
  stripSchemaKeyword(raw);
  // Decision 017: the Dhru operation lists its eight actions (a `oneOf` by `action`, an example each) in both documents.
  describeDhruActions(raw, options.dhruActions ?? dhruActionRegistry.all());
  return {
    internal: buildInternalDocument(raw, options.supplierCalls ?? supplierCallRegistry.all()),
    public: buildPublicDocument(raw),
  };
}

/**
 * Serialises a document exactly as it is committed and served.
 *
 * Why: the generator's `--check` compares bytes, so there is one writer: two-space JSON and a trailing newline.
 *
 * @param doc a finished document
 * @returns the JSON text
 */
export function serializeOpenApiDocument(doc: OpenApiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
