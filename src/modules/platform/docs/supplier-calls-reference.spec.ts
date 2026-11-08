// Unit tests of the supplier calls in the internal OpenAPI document: the extension, the description and the rule that the public document never
// lists them. Contracts are defined in a registry of their own, so the process-wide one keeps the four real calls.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { SupplierCallRegistry, defineSupplierCall } from '../../../common/contract';
import { buildInternalDocument, buildPublicDocument } from './openapi-documents';
import type { OpenApiDocument } from './openapi-types';
import { SUPPLIER_CALLS_EXTENSION, describeSupplierCalls } from './supplier-calls-reference';

const registry = new SupplierCallRegistry();
const info = defineSupplierCall(
  {
    key: 'SUPPLIER accountinfo',
    summary: 'Our balance at the supplier',
    success: z.looseObject({ credit: z.string() }),
    examples: { response: { credit: '1.0000' }, error: { MESSAGE: 'Authentication Failed' } },
  },
  registry,
);
const place = defineSupplierCall(
  {
    key: 'SUPPLIER placeimeiorder+placeimeiorderbulk',
    summary: 'Send an order',
    description: 'The bulk variant is never sent.',
    params: z.object({ ID: z.string() }),
    success: z.looseObject({ REFERENCEID: z.string() }),
    examples: { request: { ID: '4411' }, response: { REFERENCEID: '88121' } },
  },
  registry,
);

const raw = (): OpenApiDocument => ({ openapi: '3.1.0', info: { title: 'raw', version: '0' }, paths: {} });

describe('describeSupplierCalls', () => {
  it('lists every call in x-gsm-supplier-calls, with its transport, bulk variant, schemas and examples', () => {
    const doc = raw();
    describeSupplierCalls(doc, [info, place]);
    const [first, second] = doc[SUPPLIER_CALLS_EXTENSION] as Array<Record<string, unknown>>;
    expect(first).toMatchObject({
      key: 'SUPPLIER accountinfo',
      action: 'accountinfo',
      bulk: null,
      parameters: null,
      transport: { method: 'POST', path: '<supplier>/api/index.php' },
      success: { type: 'object', properties: { credit: { type: 'string' } } },
      examples: { answer: { SUCCESS: [{ credit: '1.0000' }] }, refusal: { ERROR: [{ MESSAGE: 'Authentication Failed' }] } },
    });
    expect(first?.examples).not.toHaveProperty('parameters');
    expect(second).toMatchObject({
      key: 'SUPPLIER placeimeiorder+placeimeiorderbulk',
      action: 'placeimeiorder',
      bulk: { action: 'placeimeiorderbulk', sent: false },
      description: 'The bulk variant is never sent.',
      parameters: { type: 'object', properties: { ID: { type: 'string' } } },
      examples: { parameters: { ID: '4411' }, answer: { SUCCESS: [{ REFERENCEID: '88121' }] } },
    });
  });

  it('names the calls in the description, with the state of the bulk variant', () => {
    const doc = raw();
    describeSupplierCalls(doc, [info, place]);
    expect(doc.info.description).toContain('**Supplier calls.**');
    expect(doc.info.description).toContain('- `accountinfo`: Our balance at the supplier.');
    expect(doc.info.description).toContain('- `placeimeiorder`: Send an order. Bulk variant `placeimeiorderbulk`: never sent.');
  });

  it('adds nothing when there are no calls', () => {
    const doc = raw();
    describeSupplierCalls(doc, []);
    expect(doc).toEqual(raw());
  });
});

describe('the OpenAPI documents', () => {
  it('list the supplier calls in the internal document only', () => {
    const calls = [info, place];
    expect(buildInternalDocument(raw(), calls)[SUPPLIER_CALLS_EXTENSION]).toHaveLength(2);
    expect(buildInternalDocument(raw())[SUPPLIER_CALLS_EXTENSION]).toBeUndefined();
    expect(buildPublicDocument(raw())[SUPPLIER_CALLS_EXTENSION]).toBeUndefined();
    expect(JSON.stringify(buildPublicDocument(raw()))).not.toContain('Supplier calls');
  });
});
