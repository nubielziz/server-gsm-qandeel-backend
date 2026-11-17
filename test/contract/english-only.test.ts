// English only (decision 039, feature 30): no operation of the committed OpenAPI document has a language on the wire.
// The script of fact 1 of the plan (docs/briefs/30-english-only.md), as a test: it fails when a parameter or a property named
// `locale`, `locales`, `nameAr`, `byLocale`, `ar` or `alternates` comes back, in a request or in a response. The one exception is
// the read-only `locale` of a legal document row (plan 4.4): the archive tag of a version kept for the record. It reads
// `docs/contract/openapi.json`, which `bun run docs:openapi` renders from the route contracts, so a contract that grows a
// language field fails here before any frontend reads it.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/inputs';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Names that mean "a language" on the wire. */
const FORBIDDEN = new Set(['locale', 'locales', 'nameAr', 'byLocale', 'ar', 'alternates']);

/**
 * The four staff routes of legal documents, whose response rows keep a read-only `locale` (the archive tag of a retired version,
 * plan 4.4). Their requests carry no language either.
 */
const LEGAL_ROUTES = new Set([
  'GET /admin/legal-documents',
  'GET /admin/legal-documents/{id}',
  'POST /admin/legal-documents',
  'POST /admin/legal-documents/{id}/publish',
]);

const read = (file: string): Json => {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, 'docs', 'contract', file), 'utf8'));
  if (!isObject(parsed)) throw new Error(`${file} is not an object`);
  return parsed;
};

/** Follows a local `$ref` (`#/a/b`); the generated documents inline their schemas, so this is a guard, not a feature. */
function resolve(doc: Json, node: Json): Json {
  const ref = node['$ref'];
  if (typeof ref !== 'string') return node;
  let target: unknown = doc;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    target = isObject(target) ? target[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  }
  if (!isObject(target)) throw new Error(`Unresolved reference ${ref}`);
  return target;
}

/** Collects every property name under a schema (objects, arrays, unions, additional properties), following references once. */
function propertyNames(doc: Json, schema: unknown, into: Set<string>, seen = new Set<unknown>()): void {
  if (!isObject(schema) || seen.has(schema)) return;
  seen.add(schema);
  const node = resolve(doc, schema);
  if (node !== schema) {
    propertyNames(doc, node, into, seen);
    return;
  }
  if (isObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      into.add(name);
      propertyNames(doc, child, into, seen);
    }
  }
  for (const key of ['items', 'additionalProperties', 'not'] as const) propertyNames(doc, node[key], into, seen);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) propertyNames(doc, child, into, seen);
  }
}

/** The names under the schemas of a `content` map (a request body or one response). */
function contentNames(doc: Json, content: unknown, into: Set<string>): void {
  if (!isObject(content)) return;
  for (const media of Object.values(content)) {
    if (isObject(media)) propertyNames(doc, media.schema, into);
  }
}

/** What one operation takes in (parameters and request body) and gives out (every response). */
interface Names {
  readonly request: Set<string>;
  readonly response: Set<string>;
}

/** Every operation of a document, by `METHOD /path`, with the names it carries. */
function operationsOf(doc: Json): Map<string, Names> {
  const operations = new Map<string, Names>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method) || !isObject(operation)) continue;
      const names: Names = { request: new Set(), response: new Set() };
      for (const raw of [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ]) {
        if (!isObject(raw)) continue;
        const parameter = resolve(doc, raw);
        if (typeof parameter.name === 'string') names.request.add(parameter.name);
        propertyNames(doc, parameter.schema, names.request);
      }
      if (isObject(operation.requestBody))
        contentNames(doc, resolve(doc, operation.requestBody).content, names.request);
      const responses = isObject(operation.responses) ? operation.responses : {};
      for (const response of Object.values(responses)) {
        if (isObject(response)) contentNames(doc, resolve(doc, response).content, names.response);
      }
      operations.set(`${method.toUpperCase()} ${path}`, names);
    }
  }
  return operations;
}

/** The forbidden names an operation carries: `request` and `response` are reported apart so a failure says which side. */
function offences(operations: Map<string, Names>, allowedInResponse: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const [key, names] of operations) {
    for (const name of names.request) if (FORBIDDEN.has(name)) found.push(`${key}: request ${name}`);
    for (const name of names.response) {
      if (!FORBIDDEN.has(name)) continue;
      if (name === 'locale' && allowedInResponse.has(key)) continue;
      found.push(`${key}: response ${name}`);
    }
  }
  return found.sort();
}

describe('English only on the wire (decision 039)', () => {
  const operations = operationsOf(read('openapi.json'));

  it('reads the whole document (a walker that finds nothing would pass for the wrong reason)', () => {
    expect(operations.size).toBeGreaterThan(350);
    expect(operations.has('GET /admin/legal-documents')).toBe(true);
    expect(operations.has('GET /store/v1/legacy-slugs/{kind}/{slug}')).toBe(true);
    // A non-empty request and response side: the paging query, and a list row.
    const clients = operations.get('GET /admin/clients');
    expect(clients?.request.has('_start')).toBe(true);
    expect(clients?.response.has('email')).toBe(true);
  });

  it('has no parameter or property named locale, locales, nameAr, byLocale, ar or alternates, except the legal rows', () => {
    expect(offences(operations, LEGAL_ROUTES)).toEqual([]);
  });

  it('keeps the read-only locale in the response of the four legal-document routes, and in nothing they take in', () => {
    for (const key of LEGAL_ROUTES) {
      const names = operations.get(key);
      expect(names, key).toBeDefined();
      expect(names?.request.has('locale'), `${key} request`).toBe(false);
      expect(names?.response.has('locale'), `${key} response`).toBe(true);
    }
  });

  it('the public document (Dhru and REST v1) carries no language either', () => {
    expect(offences(operationsOf(read('openapi.public.json')), new Set())).toEqual([]);
  });

  it('the detector sees the names it is looking for (a document that names each of them fails)', () => {
    const doc: Json = {
      paths: {
        '/x': {
          get: {
            parameters: [{ name: 'locale', in: 'query', schema: { type: 'string' } }],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          nameAr: { type: 'string' },
                          nested: { oneOf: [{ type: 'object', properties: { byLocale: {}, alternates: {}, ar: {} } }] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(offences(operationsOf(doc), new Set())).toEqual([
      'GET /x: request locale',
      'GET /x: response alternates',
      'GET /x: response ar',
      'GET /x: response byLocale',
      'GET /x: response nameAr',
    ]);
  });
});
