// Integration test: the @Route decorator feeds @nestjs/swagger, so SwaggerModule builds a faithful OpenAPI 3.1 document
// from the contracts (decision 008). The platform module serves the documents (src/modules/platform/docs, see
// docs.test.ts); here only the metadata is checked.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type TestApp, createTestApp } from '../support/app';
import { TestController } from '../support/routes';

// A loose view of the generated document: the test walks it with plain property access.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenAPI documents are free-form JSON.

let t: TestApp;
let doc: Json;
beforeAll(async () => {
  t = await createTestApp({ controllers: [TestController] });
  // autoTagControllers: false keeps the contract's own tags (buildOpenApiDocuments passes it too, or controllers add a tag each).
  doc = SwaggerModule.createDocument(
    t.app,
    new DocumentBuilder().setTitle('test').setVersion('0').setOpenAPIVersion('3.1.0').build(),
    {
      autoTagControllers: false,
    },
  );
});
afterAll(async () => {
  await t.close();
});

const param = (operation: Json, name: string) => operation.parameters.find((p: Json) => p.name === name);

describe('operations', () => {
  it('names the path with braces and the operation from the manifest key', () => {
    const op = doc.paths['/t/items/{id}'].get;
    expect(op.operationId).toBe('getTItemsById');
    expect(op.summary).toBe('Show an item');
    expect(op.description).toContain('Sample route');
    expect(op.tags).toEqual(['test']);
    expect(op['x-gsm-key']).toBe('GET /t/items/:id');
    expect(op['x-gsm-access']).toBe('public');
    // The surface lets the documents be filtered (the public one keeps v1 and the Dhru reference, decision 017).
    expect(op['x-gsm-surface']).toBe('system');
    expect(doc.paths['/admin/t/secure'].get['x-gsm-surface']).toBe('admin');
    expect(doc.paths['/api/index.php'].post['x-gsm-surface']).toBe('dhru');
  });

  it('documents the path id as the text a client sends, with the Id alias', () => {
    const id = param(doc.paths['/t/items/{id}'].get, 'id');
    expect(id).toMatchObject({ in: 'path', required: true });
    expect(id.schema).toMatchObject({ type: 'string', 'x-gsm-alias': 'Id' });
  });

  it('documents every route of the contract registry with a unique operationId', () => {
    const ids = Object.values(doc.paths).flatMap((item: Json) => Object.values(item).map((op: Json) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/health', '/metrics', '/t/items', '/t/items/{id}', '/admin/t/secure']),
    );
  });

  it('adds the permission and security scheme of a staff route', () => {
    const op = doc.paths['/admin/t/secure'].get;
    expect(op['x-gsm-permission']).toBe('staff:read');
    expect(op['x-gsm-access']).toBe('staff-permission');
    expect(op.security).toEqual([{ staffSession: [] }]);
    expect(doc.paths['/t/items'].get.security).toBeUndefined();
    expect(doc.paths['/metrics'].get.security).toEqual([{ metricsAccess: [] }]);
  });
});

describe('request documentation', () => {
  it('documents the body schema with aliases and the example', () => {
    const body = doc.paths['/t/items'].post.requestBody;
    expect(body.required).toBe(true);
    const schema = body.content['application/json'].schema;
    expect(schema.required).toEqual(['name', 'price']);
    expect(schema.properties.price['x-gsm-alias']).toBe('Money');
    expect(schema.properties.lines.items.properties.imei).toMatchObject({
      type: 'string',
      minLength: 15,
      maxLength: 15,
    });
    expect(body.content['application/json'].examples.example.value).toEqual({ name: 'Phone', price: '99.0000' });
  });

  it('documents declared headers', () => {
    const header = param(doc.paths['/t/headers'].post, 'idempotency-key');
    expect(header).toMatchObject({ in: 'header', required: true });
    expect(header.schema.minLength).toBe(8);
  });

  it('documents the list dialect: range, sort, search, filters and operators', () => {
    const op = doc.paths['/t/items'].get;
    const names = op.parameters.map((p: Json) => p.name);
    for (const expected of [
      '_start',
      '_end',
      '_sort',
      '_order',
      'q',
      'status',
      'status_ne',
      'createdAt_gte',
      'createdAt_lte',
      'role.id',
      'name',
      'name_ne',
      'name_like',
      'open',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('status_like');
    expect(param(op, 'status')).toMatchObject({ in: 'query', style: 'form', explode: true, required: false });
    expect(param(op, 'status').schema).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['active', 'suspended'] },
    });
    expect(param(op, '_sort').description).toContain('name, createdAt');
    expect(param(op, '_end').description).toContain('1000');
  });

  it('documents a plain query parameter with its description', () => {
    expect(param(doc.paths['/health'].get, 'strict')).toMatchObject({ in: 'query', required: false });
  });
});

describe('response documentation', () => {
  it('documents the success schema without the long ISO pattern or $schema', () => {
    const schema = doc.paths['/t/items/{id}'].get.responses['200'].content['application/json'].schema;
    expect(schema.properties.createdAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      'x-gsm-alias': 'IsoDateTime',
    });
    expect(schema.properties.createdAt.pattern).toBeUndefined();
    expect(schema.properties.price.pattern).toBe('^-?\\d+\\.\\d{4}$');
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('"$schema"');
  });

  it('documents a list as an array with the x-total-count header', () => {
    const response = doc.paths['/t/items'].get.responses['200'];
    expect(response.content['application/json'].schema).toMatchObject({ type: 'array', items: { type: 'object' } });
    expect(response.headers['x-total-count']).toMatchObject({ schema: { type: 'integer', minimum: 0 } });
    expect(response.content['application/json'].example).toEqual([{ id: 1, name: 'Item 1' }]);
  });

  it('documents the contract status: 201 for the create, 204 without a body', () => {
    expect(Object.keys(doc.paths['/t/items'].post.responses)).toEqual(expect.arrayContaining(['201', '409', '422']));
    expect(doc.paths['/t/items'].post.responses['200']).toBeUndefined();
    expect(doc.paths['/t/items/{id}'].delete.responses['204'].content).toBeUndefined();
  });

  it('documents a file answer by its media type', () => {
    expect(doc.paths['/t/report'].get.responses['200'].content['text/csv'].schema).toEqual({ type: 'string' });
    // A free-form JSON answer (GET /openapi.json) is an object, not text.
    expect(doc.paths['/openapi.json'].get.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
    });
    expect(doc.paths['/metrics'].get.responses['200'].content['text/plain']).toBeDefined();
  });

  it('documents errors as problem+json, grouped by status, with the codes and an example each', () => {
    const responses = doc.paths['/t/items'].post.responses;
    const conflict = responses['409'].content['application/problem+json'];
    expect(conflict.schema.properties.code.enum).toEqual(['EMAIL_TAKEN']);
    expect(conflict.schema.properties.status.const).toBe(409);
    expect(conflict.examples.EMAIL_TAKEN.value).toMatchObject({
      code: 'EMAIL_TAKEN',
      title: 'This email address is already in use.',
      status: 409,
    });
    expect(responses['422'].content['application/problem+json'].schema.required).toEqual([
      'type',
      'title',
      'status',
      'code',
      'detail',
      'requestId',
    ]);
    expect(responses['422'].headers['x-request-id']).toBeDefined();
  });

  it('documents the strict health answer: 503 with the normal body', () => {
    const responses = doc.paths['/health'].get.responses;
    expect(Object.keys(responses).sort()).toEqual(['200', '422', '503']);
    expect(responses['503'].content['application/json'].schema).toEqual(
      responses['200'].content['application/json'].schema,
    );
  });

  it('puts the 403 of /metrics in the document', () => {
    expect(
      doc.paths['/metrics'].get.responses['403'].content['application/problem+json'].schema.properties.code.enum,
    ).toEqual(['FORBIDDEN']);
  });
});
