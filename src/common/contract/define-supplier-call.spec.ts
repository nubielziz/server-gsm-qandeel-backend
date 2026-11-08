// Unit tests of defineSupplierCall (decision 026): the key forms, the definition-time checks, the answer envelope and the registry. Every test
// uses its own registry, so the process-wide one keeps the four real calls.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  type AnySupplierCall,
  SupplierCallRegistry,
  defineSupplierCall,
  supplierCallRegistry,
} from './define-supplier-call';

const success = z.looseObject({ MESSAGE: z.string() });
const spec = (overrides: Record<string, unknown> = {}) => ({
  key: 'SUPPLIER specaction' as const,
  summary: 'A spec call',
  success,
  ...overrides,
});
const define = (overrides: Record<string, unknown> = {}, registry = new SupplierCallRegistry()) =>
  defineSupplierCall(spec(overrides) as never, registry);

describe('defineSupplierCall', () => {
  it('freezes the contract, takes the action from the key and registers it', () => {
    const registry = new SupplierCallRegistry();
    const contract = define(
      { params: z.object({ ID: z.string() }), examples: { request: { ID: '1' }, response: { MESSAGE: 'ok' } } },
      registry,
    );
    expect(contract.key).toBe('SUPPLIER specaction');
    expect(contract.action).toBe('specaction');
    expect(contract.bulkAction).toBeNull();
    expect(contract.sendsBulk).toBe(false);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(registry.get('SUPPLIER specaction')).toBe(contract);
    expect(registry.forAction('specaction')).toBe(contract);
  });

  it('accepts the key of a call with its bulk variant, which must be the action plus "bulk"', () => {
    const contract = define({
      key: 'SUPPLIER placeit+placeitbulk',
      description: 'The bulk variant is never sent.',
    });
    expect(contract.action).toBe('placeit');
    expect(contract.bulkAction).toBe('placeitbulk');
    expect(contract.sendsBulk).toBe(false);
    expect(
      define({ key: 'SUPPLIER placeit+placeitbulk', description: 'Bulk is sent.', sendsBulk: true }).sendsBulk,
    ).toBe(true);
    expect(() => define({ key: 'SUPPLIER placeit+placethem', description: 'bulk' })).toThrow('must be "placeitbulk"');
  });

  it('refuses a key that is not "SUPPLIER <action>", an empty or long summary', () => {
    for (const key of [
      'DHRU placeimeiorder',
      'SUPPLIER Bad_Name',
      'SUPPLIER ',
      'SUPPLIER a+',
      'POST /x',
      'SUPPLIER a+abulk+abulk',
    ]) {
      expect(() => define({ key }), key).toThrow('the key must look like');
    }
    expect(() => define({ summary: '  ' })).toThrow('summary');
    expect(() => define({ summary: 'x'.repeat(121) })).toThrow('summary');
  });

  it('wants a description that says what happens with the bulk variant, and sendsBulk only where there is one', () => {
    expect(() => define({ key: 'SUPPLIER placeit+placeitbulk' })).toThrow(
      'says whether the client sends the bulk call',
    );
    expect(() => define({ key: 'SUPPLIER placeit+placeitbulk', description: 'Orders one at a time.' })).toThrow(
      'says whether the client sends the bulk call',
    );
    expect(() => define({ sendsBulk: true })).toThrow('needs a bulk variant');
  });

  it('checks the examples against the schemas, so documentation never shows an answer the client would refuse', () => {
    expect(() => define({ examples: { request: { ID: '1' } } })).toThrow('needs a params schema');
    expect(() => define({ params: z.object({ ID: z.string() }), examples: { request: { ID: 1 } } })).toThrow(
      'examples.request does not satisfy',
    );
    expect(() => define({ examples: { response: { WRONG: 1 } } })).toThrow('examples.response does not satisfy');
    expect(() => define({ examples: { error: { WRONG: 1 } } })).toThrow('examples.error does not satisfy');
    expect(define({ examples: { error: { MESSAGE: 'Authentication Failed' } } }).examples.error).toEqual({
      MESSAGE: 'Authentication Failed',
    });
  });

  it('describes the whole answer: a SUCCESS list of entries or an ERROR list, extra members ignored', () => {
    const { answer } = define();
    expect(answer.safeParse({ SUCCESS: [{ MESSAGE: 'ok', more: 1 }], apiversion: '6.1' }).success).toBe(true);
    expect(answer.safeParse({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' }).success).toBe(true);
    expect(answer.safeParse({ SUCCESS: [] }).success).toBe(false);
    expect(answer.safeParse({ SUCCESS: [{ MESSAGE: 5 }] }).success).toBe(false);
    expect(answer.safeParse({ ERROR: [{ nope: 1 }] }).success).toBe(false);
    expect(answer.safeParse({ something: 1 }).success).toBe(false);
  });

  it('takes the error entry of the spec when it has one', () => {
    const { answer, error } = define({ error: z.object({ CODE: z.number() }) });
    expect(error.safeParse({ CODE: 1 }).success).toBe(true);
    expect(answer.safeParse({ ERROR: [{ CODE: 1 }] }).success).toBe(true);
    expect(answer.safeParse({ ERROR: [{ MESSAGE: 'x' }] }).success).toBe(false);
  });

  it('refuses to define a key, an action or a bulk action twice', () => {
    const registry = new SupplierCallRegistry();
    define({}, registry);
    expect(() => define({}, registry)).toThrow('defined twice');
    define({ key: 'SUPPLIER placeit+placeitbulk', description: 'bulk is never sent' }, registry);
    expect(() => define({ key: 'SUPPLIER placeit', summary: 'again' }, registry)).toThrow('defined twice');
    expect(() => define({ key: 'SUPPLIER placeitbulk' }, registry)).toThrow('defined twice');
  });
});

describe('SupplierCallRegistry', () => {
  it('keeps definition order, finds by key and by action (bulk included) and can be cleared', () => {
    const registry = new SupplierCallRegistry();
    const a = { key: 'SUPPLIER a', action: 'a', bulkAction: null } as unknown as AnySupplierCall;
    const b = { key: 'SUPPLIER b+bbulk', action: 'b', bulkAction: 'bbulk' } as unknown as AnySupplierCall;
    registry.register(a);
    registry.register(b);
    expect(registry.all()).toEqual([a, b]);
    expect(registry.keys()).toEqual(['SUPPLIER a', 'SUPPLIER b+bbulk']);
    expect(registry.get('SUPPLIER b+bbulk')).toBe(b);
    expect(registry.has('SUPPLIER a')).toBe(true);
    expect(registry.has('SUPPLIER c')).toBe(false);
    expect(registry.forAction('b')).toBe(b);
    expect(registry.forAction('bbulk')).toBe(b);
    expect(registry.forAction('c')).toBeUndefined();
    expect(() => registry.register(a)).toThrow('defined twice');
    registry.clear();
    expect(registry.all()).toEqual([]);
  });

  it('is empty for a registry of its own; the process-wide one is filled by the suppliers module', () => {
    expect(new SupplierCallRegistry().all()).toEqual([]);
    expect(supplierCallRegistry).toBeInstanceOf(SupplierCallRegistry);
  });
});
