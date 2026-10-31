// Unit tests of the document builders (decision 017): the public/internal filter, tags, security schemes, components,
// the outgoing events as webhooks and the stable key order, all on hand-made documents (no Nest, no HTTP).
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { EventRegistry, SECURITY_SCHEME, defineEvent, zId } from '../../../common/contract';
import {
  buildInternalDocument,
  buildPublicDocument,
  buildWebhooks,
  serializeOpenApiDocument,
  stripSchemaKeyword,
} from './openapi-documents';
import type { OpenApiDocument, OpenApiOperation } from './openapi-types';
import { SECURITY_SCHEMES, WEBHOOK_SIGNATURE_SCHEME } from './security-schemes';

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
      '/v1/orders': {
        post: operation('v1', {
          tags: ['orders'],
          security: [{ apiKey: [] }],
          requestBody: json(ref('NewOrder')),
        }),
        get: operation('v1', { tags: ['orders'], security: [{ apiKey: [] }] }),
      },
      '/api/index.php': { post: operation('dhru', { tags: ['dhru'], security: [{ dhruCredentials: [] }] }) },
      '/admin/orders': {
        get: operation('admin', {
          tags: ['orders'],
          security: [{ staffSession: [] }],
          responses: { '200': { description: 'ok', ...json(ref('AdminOrder')) } },
        }),
      },
      '/client/wallet': { get: operation('client', { tags: ['wallet'], security: [{ merchantSession: [] }] }) },
      '/webhooks/telegram/{secret}': { post: operation('hooks', { tags: ['telegram'], security: [{ urlSecret: [] }] }) },
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

const events = new EventRegistry();
const orderChanged = defineEvent(
  {
    key: 'EVENT order.status_changed',
    summary: 'An order changed status',
    description: 'Sent after every status change.',
    payload: z.object({ orderId: zId, status: z.string() }),
    example: { orderId: 7, status: 'completed' },
  },
  events,
);
const walletLow = defineEvent(
  { key: 'EVENT wallet.low_balance', summary: 'The balance is low', payload: z.object({ balance: z.string() }) },
  events,
);

const pathsOf = (doc: OpenApiDocument) => Object.keys(doc.paths);
const operationsOf = (doc: OpenApiDocument) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => `${method.toUpperCase()} ${path} ${(op as OpenApiOperation).operationId ?? ''}`),
  );

describe('buildPublicDocument: the filter', () => {
  it('keeps only the operations of the v1 and dhru surfaces', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(pathsOf(doc)).toEqual(['/api/index.php', '/v1/orders']);
    expect(Object.keys(doc.paths['/v1/orders'] ?? {})).toEqual(['get', 'post']);
  });

  it('drops everything else: admin, client, hooks, system and an operation without a surface', () => {
    const doc = buildPublicDocument(rawDocument());
    for (const hidden of ['/admin/orders', '/client/wallet', '/webhooks/telegram/{secret}', '/health', '/legacy']) {
      expect(doc.paths[hidden], hidden).toBeUndefined();
    }
  });

  it('removes a path whose operations are all filtered out, and keeps one that has a public method left', () => {
    const raw = rawDocument();
    raw.paths['/v1/orders'] = { ...raw.paths['/v1/orders'], delete: operation('admin') };
    const doc = buildPublicDocument(raw);
    expect(Object.keys(doc.paths['/v1/orders'] ?? {})).toEqual(['get', 'post']);
    expect(doc.paths['/admin/orders']).toBeUndefined();
  });

  it('does not change the raw document, and shares no objects with it', () => {
    const raw = rawDocument();
    const before = JSON.stringify(raw);
    const doc = buildPublicDocument(raw, [orderChanged]);
    expect(JSON.stringify(raw)).toBe(before);
    (doc.paths['/v1/orders']?.get as OpenApiOperation).summary = 'changed afterwards';
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is a valid OpenAPI 3.1 document even before the first v1 route exists', () => {
    const raw = rawDocument();
    raw.paths = { '/admin/orders': raw.paths['/admin/orders'] ?? {} };
    const doc = buildPublicDocument(raw);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toEqual({});
    expect(Object.keys(doc.components ?? {})).toEqual(['securitySchemes']);
    expect(doc.tags).toBeUndefined();
    expect(doc['x-tagGroups']).toBeUndefined();
    expect(doc.webhooks).toBeUndefined();
  });

  it('uses the public title and version, not the raw ones', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(doc.info.title).toBe('GSM Supplier API');
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
    raw.paths = { '/v1/orders': { get: operation('v1', { tags: ['orders'], security: [{ apiKey: [] }] }) } };
    expect(Object.keys(buildPublicDocument(raw).components ?? {})).toEqual(['securitySchemes']);
  });

  it('defines only the schemes public operations use, and always the API key', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(['apiKey', 'dhruCredentials']);
    const raw = rawDocument();
    raw.paths = {};
    expect(Object.keys(buildPublicDocument(raw).components?.securitySchemes ?? {})).toEqual(['apiKey']);
  });

  it('adds the webhook signature scheme when there are events', () => {
    const doc = buildPublicDocument(rawDocument(), [orderChanged]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(['apiKey', 'dhruCredentials', 'webhookSignature']);
  });

  it('refuses an operation that uses a security scheme nobody defined', () => {
    const raw = rawDocument();
    raw.paths['/v1/orders'] = { get: operation('v1', { security: [{ madeUpScheme: [] }] }) };
    expect(() => buildPublicDocument(raw)).toThrow(/undefined security scheme "madeUpScheme"/);
    expect(() => buildInternalDocument(raw)).toThrow(/undefined security scheme "madeUpScheme"/);
  });

  it('defines a scheme for every access kind the contract layer can document, and for webhooks', () => {
    const names = Object.values(SECURITY_SCHEME).filter((name): name is string => name !== undefined);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(SECURITY_SCHEMES[name], name).toBeDefined();
    expect(SECURITY_SCHEMES[WEBHOOK_SIGNATURE_SCHEME]).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-GSM-Signature' });
  });

  it('documents the three session cookies with the names of decision 018', () => {
    expect(SECURITY_SCHEMES.staffSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'gsm_admin_session' });
    expect(SECURITY_SCHEMES.merchantSession).toMatchObject({ in: 'cookie', name: 'gsm_client_session' });
    expect(SECURITY_SCHEMES.customerSession).toMatchObject({ in: 'cookie', name: 'gsm_store_session' });
    expect(SECURITY_SCHEMES.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});

describe('buildInternalDocument', () => {
  it('keeps every operation, including the ones the public document hides', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(pathsOf(doc)).toEqual([
      '/admin/orders',
      '/api/index.php',
      '/client/wallet',
      '/health',
      '/legacy',
      '/v1/orders',
      '/webhooks/telegram/{secret}',
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

  it('never carries webhooks (they are part of the public contract only)', () => {
    expect(buildInternalDocument(rawDocument()).webhooks).toBeUndefined();
  });
});

describe('tags', () => {
  it('prefixes a tag that two surfaces share, so their operations never merge', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(doc.paths['/v1/orders']?.get).toMatchObject({ tags: ['v1: orders'] });
    expect(doc.paths['/admin/orders']?.get).toMatchObject({ tags: ['admin: orders'] });
    expect(doc.paths['/client/wallet']?.get).toMatchObject({ tags: ['wallet'] });
  });

  it('leaves a tag alone when one surface uses it (the public document has only v1)', () => {
    const doc = buildPublicDocument(rawDocument());
    expect(doc.paths['/v1/orders']?.get).toMatchObject({ tags: ['orders'] });
  });

  it('groups tags by surface, public surfaces first, then merchant, storefront, staff and plumbing', () => {
    const doc = buildInternalDocument(rawDocument());
    expect(doc['x-tagGroups']).toEqual([
      { name: 'REST API v1', tags: ['v1: orders'] },
      { name: 'Dhru Fusion API', tags: ['dhru'] },
      { name: 'Merchant portal', tags: ['wallet'] },
      { name: 'Admin console', tags: ['admin: orders'] },
      { name: 'Incoming webhooks', tags: ['telegram'] },
      { name: 'System', tags: ['legacy', 'system'] },
    ]);
    expect(doc.tags?.map((tag) => tag.name)).toEqual([
      'v1: orders',
      'dhru',
      'wallet',
      'admin: orders',
      'telegram',
      'legacy',
      'system',
    ]);
  });

  it('puts webhook events in their own group', () => {
    const doc = buildPublicDocument(rawDocument(), [orderChanged]);
    expect(doc['x-tagGroups']?.map((group) => group.name)).toEqual(['REST API v1', 'Dhru Fusion API', 'Webhook events']);
  });
});

describe('buildWebhooks', () => {
  it('describes each event as a POST with the envelope, the signature headers and the retry rule', () => {
    const webhooks = buildWebhooks([orderChanged]);
    const post = webhooks['order.status_changed']?.post as OpenApiOperation & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- walking free-form JSON
    expect(post.operationId).toBe('webhookOrderStatusChanged');
    expect(post.summary).toBe('An order changed status');
    expect(post.description).toBe('Sent after every status change.');
    expect(post['x-gsm-key']).toBe('EVENT order.status_changed');
    expect(post.security).toEqual([{ webhookSignature: [] }]);
    expect(post.parameters.map((p: { name: string; in: string }) => `${p.in}:${p.name}`)).toEqual([
      'header:X-GSM-Signature',
      'header:X-GSM-Event-Id',
    ]);
    const body = post.requestBody.content['application/json'];
    expect(body.schema.required).toEqual(['id', 'type', 'createdAt', 'data']);
    expect(body.schema.properties.type).toEqual({ type: 'string', const: 'order.status_changed' });
    expect(body.schema.properties.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(body.schema.properties.data.required).toEqual(['orderId', 'status']);
    expect(body.example).toEqual({
      id: 'evt_1',
      type: 'order.status_changed',
      createdAt: '2026-03-01T09:30:00.000Z',
      data: { orderId: 7, status: 'completed' },
    });
    expect(post.responses['200'].description).toContain('8 attempts');
  });

  it('omits the example when the event has none, and sorts events by name', () => {
    const webhooks = buildWebhooks([walletLow, orderChanged]);
    expect(Object.keys(webhooks)).toEqual(['order.status_changed', 'wallet.low_balance']);
    const post = webhooks['wallet.low_balance']?.post as { requestBody: { content: Record<string, Record<string, unknown>> }; description?: string };
    expect(post.requestBody.content['application/json']?.example).toBeUndefined();
    expect(post.description).toBeUndefined();
  });

  it('returns nothing for no events, and the public document then has no webhooks member', () => {
    expect(buildWebhooks([])).toEqual({});
    expect('webhooks' in buildPublicDocument(rawDocument(), [])).toBe(false);
  });

  it('puts the events into the public document only', () => {
    const doc = buildPublicDocument(rawDocument(), [orderChanged, walletLow]);
    expect(Object.keys(doc.webhooks ?? {})).toEqual(['order.status_changed', 'wallet.low_balance']);
    expect(buildInternalDocument(rawDocument()).webhooks).toBeUndefined();
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
    expect(serializeOpenApiDocument(buildPublicDocument(reversed(raw), [walletLow, orderChanged]))).toBe(
      serializeOpenApiDocument(buildPublicDocument(raw, [orderChanged, walletLow])),
    );
  });

  it('orders the members of the document, paths, methods and components', () => {
    const doc = buildPublicDocument(rawDocument(), [orderChanged]);
    expect(Object.keys(doc)).toEqual([
      'openapi',
      'info',
      'servers',
      'tags',
      'x-tagGroups',
      'paths',
      'webhooks',
      'components',
    ]);
    expect(Object.keys(doc.paths)).toEqual([...Object.keys(doc.paths)].sort());
    expect(Object.keys(doc.paths['/v1/orders'] ?? {})).toEqual(['get', 'post']);
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
    raw.paths['/v1/orders'] = {
      get: operation('v1', {
        security: [{ apiKey: [] }],
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
