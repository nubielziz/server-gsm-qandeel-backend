// Integration tests of the documentation routes (decision 017): GET /openapi.json and /docs (public, map routes),
// GET /reference and /reference/openapi.json (internal, gated by REFERENCE_DOCS), the public/internal filter on a
// small fixture API, the outgoing events as webhooks, and the Content-Security-Policy that only the pages relax.
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { EventRegistry, contractRegistry, defineEvent, zId } from '../../src/common/contract';
import { DOCUMENTATION_ROUTES, OpenApiService, SCALAR_BUNDLE_URL } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, productionEnvOnTestInstances, signInStaff } from '../support/auth';
import { closeTestDb, resetDb } from '../support/db';
import { DocsFixtureController } from '../support/docs-routes';
import { TestController } from '../support/routes';

// A loose view of the generated documents: the tests walk them with plain property access.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenAPI documents are free-form JSON.

/** What @fastify/helmet sends on every route: the strict policy of a JSON-only API. */
const STRICT_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

const apps: TestApp[] = [];
/** A fresh app with the fixture API (REST v1, merchant, admin, Dhru-like and system routes). */
async function appWith(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const t = await createTestApp({ controllers: [TestController, DocsFixtureController], ...options });
  apps.push(t);
  return t;
}
afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

const get = (t: TestApp, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers });

/** Directive name to its values, from a Content-Security-Policy header. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

/** Checks that a document holds together: references resolve, ids are unique, tags and security names are defined. */
function expectConsistent(doc: Json): void {
  const operations: Json[] = [...Object.values(doc.paths), ...Object.values(doc.webhooks ?? {})].flatMap((item: Json) =>
    Object.values(item),
  );
  const ids = operations.map((operation) => operation.operationId);
  expect(new Set(ids).size, 'operationIds are unique').toBe(ids.length);

  const tagNames = new Set((doc.tags ?? []).map((tag: Json) => tag.name));
  const schemes = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
  for (const operation of operations) {
    for (const tag of operation.tags ?? []) expect(tagNames.has(tag), `tag ${tag} is listed`).toBe(true);
    for (const requirement of operation.security ?? []) {
      for (const name of Object.keys(requirement)) expect(schemes.has(name), `scheme ${name} is defined`).toBe(true);
    }
  }
  for (const group of doc['x-tagGroups'] ?? []) {
    for (const tag of group.tags) expect(tagNames.has(tag), `grouped tag ${tag} is listed`).toBe(true);
  }
  for (const [path, item] of Object.entries<Json>(doc.paths)) {
    const templated = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const operation of Object.values<Json>(item)) {
      const declared = (operation.parameters ?? []).filter((p: Json) => p.in === 'path').map((p: Json) => p.name);
      expect([...declared].sort(), `${path} path parameters`).toEqual([...templated].sort());
    }
  }
  const text = JSON.stringify(doc);
  for (const [, section, name] of text.matchAll(/"\$ref":"#\/components\/(\w+)\/([\w.-]+)"/g)) {
    expect(doc.components?.[section as string]?.[name as string], `$ref ${section}/${name} resolves`).toBeDefined();
  }
  expect(text).not.toContain('"$schema"');
}

describe('GET /openapi.json (public document)', () => {
  it('answers 200 JSON with the exact text the service published, cacheable for five minutes', async () => {
    const t = await appWith();
    const res = await get(t, '/openapi.json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toBe(t.app.get(OpenApiService).documents().publicJson);
    expect(res.body.endsWith('}\n')).toBe(true);
  });

  it('keeps only the REST v1 and Dhru operations of the fixture API', async () => {
    const t = await appWith();
    const doc = (await get(t, '/openapi.json')).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/api/index.php', '/v1/t/orders']);
    expect(Object.keys(doc.paths['/v1/t/orders'])).toEqual(['get', 'post']);
    expect(doc.paths['/v1/t/orders'].post['x-gsm-surface']).toBe('v1');
    expect(doc.paths['/api/index.php'].post['x-gsm-surface']).toBe('dhru');
    for (const hidden of [
      '/admin/t/orders',
      '/admin/t/secure',
      '/client/t/wallet',
      '/health',
      '/metrics',
      '/t/items',
    ]) {
      expect(doc.paths[hidden], hidden).toBeUndefined();
    }
    expect(doc.webhooks).toBeUndefined();
  });

  it('keeps the x-gsm-alias markers of the shared types and drops the $schema keyword', async () => {
    const t = await appWith();
    const doc = (await get(t, '/openapi.json')).json();
    const order = doc.paths['/v1/t/orders'].post.responses['201'].content['application/json'].schema;
    expect(order.properties.total['x-gsm-alias']).toBe('Money');
    expect(order.properties.createdAt['x-gsm-alias']).toBe('IsoDateTime');
    expect(order.properties.id['x-gsm-alias']).toBe('Id');
    const internal = (await get(t, '/reference/openapi.json')).json();
    expect(JSON.stringify(internal)).toContain('"x-gsm-alias":"Money"');
    expect(JSON.stringify(internal)).not.toContain('$schema');
  });

  it('defines only the security schemes its operations use, plus the API key', async () => {
    const t = await appWith();
    const doc = (await get(t, '/openapi.json')).json();
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['apiKey', 'dhruCredentials']);
    expect(JSON.stringify(doc)).not.toMatch(/staffSession|merchantSession|gsm_admin_session/);
  });

  it('is a consistent OpenAPI document with the v1 tag shown under its surface', async () => {
    const t = await appWith();
    const doc = (await get(t, '/openapi.json')).json();
    expectConsistent(doc);
    expect(doc['x-tagGroups']).toEqual([
      { name: 'REST API v1', tags: ['orders'] },
      { name: 'Dhru Fusion API', tags: ['test'] },
    ]);
  });

  it('answers the same on the app without the fixture API: a valid, empty public document', async () => {
    const t = await createTestApp();
    apps.push(t);
    const doc = (await get(t, '/openapi.json')).json();
    expect(doc.paths).toEqual({});
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['apiKey']);
  });

  it('lists the events of the registry as webhooks when they exist', async () => {
    const t = await appWith();
    const events = new EventRegistry();
    defineEvent(
      {
        key: 'EVENT order.status_changed',
        summary: 'An order changed status',
        payload: z.object({ orderId: zId, status: z.string() }),
        example: { orderId: 7, status: 'completed' },
      },
      events,
    );
    t.app.get(OpenApiService).publish(t.app, { events: events.all() });
    const doc = (await get(t, '/openapi.json')).json();
    expect(Object.keys(doc.webhooks)).toEqual(['order.status_changed']);
    expect(doc.webhooks['order.status_changed'].post.security).toEqual([{ webhookSignature: [] }]);
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['apiKey', 'dhruCredentials', 'webhookSignature']);
    expect(doc['x-tagGroups'].map((group: Json) => group.name)).toContain('Webhook events');
    expectConsistent(doc);
    // The internal document never carries them.
    const internal = (await get(t, '/reference/openapi.json')).json();
    expect(internal.webhooks).toBeUndefined();
  });
});

describe('GET /reference/openapi.json (internal document)', () => {
  it('lists every route of the app, with its surface, access kind and permission', async () => {
    const t = await appWith();
    const res = await get(t, '/reference/openapi.json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toBe(t.app.get(OpenApiService).documents().internalJson);
    const doc = res.json();
    for (const path of [
      '/v1/t/orders',
      '/api/index.php',
      '/admin/t/orders',
      '/admin/t/secure',
      '/client/t/wallet',
      '/health',
      '/metrics',
      '/openapi.json',
      '/docs',
      '/t/items',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
    expect(doc.paths['/admin/t/orders'].get['x-gsm-surface']).toBe('admin');
    expect(doc.paths['/admin/t/orders'].get['x-gsm-permission']).toBe('orders:read');
    expect(doc.paths['/client/t/wallet'].get.security).toEqual([{ merchantSession: [] }]);
    expectConsistent(doc);
  });

  it('does not document the reference routes themselves', async () => {
    const t = await appWith();
    const doc = (await get(t, '/reference/openapi.json')).json();
    expect(Object.keys(doc.paths).filter((path) => path.startsWith('/reference'))).toEqual([]);
  });

  it('defines every security scheme, with the cookie names of decision 018', async () => {
    const t = await appWith();
    const { securitySchemes } = (await get(t, '/reference/openapi.json')).json().components;
    expect(securitySchemes.staffSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'gsm_admin_session' });
    expect(securitySchemes.merchantSession).toMatchObject({ in: 'cookie', name: 'gsm_client_session' });
    expect(securitySchemes.customerSession).toMatchObject({ in: 'cookie', name: 'gsm_store_session' });
    expect(securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(securitySchemes.webhookSignature).toMatchObject({ in: 'header', name: 'X-GSM-Signature' });
  });

  it('shows a tag that two surfaces share under each surface, so their operations do not merge', async () => {
    const t = await appWith();
    const doc = (await get(t, '/reference/openapi.json')).json();
    expect(doc.paths['/v1/t/orders'].get.tags).toEqual(['v1: orders']);
    expect(doc.paths['/admin/t/orders'].get.tags).toEqual(['admin: orders']);
    const groups = Object.fromEntries(doc['x-tagGroups'].map((group: Json) => [group.name, group.tags]));
    expect(groups['REST API v1']).toEqual(['v1: orders']);
    // The real sign-in routes (map group `auth`) are in the group too; only the tags of this test's routes are checked.
    expect(groups['Admin console']).toEqual(expect.arrayContaining(['admin: orders', 'admin: test']));
    // The real portal routes are in the group too (the wallet routes are map group `catalog`, the sign-in ones `auth`).
    expect(groups['Merchant portal']).toEqual(expect.arrayContaining(['wallet']));
  });

  it('describes GET /openapi.json as JSON and GET /docs as HTML', async () => {
    const t = await appWith();
    const doc = (await get(t, '/reference/openapi.json')).json();
    expect(doc.paths['/openapi.json'].get.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
    });
    expect(doc.paths['/docs'].get.responses['200'].content['text/html'].schema).toEqual({ type: 'string' });
    expect(doc.paths['/openapi.json'].get['x-gsm-key']).toBe('GET /openapi.json');
  });
});

describe('GET /docs and GET /reference (Scalar pages)', () => {
  it('serve HTML that loads the pinned Scalar script and embeds their own document', async () => {
    const t = await appWith();
    const pub = await get(t, '/docs');
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(pub.headers['cache-control']).toBe('public, max-age=300');
    expect(pub.body).toContain('<title>GSM Supplier API</title>');
    expect(pub.body).toContain(`<script src="${SCALAR_BUNDLE_URL}" integrity="sha384-`);
    expect(pub.body).toContain('"/v1/t/orders"');
    expect(pub.body).not.toContain('/admin/t/orders');

    const internal = await get(t, '/reference');
    expect(internal.statusCode).toBe(200);
    expect(internal.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(internal.headers['cache-control']).toBe('private, no-store');
    expect(internal.body).toContain('<title>GSM Supplier API: internal reference</title>');
    expect(internal.body).toContain('"/admin/t/orders"');
  });

  it('pin the CDN to one exact version', async () => {
    const t = await appWith();
    for (const url of ['/docs', '/reference']) {
      const scripts = [...(await get(t, url)).body.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
      expect(scripts, url).toEqual([SCALAR_BUNDLE_URL]);
      expect(SCALAR_BUNDLE_URL).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//);
    }
  });
});

describe('Content-Security-Policy', () => {
  it('is relaxed on the two pages only, and exactly as their inline script needs', async () => {
    const t = await appWith();
    for (const url of ['/docs', '/reference']) {
      const res = await get(t, url);
      const policy = res.headers['content-security-policy'] as string;
      expect(policy, url).not.toBe(STRICT_CSP);
      const parsed = directives(policy);
      expect(parsed['default-src']).toEqual(["'none'"]);
      expect(parsed['connect-src']).toEqual(["'self'"]);
      expect(parsed['font-src']).toEqual(['https://fonts.scalar.com']);
      expect(parsed['frame-ancestors']).toEqual(["'none'"]);
      expect(
        parsed['script-src']?.some((source) =>
          source.startsWith('https://cdn.jsdelivr.net/npm/@scalar/api-reference@'),
        ),
      ).toBe(true);
      expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
      // The hash in the header is the hash of the inline starter script that is actually in the body.
      const inline = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(res.body)?.[1] ?? '';
      const hash = createHash('sha256').update(inline).digest('base64');
      expect(parsed['script-src'], url).toContain(`'sha256-${hash}'`);
    }
  });

  it('stays default-src none on every other route: documents, health, metrics, API routes and errors', async () => {
    const t = await appWith();
    const urls = [
      '/openapi.json',
      '/reference/openapi.json',
      '/health',
      '/metrics',
      '/t/items/1',
      '/t/items/not-a-number', // 422 problem+json
      '/t/items/404', // 404 from a handler
      '/does-not-exist', // 404 from the router
    ];
    for (const url of urls) {
      const res = await get(t, url);
      expect(res.headers['content-security-policy'], `${url} (${res.statusCode})`).toBe(STRICT_CSP);
    }
  });

  it('is not left on an error answer of a page route (a refused reference keeps the strict policy)', async () => {
    const t = await appWith({ env: { REFERENCE_DOCS: 'off' } });
    const res = await get(t, '/reference');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
  });
});

describe('REFERENCE_DOCS', () => {
  const unknown = async (t: TestApp) => (await get(t, '/does-not-exist')).json();

  it('open (the default outside production) serves both reference routes', async () => {
    const t = await appWith();
    expect(t.config.http.referenceDocs).toBe('open');
    expect((await get(t, '/reference')).statusCode).toBe(200);
    expect((await get(t, '/reference/openapi.json')).statusCode).toBe(200);
  });

  it('off answers 404 problem+json, like a route that does not exist', async () => {
    const t = await appWith({ env: { REFERENCE_DOCS: 'off' } });
    for (const url of ['/reference', '/reference/openapi.json']) {
      const res = await get(t, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const { requestId, ...body } = res.json();
      const { requestId: _other, ...missing } = await unknown(t);
      expect(requestId).toBeString();
      expect(body, url).toEqual(missing);
      expect(body.code).toBe('NOT_FOUND');
    }
  });

  it('off still serves the public pair', async () => {
    const t = await appWith({ env: { REFERENCE_DOCS: 'off' } });
    expect((await get(t, '/docs')).statusCode).toBe(200);
    expect((await get(t, '/openapi.json')).statusCode).toBe(200);
  });

  it('staff refuses a caller without a session with 401, and still serves the public pair', async () => {
    const t = await appWith({ env: { REFERENCE_DOCS: 'staff' } });
    for (const url of ['/reference', '/reference/openapi.json']) {
      const res = await get(t, url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
    }
    expect((await get(t, '/docs')).statusCode).toBe(200);
    expect((await get(t, '/openapi.json')).statusCode).toBe(200);
  });

  it('defaults to staff in production: the internal reference needs a staff session there', async () => {
    const t = await appWith({ env: productionEnvOnTestInstances() });
    expect(t.config.http.referenceDocs).toBe('staff');
    expect((await get(t, '/reference')).statusCode).toBe(401);
    expect((await get(t, '/reference/openapi.json')).statusCode).toBe(401);
    expect((await get(t, '/openapi.json')).statusCode).toBe(200);
  });

  describe('with a staff session (the guard behind REFERENCE_DOCS_GUARD)', () => {
    beforeEach(resetDb);
    afterAll(closeTestDb);

    it('staff serves the reference to a staff member with system:read', async () => {
      const t = await appWith({ env: { REFERENCE_DOCS: 'staff' } });
      await clearIdentityCaches(t);
      const { session } = await signInStaff(t, ['system:read']);
      for (const url of ['/reference', '/reference/openapi.json']) {
        const res = await get(t, url, session.headers);
        expect(res.statusCode, url).toBe(200);
      }
    });

    it('serves the staff in production too, under the __Host- cookie', async () => {
      const t = await appWith({ env: productionEnvOnTestInstances() });
      await clearIdentityCaches(t);
      const { session } = await signInStaff(t, ['system:read']);
      expect(session.cookie.startsWith('__Host-gsm_admin_session=')).toBe(true);
      for (const url of ['/reference', '/reference/openapi.json']) {
        expect((await get(t, url, session.headers)).statusCode, url).toBe(200);
      }
    });

    it('accepts a role that holds system:* or *, and refuses one that only holds another area', async () => {
      const t = await appWith({ env: { REFERENCE_DOCS: 'staff' } });
      await clearIdentityCaches(t);
      for (const [permissions, status] of [
        [['system:*'], 200],
        [['*'], 200],
        [['orders:*', 'system:write'], 403],
        [[], 403],
      ] as const) {
        const { session } = await signInStaff(t, [...permissions]);
        const res = await get(t, '/reference', session.headers);
        expect(res.statusCode, permissions.join()).toBe(status);
        if (status === 403) {
          expect(res.json()).toMatchObject({
            code: 'FORBIDDEN',
            detail: 'You need the system:read permission to do this.',
          });
          expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
        }
      }
    });

    it('refuses a pending sign-in session', async () => {
      const t = await appWith({ env: { REFERENCE_DOCS: 'staff' } });
      await clearIdentityCaches(t);
      const { session } = await signInStaff(t, ['*'], { stage: 'pending_totp' });
      expect((await get(t, '/reference', session.headers)).statusCode).toBe(401);
    });

    it('open and off ignore the session', async () => {
      const open = await appWith({ env: { REFERENCE_DOCS: 'open' } });
      expect((await get(open, '/reference')).statusCode).toBe(200);
      const off = await appWith({ env: { REFERENCE_DOCS: 'off' } });
      await clearIdentityCaches(off);
      const { session } = await signInStaff(off, ['*']);
      expect((await get(off, '/reference', session.headers)).statusCode).toBe(404);
    });
  });
});

describe('route registration', () => {
  it('registers the two public routes as contracts and the two reference routes as plain documentation routes', async () => {
    const t = await appWith();
    expect(contractRegistry.has('GET /openapi.json')).toBe(true);
    expect(contractRegistry.has('GET /docs')).toBe(true);
    expect(contractRegistry.get('GET /openapi.json')?.success.contentType).toBe('application/json');
    expect(contractRegistry.get('GET /docs')?.success.contentType).toBe('text/html');
    expect([...DOCUMENTATION_ROUTES]).toEqual(['GET /reference', 'GET /reference/openapi.json']);
    const fastify = t.app.getHttpAdapter().getInstance();
    for (const route of DOCUMENTATION_ROUTES) {
      const [method, url] = route.split(' ') as ['GET', string];
      expect(fastify.hasRoute({ method, url }), route).toBe(true);
      expect(contractRegistry.has(route), route).toBe(false);
    }
  });

  it('refuses to serve before the documents were published, with a clear error', () => {
    expect(() => new OpenApiService().documents()).toThrow(/not published/);
  });
});
