// Unit tests for defineRoute (decision 008): key parsing, consistency checks at definition time, the registry.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { contractRegistry, declaredStatuses, defineRoute, parseRouteKey, type RouteKey } from './define-route';
import { listQuery } from './list-query';
import { operationIdOf } from './openapi';
import { zId, zIdParam } from './zod';

const Dto = z.object({ id: zId, name: z.string() });
let counter = 0;
/** A valid, unique spec; each test changes one thing. */
const base = (override: Record<string, unknown> = {}) => ({
  key: `GET /spec/route-${(counter += 1)}` as RouteKey,
  summary: 'A route',
  tags: ['spec'],
  surface: 'system' as const,
  access: 'public' as const,
  success: { status: 200 as const, schema: Dto },
  errors: [] as never[],
  ...override,
});
const define = (override: Record<string, unknown> = {}) => defineRoute(base(override) as never);

describe('parseRouteKey', () => {
  it('splits method, path and path parameters', () => {
    expect(parseRouteKey('GET /admin/staff/:id')).toEqual({
      method: 'GET',
      path: '/admin/staff/:id',
      paramNames: ['id'],
    });
    expect(parseRouteKey('POST /admin/clients/:clientId/wallet/adjust').paramNames).toEqual(['clientId']);
    expect(parseRouteKey('GET /openapi.json').path).toBe('/openapi.json');
    expect(parseRouteKey('POST /api/index.php').paramNames).toEqual([]);
    expect(parseRouteKey('GET /')).toEqual({ method: 'GET', path: '/', paramNames: [] });
  });

  it('rejects malformed keys', () => {
    for (const bad of [
      '',
      'GET',
      'get /x',
      'FETCH /x',
      'GET x',
      'GET /x/',
      'GET //x',
      'GET /x y',
      'GET /x?y=1',
      'GET /:',
      'GET /:1a',
      'GET /a/:id/:id',
      'GET /a/*',
      'ACTION accountinfo',
    ]) {
      expect(() => parseRouteKey(bad), bad).toThrow();
    }
  });
});

describe('defineRoute', () => {
  it('returns a frozen contract with the method and path of the key, and registers it', () => {
    const contract = define({ description: 'Longer text', params: undefined });
    expect(contract.method).toBe('GET');
    expect(contract.path).toMatch(/^\/spec\/route-\d+$/);
    expect(contract.permission).toBeNull();
    expect(contract.success).toMatchObject({ status: 200, list: false, alsoStatuses: [] });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.success)).toBe(true);
    expect(Object.isFrozen(contract.tags)).toBe(true);
    expect(contractRegistry.get(contract.key)).toBe(contract as never);
    expect(contractRegistry.has(contract.key)).toBe(true);
    expect(contractRegistry.keys()).toContain(contract.key);
  });

  it('throws when a key is defined twice', () => {
    const spec = base();
    defineRoute(spec as never);
    expect(() => defineRoute(spec as never)).toThrow(/defined twice/);
  });

  it('does not register a contract that failed a check', () => {
    const spec = base({ summary: '' });
    expect(() => defineRoute(spec as never)).toThrow(/summary/);
    expect(contractRegistry.has(spec.key)).toBe(false);
  });

  it('needs a summary of reasonable length and at least one tag', () => {
    expect(() => define({ summary: 'x'.repeat(121) })).toThrow(/summary/);
    expect(() => define({ tags: [] })).toThrow(/tags/);
  });

  it('checks the surface against the path prefix', () => {
    expect(() => define({ key: 'GET /admin/spec/a', surface: 'client', access: 'staff-session' })).toThrow(/surface/);
    expect(() => define({ key: 'GET /spec/b', surface: 'admin' })).toThrow(/surface/);
    expect(define({ key: 'GET /store/v1/spec/c', surface: 'store' }).surface).toBe('store');
    expect(
      define({ key: 'POST /webhooks/spec/payments', surface: 'hooks', access: 'gateway-signature', body: z.object({}) })
        .surface,
    ).toBe('hooks');
  });

  describe('permission', () => {
    it('is required for staff-permission and must look like resource:action', () => {
      const admin = { surface: 'admin', access: 'staff-permission' };
      expect(() => define({ key: 'GET /admin/spec/p1', ...admin })).toThrow(/permission/);
      expect(() => define({ key: 'GET /admin/spec/p2', ...admin, permission: 'Staff:Read' })).toThrow(/permission/);
      expect(() => define({ key: 'GET /admin/spec/p3', ...admin, permission: 'staff' })).toThrow(/permission/);
      expect(define({ key: 'GET /admin/spec/p4', ...admin, permission: 'staff:read' }).permission).toBe('staff:read');
      expect(define({ key: 'PUT /admin/spec/p5', ...admin, permission: 'risk:*' }).permission).toBe('risk:*');
    });

    it('is refused on any other access kind', () => {
      expect(() => define({ permission: 'staff:read' })).toThrow(/only staff-permission/);
      expect(() =>
        define({ key: 'GET /admin/spec/p6', surface: 'admin', access: 'staff-session', permission: 'staff:read' }),
      ).toThrow(/only staff-permission/);
    });
  });

  describe('inputs', () => {
    it('needs a params schema with exactly the path parameters', () => {
      expect(() => define({ key: 'GET /spec/:id' })).toThrow(/need a params schema/);
      expect(() => define({ key: 'GET /spec/:id', params: z.object({ other: zIdParam }) })).toThrow(
        /exactly the path parameters/,
      );
      expect(() => define({ key: 'GET /spec/:id', params: z.object({ id: zIdParam, extra: z.string() }) })).toThrow(
        /exactly the path parameters/,
      );
      expect(() => define({ key: 'GET /spec/plain', params: z.object({ id: zIdParam }) })).toThrow(
        /exactly the path parameters/,
      );
      expect(
        define({ key: 'GET /spec/:id/child/:childId', params: z.object({ id: zIdParam, childId: zIdParam }) }).params,
      ).toBeDefined();
    });

    it('wants lower-case header names', () => {
      expect(() => define({ headers: z.object({ 'Idempotency-Key': z.string() }) })).toThrow(/lower case/);
      expect(define({ headers: z.object({ 'idempotency-key': z.string() }) }).headers).toBeDefined();
    });

    it('refuses a body on GET', () => {
      expect(() => define({ body: z.object({}) })).toThrow(/GET route cannot have a body/);
      expect(
        define({ key: 'POST /spec/with-body', body: z.object({}), success: { status: 201, schema: Dto } }).body,
      ).toBeDefined();
    });
  });

  describe('success', () => {
    it('accepts 200, 201, 202 and 204 only', () => {
      for (const status of [200, 201, 202] as const)
        expect(define({ success: { status, schema: Dto } }).success.status).toBe(status);
      expect(define({ success: { status: 204 } }).success.status).toBe(204);
      expect(() => define({ success: { status: 301, schema: Dto } })).toThrow(/success status/);
      expect(() => define({ success: { status: 500, schema: Dto } })).toThrow(/success status/);
    });

    it('204 has no body', () => {
      expect(() => define({ success: { status: 204, schema: Dto } })).toThrow(/204/);
      expect(() => define({ success: { status: 204, contentType: 'text/csv' } })).toThrow(/204/);
    });

    it('declares a schema or a content type, not both and not neither', () => {
      expect(() => define({ success: { status: 200 } })).toThrow(/declare success\.schema/);
      expect(() => define({ success: { status: 200, schema: Dto, contentType: 'text/csv' } })).toThrow(/not both/);
      expect(define({ success: { status: 200, contentType: 'text/csv' } }).success.contentType).toBe('text/csv');
    });

    it('validates alsoStatuses', () => {
      expect(define({ success: { status: 200, schema: Dto, alsoStatuses: [503] } }).success.alsoStatuses).toEqual([
        503,
      ]);
      expect(() => define({ success: { status: 200, schema: Dto, alsoStatuses: [200] } })).toThrow(/alsoStatuses/);
      expect(() => define({ success: { status: 200, schema: Dto, alsoStatuses: [99] } })).toThrow(/alsoStatuses/);
      expect(() => define({ success: { status: 200, contentType: 'text/csv', alsoStatuses: [503] } })).toThrow(
        /alsoStatuses needs/,
      );
    });
  });

  describe('list routes', () => {
    const query = listQuery({ sorts: ['name'], defaultSort: { field: 'name', order: 'asc' } });

    it('are recognised by their query and keep the row schema', () => {
      const contract = define({ query });
      expect(contract.success.list).toBe(true);
    });

    it('must be GET, answer 200 and declare the row schema', () => {
      expect(() => define({ key: 'POST /spec/list-post', query, success: { status: 200, schema: Dto } })).toThrow(
        /list route/,
      );
      expect(() => define({ query, success: { status: 201, schema: Dto } })).toThrow(/list route/);
      expect(() => define({ query, success: { status: 200, contentType: 'text/csv' } })).toThrow(/list route/);
    });
  });

  describe('errors', () => {
    it('only knows catalog codes', () => {
      expect(define({ errors: ['NOT_FOUND', 'VALIDATION_FAILED'] }).errors).toEqual(['NOT_FOUND', 'VALIDATION_FAILED']);
      expect(() => define({ errors: ['NOT_A_CODE'] })).toThrow(/unknown error code/);
      expect(() => define({ errors: ['NOT_FOUND', 'NOT_FOUND'] })).toThrow(/twice/);
    });

    it('lists the statuses a route can answer with', () => {
      const contract = define({
        success: { status: 201, schema: Dto, alsoStatuses: [202] },
        errors: ['VALIDATION_FAILED', 'EMAIL_TAKEN', 'UNAUTHORIZED'],
      });
      expect(declaredStatuses(contract as never)).toEqual([201, 202, 401, 409, 422]);
    });
  });

  describe('examples', () => {
    it('must satisfy the schemas they document', () => {
      const post = {
        key: `POST /spec/ex-${(counter += 1)}`,
        body: z.object({ name: z.string() }),
        success: { status: 201, schema: Dto },
      };
      expect(
        define({ ...post, examples: { request: { name: 'x' }, response: { id: 1, name: 'x' } } }).examples.request,
      ).toEqual({ name: 'x' });
      expect(() =>
        define({ ...post, key: `POST /spec/ex-${(counter += 1)}`, examples: { request: { name: 5 } } }),
      ).toThrow(/examples\.request/);
      expect(() =>
        define({ ...post, key: `POST /spec/ex-${(counter += 1)}`, examples: { response: { id: 'x' } } }),
      ).toThrow(/examples\.response/);
      expect(() => define({ examples: { request: {} } })).toThrow(/needs a body/);
    });

    it('document a list as an array of rows', () => {
      const query = listQuery({ sorts: ['name'], defaultSort: { field: 'name', order: 'asc' } });
      expect(define({ query, examples: { response: [{ id: 1, name: 'a' }] } }).examples.response).toHaveLength(1);
      expect(() => define({ query, examples: { response: { id: 1, name: 'a' } } })).toThrow(/array of rows/);
      expect(() => define({ query, examples: { response: [{ id: 'x' }] } })).toThrow(/array of rows/);
    });
  });
});

describe('operationIdOf', () => {
  it('builds a stable camelCase id from the key', () => {
    expect(operationIdOf('GET /admin/staff/:id')).toBe('getAdminStaffById');
    expect(operationIdOf('POST /admin/staff/:id/suspend')).toBe('postAdminStaffByIdSuspend');
    expect(operationIdOf('GET /health')).toBe('getHealth');
    expect(operationIdOf('GET /openapi.json')).toBe('getOpenapiJson');
    expect(operationIdOf('POST /api/index.php')).toBe('postApiIndexPhp');
    expect(operationIdOf('DELETE /admin/clients/:clientId/api-keys/:id')).toBe(
      'deleteAdminClientsByClientIdApiKeysById',
    );
  });
});
