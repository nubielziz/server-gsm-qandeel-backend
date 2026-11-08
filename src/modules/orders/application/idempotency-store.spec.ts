// Unit tests of what an Idempotency-Key stands for (ALIGNMENT § 7): the hash of the scope and the body is equal for two spellings of one
// request and different for any other. The replay and the locking are integration tests (test/integration/rest-v1-idempotency.test.ts).
import { describe, expect, it } from 'bun:test';
import type { Clock } from '../../../common/clock';
import type { TokenService } from '../../../infra/crypto';
import { IdempotencyStore } from './idempotency-store';

// The store hashes through the token service; an identity "hash" lets the tests read the canonical text.
const store = new IdempotencyStore({ hash: (text: string) => text } as unknown as TokenService, {} as Clock);

describe('IdempotencyStore.hashOf', () => {
  it('is equal for two spellings of one body: the order of keys, at any depth, does not matter', () => {
    const a = store.hashOf('order', { serviceId: 5, imei: '352905112490861', inputs: { a: '1', b: '2' } });
    const b = store.hashOf('order', { inputs: { b: '2', a: '1' }, imei: '352905112490861', serviceId: 5 });
    expect(a).toBe(b);
  });

  it('leaves out keys that are undefined (an optional field not sent), but not null or empty text', () => {
    expect(store.hashOf('order', { serviceId: 5, quantity: undefined })).toBe(store.hashOf('order', { serviceId: 5 }));
    expect(store.hashOf('order', { serviceId: 5, quantity: null })).not.toBe(store.hashOf('order', { serviceId: 5 }));
    expect(store.hashOf('order', { serviceId: 5, imei: '' })).not.toBe(store.hashOf('order', { serviceId: 5 }));
  });

  it('is different for another value, another type of value, another list order and the other scope', () => {
    const base = store.hashOf('order', { serviceId: 5, imei: '1' });
    expect(store.hashOf('order', { serviceId: 5, imei: '2' })).not.toBe(base);
    expect(store.hashOf('order', { serviceId: '5', imei: '1' })).not.toBe(base);
    expect(store.hashOf('bulk', { serviceId: 5, imei: '1' })).not.toBe(base);
    const one = store.hashOf('bulk', { orders: [{ serviceId: 1 }, { serviceId: 2 }] });
    expect(store.hashOf('bulk', { orders: [{ serviceId: 2 }, { serviceId: 1 }] })).not.toBe(one);
    expect(store.hashOf('bulk', { orders: [{ serviceId: 1 }] })).not.toBe(one);
  });

  it('cannot be fooled by text that looks like structure', () => {
    expect(store.hashOf('order', { a: 'x","b":"y' })).not.toBe(store.hashOf('order', { a: 'x', b: 'y' }));
    expect(store.hashOf('order', { 'a","b":"1': '2' })).not.toBe(store.hashOf('order', { a: '1', b: '2' }));
  });
});
