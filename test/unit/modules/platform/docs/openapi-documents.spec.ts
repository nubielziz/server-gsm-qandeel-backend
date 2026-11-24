// Unit tests of the document builders (decision 017): the public/internal filter, tags, security schemes, components,
// and the stable key order, all on hand-made documents (no Nest, no HTTP).
import { describe, expect, it } from 'bun:test';
import { SECURITY_SCHEME } from '@src/common/contract';
import {
  buildInternalDocument,
  buildPublicDocument,
  serializeOpenApiDocument,
  stripSchemaKeyword,
} from '@src/modules/platform/docs/openapi-documents';
import type { OpenApiDocument, OpenApiOperation } from '@src/modules/platform/docs/openapi-types';
import { SECURITY_SCHEMES } from '@src/modules/platform/docs/security-schemes';

let sequence = 0;
const operation = (surface: string | undefined, over: Partial<OpenApiOperation> = {}): OpenApiOperation => ({
  operationId: `op${(sequence += 1)}`,
  responses: { '200': { description: 'ok' } },
  ...(surface ? { 'x-gsm-surface': surface } : {}),
  ...over,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** What @nestjs/swagger would produce for a small API with one route per surface. */
function rawDocument(): OpenApiDocument {
  sequence = 0;
  return {
    openapi: '3.1.0',
    info: { title: 'raw', version: '0' },
    paths: {
      '/client/orders': {
        post: operation('client', {
          tags: ['orders'],
          security: [{ merchantSession: [] }],
          requestBody: json(ref('NewOrder')),
        }),
        get: operation('client', { tags: ['orders'], security: [{ merchantSession: [] }] }),
      },
      '/api/index.php': {
        post: operation('dhru', {
          tags: ['dhru'],
          security: [{ dhruCredentials: [] }],
          requestBody: json(ref('NewOrder')),
        }),
        get: operation('dhru', { tags: ['dhru'], security: [{ dhruCredentials: [] }] }),
      },
      '/admin/orders': {
        get: operation('admin', {
          tags: ['orders'],
          security: [{ staffSession: [] }],
          responses: { '200': { description: 'ok', ...json(ref('AdminOrder')) } },
        }),
      },
      '/client/wallet': { get: operation('client', { tags: ['wallet'], security: [{ merchantSession: [] }] }) },
      '/webhooks/example/{secret}': { post: operation('hooks', { tags: ['example'], security: [{ urlSecret: [] }] }) },
      '/health': { get: operation('system', { tags: ['system'] }) },
      // A controller without @Route has no surface: the filter must treat it as internal.
      '/legacy': { get: operation(undefined, { tags: ['legacy'] }) },
    },
    components: {
      schemas: {
        NewOrder: { type: 'object', properties: { item: ref('Item') } },
        Item: { type: 'object', properties: { name: { type: 'string' } } },
        AdminOrder: { type: 'object', properties: { notes: ref('InternalNote') } },
        InternalNote: { type: 'object' },
        Unused: { type: 'object' },
      },
    },
  };
}

const pathsOf = (doc: OpenApiDocument) => Object.keys(doc.paths);
const operationsOf = (doc: OpenApiDocument) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => `${method.toUpperCase()} ${path} ${(op as OpenApiOperation).operationId ?? ''}`),
  );

describe('buildPublicDocument: the filter', () => {
  it('keeps only the operations of the dhru surface', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(pathsOf(doc)).toEqual(['/api/index.php']);
    expect(Object.keys(doc.paths['/api/index.php'] ?? {})).toEqual(['get', 'post']);
  });

  it('drops everything else: admin, client, hooks, system and an operation without a surface', () => {
    const doc = buildPublicDocument(rawDocument());
    for (const hidden of [
      '/admin/orders',
      '/client/orders',
      '/client/wallet',
      '/webhooks/example/{secret}',
      '/health',
      '/legacy',
    ]) {
      expect(doc.paths[hidden], hidden).toBeUndefined();
    }
  });

  it('removes a path whose operations are all filtered out, and keeps one that has a public method left', () => {
    const raw = rawDocument();
    raw.paths['/api/index.php'] = { ...raw.paths['/api/index.php'], delete: operation('admin') };
    const doc = buildPublicDocument(raw);
    expect(Object.keys(doc.paths['/api/index.php'] ?? {})).toEqual(['get', 'post']);
    expect(doc.paths['/admin/orders']).toBeUndefined();
  });

  it('does not change the raw document, and shares no objects with it', () => {
    const raw = rawDocument();
    const before = JSON.stringify(raw);
    const doc = buildPublicDocument(raw);
    expect(JSON.stringify(raw)).toBe(before);
    (doc.paths['/api/index.php']?.get as OpenApiOperation).summary = 'changed afterwards';
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is a valid OpenAPI 3.1 document even when no route is public', () => {
    const raw = rawDocument();
    raw.paths = { '/admin/orders': raw.paths['/admin/orders'] ?? {} };
    const doc = buildPublicDocument(raw);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toEqual({});
    expect(Object.keys(doc.components ?? {})).toEqual(['securitySchemes']);
    expect(doc.tags).toBeUndefined();
    expect(doc['x-tagGroups']).toBeUndefined();
  });

  it('uses the public title and version, not the raw ones', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(doc.info.title).toBe('IMEI-HUB API');
    expect(doc.info.version).toBe('1.0.0');
  });

  it('names one relative server, so the files hold no host name and "Try it" calls the origin that served them', () => {
    expect(buildPublicDocument(rawDocument()).servers).toEqual([
      { url: '/', description: 'The server that serves this document' },
    ]);
    expect(buildInternalDocument(rawDocument()).servers).toEqual(buildPublicDocument(rawDocument()).servers);
  });
});

describe('buildPublicDocument: components and security schemes', () => {
  it('keeps the components that public operations reach, directly or through other components', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(Object.keys(doc.components?.schemas ?? {}).sort()).toEqual(['Item', 'NewOrder']);
  });

  it('leaves out the models that only internal routes use', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(JSON.stringify(doc)).not.toMatch(/AdminOrder|InternalNote|Unused/);
  });

  it('keeps no components section that is empty', () => {
    const raw = rawDocument();
    raw.paths = { '/api/index.php': { get: operation('dhru', { tags: ['dhru'], security: [{ dhruCredentials: [] }] }) } };
    expect(Object.keys(buildPublicDocument(raw).components ?? {})).toEqual(['securitySchemes']);
  });

  it('defines only the schemes public operations use', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(['dhruCredentials']);
    const raw = rawDocument();
    raw.paths = {};
    expect(Object.keys(buildPublicDocument(raw).components?.securitySchemes ?? {})).toEqual([]);
  });

  it('refuses an operation that uses a security scheme nobody defined', () => {
    const raw = rawDocument();
    raw.paths['/api/index.php'] = { post: operation('dhru', { security: [{ madeUpScheme: [] }] }) };
    expect(() => buildPublicDocument(raw)).toThrow(/undefined security scheme "madeUpScheme"/);
    expect(() => buildInternalDocument(raw)).toThrow(/undefined security scheme "madeUpScheme"/);
  });

  it('defines a scheme for every access kind the contract layer can document, and none for the retired outgoing webhooks', () => {
    const names = Object.values(SECURITY_SCHEME).filter((name): name is string => name !== undefined);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(SECURITY_SCHEMES[name], name).toBeDefined();
    expect(SECURITY_SCHEMES.webhookSignature).toBeUndefined();
  });

  it('documents the three session cookies with the names of decision 018', () => {
    expect(SECURITY_SCHEMES.staffSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'gsm_admin_session' });
    expect(SECURITY_SCHEMES.merchantSession).toMatchObject({ in: 'cookie', name: 'gsm_client_session' });
    expect(SECURITY_SCHEMES.customerSession).toMatchObject({ in: 'cookie', name: 'gsm_store_session' });
    expect(SECURITY_SCHEMES.apiKey).toBeUndefined();
  });
});

describe('buildInternalDocument', () => {
  it('keeps every operation, including the ones the public document hides', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(pathsOf(doc)).toEqual([
      '/admin/orders',
      '/api/index.php',
      '/client/orders',
      '/client/wallet',
      '/health',
      '/legacy',
      '/webhooks/example/{secret}',
    ]);
  });

  it('defines every security scheme and keeps every component', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(Object.keys(doc.components?.securitySchemes ?? {}).sort()).toEqual(Object.keys(SECURITY_SCHEMES).sort());
    expect(Object.keys(doc.components?.schemas ?? {}).sort()).toEqual(['AdminOrder', 'InternalNote', 'Item', 'NewOrder', 'Unused']);
  });

  it('is a superset of the public document: every public operation is in it', () => {
    const internal = new Set(operationsOf(buildInternalDocument(rawDocument())));
    for (const line of operationsOf(buildPublicDocument(rawDocument()))) expect(internal.has(line), line).toBe(true);
  });

  it('carries no webhooks member: the outgoing events are retired', () => {
    expect('webhooks' in buildInternalDocument(rawDocument())).toBe(false);
    expect('webhooks' in buildPublicDocument(rawDocument())).toBe(false);
  });
});

describe('tags', () => {
  it('prefixes a tag that two surfaces share, so their operations never merge', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(doc.paths['/client/orders']?.get).toMatchObject({ tags: ['client: orders'] });
    expect(doc.paths['/admin/orders']?.get).toMatchObject({ tags: ['admin: orders'] });
    expect(doc.paths['/client/wallet']?.get).toMatchObject({ tags: ['wallet'] });
  });

  it('leaves a tag alone when one surface uses it (the public document has only dhru)', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(doc.paths['/api/index.php']?.get).toMatchObject({ tags: ['dhru'] });
  });

  it('groups tags by surface, public surfaces first, then merchant, storefront, staff and plumbing', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(doc['x-tagGroups']).toEqual([
      { name: 'Dhru Fusion API', tags: ['dhru'] },
      { name: 'Merchant portal', tags: ['client: orders', 'wallet'] },
      { name: 'Admin console', tags: ['admin: orders'] },
      { name: 'Incoming webhooks', tags: ['example'] },
      { name: 'System', tags: ['legacy', 'system'] },
    ]);
    expect(doc.tags?.map((tag) => tag.name)).toEqual([
      'dhru',
      'client: orders',
      'wallet',
      'admin: orders',
      'example',
      'legacy',
      'system',
    ]);
  });
});

describe('stable output', () => {
  /** The same API registered in the opposite order: controllers load in module order, which must not matter. */
  function reversed(doc: OpenApiDocument): OpenApiDocument {
    const reverseKeys = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).reverse());
    return {
      ...doc,
      paths: Object.fromEntries(
        Object.entries(doc.paths)
          .reverse()
          .map(([path, item]) => [path, reverseKeys(item)]),
      ),
      components: { schemas: reverseKeys(doc.components?.schemas ?? {}) },
    };
  }

  it('writes the same bytes whatever order the routes and models were registered in', () => {
    const raw = rawDocument();
    expect(serializeOpenApiDocument(buildInternalDocument(reversed(raw)))).toBe(
      serializeOpenApiDocument(buildInternalDocument(raw)),
    );
    expect(serializeOpenApiDocument(buildPublicDocument(reversed(raw)))).toBe(
      serializeOpenApiDocument(buildPublicDocument(raw)),
    );
  });

  it('orders the members of the document, paths, methods and components', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(Object.keys(doc)).toEqual(['openapi', 'info', 'servers', 'tags', 'x-tagGroups', 'paths', 'components']);
    expect(Object.keys(doc.paths)).toEqual([...Object.keys(doc.paths)].sort());
    expect(Object.keys(doc.paths['/api/index.php'] ?? {})).toEqual(['get', 'post']);
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(['Item', 'NewOrder']);
  });

  it('serialises with two-space indentation and one trailing newline', () => {
    const text = serializeOpenApiDocument(buildPublicDocument(rawDocument()));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.split('\n')[1]).toBe('  "openapi": "3.1.0",');
    expect(JSON.parse(text)).toEqual(buildPublicDocument(rawDocument()));
  });

  it('keeps the order of schema properties and example members as the contract wrote them', () => {
    const raw = rawDocument();
    raw.paths['/api/index.php'] = {
      get: operation('dhru', {
        security: [{ dhruCredentials: [] }],
        responses: { '200': { description: 'ok', ...json({ type: 'object', properties: { zeta: {}, alpha: {} } }) } },
      }),
    };
    const text = serializeOpenApiDocument(buildPublicDocument(raw));
    expect(text.indexOf('"zeta"')).toBeLessThan(text.indexOf('"alpha"'));
  });
});

describe('stripSchemaKeyword', () => {
  it('removes the $schema keyword everywhere and keeps a property that is named $schema', () => {
    const doc: unknown = {
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      nested: [{ items: { $schema: 'x', properties: { $schema: { type: 'string' } } } }],
    };
    stripSchemaKeyword(doc);
    expect(doc).toEqual({
      schema: { type: 'object' },
      nested: [{ items: { properties: { $schema: { type: 'string' } } } }],
    });
  });

  it('ignores values that are not objects', () => {
    expect(() => {
      stripSchemaKeyword(undefined);
      stripSchemaKeyword('x');
      stripSchemaKeyword(null);
    }).not.toThrow();
  });
});
