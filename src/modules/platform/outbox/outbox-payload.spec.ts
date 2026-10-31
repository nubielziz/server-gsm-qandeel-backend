// Unit tests of the outbox event checks and packing (decision 020): ids only, the request id travels with the payload, and
// a stored row becomes the data of its job.
import { describe, expect, it } from 'bun:test';
import { assertOutboxEvent, assertOutboxPayload, jobDataOf, packOutboxPayload } from './outbox-payload';
import type { OutboxEventInput } from './outbox.types';

const event = (overrides: Partial<OutboxEventInput> = {}): OutboxEventInput => ({
  type: 'order.status_changed',
  aggregateType: 'orders',
  aggregateId: 42,
  payload: { orderId: 42, status: 'completed' },
  ...overrides,
});

describe('assertOutboxEvent', () => {
  it('accepts a normal event', () => {
    expect(() => assertOutboxEvent(event())).not.toThrow();
    expect(() => assertOutboxEvent(event({ payload: undefined }))).not.toThrow();
    expect(() =>
      assertOutboxEvent(event({ type: 'wallet.low_balance', aggregateType: 'checkout_sessions' })),
    ).not.toThrow();
  });

  it('wants a dotted lower case type', () => {
    for (const type of [
      'order',
      'Order.status',
      'order.Status',
      'order status',
      'order.status-changed',
      '.x',
      'x.',
      'a..b',
      '',
    ]) {
      expect(() => assertOutboxEvent(event({ type })), JSON.stringify(type)).toThrow(/dotted lower case/);
    }
  });

  it('wants a lower case aggregate type and a positive whole aggregate id', () => {
    expect(() => assertOutboxEvent(event({ aggregateType: 'Orders' }))).toThrow(/lower case/);
    expect(() => assertOutboxEvent(event({ aggregateType: 'a.b' }))).toThrow(/lower case/);
    for (const aggregateId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => assertOutboxEvent(event({ aggregateId })), String(aggregateId)).toThrow(/positive whole number/);
    }
  });
});

describe('assertOutboxPayload (ids only)', () => {
  it('accepts ids, short codes, flags, null and short lists', () => {
    expect(() =>
      assertOutboxPayload({
        orderId: 7,
        clientId: '9b1d-uuid',
        supplierCode: 'rapid_imei',
        urgent: true,
        parentId: null,
        itemIds: [1, 2, 3],
        codes: ['a', 'b'],
      }),
    ).not.toThrow();
  });

  it('refuses decimals, so money can never travel in a payload', () => {
    expect(() => assertOutboxPayload({ amount: 12.5 })).toThrow(/whole number/);
    expect(() => assertOutboxPayload({ amount: Number.NaN })).toThrow(/whole number/);
    expect(() => assertOutboxPayload({ amounts: [1, 2.5] })).toThrow(/whole number/);
  });

  it('refuses free text, which is where personal data and secrets hide', () => {
    expect(() => assertOutboxPayload({ note: 'x'.repeat(65) })).toThrow(/64 characters/);
    expect(() => assertOutboxPayload({ note: 'x'.repeat(64) })).not.toThrow();
  });

  it('refuses nested objects, functions, undefined and flags inside lists', () => {
    expect(() => assertOutboxPayload({ client: { id: 1 } } as never)).toThrow(/must be an id/);
    expect(() => assertOutboxPayload({ fn: () => 1 } as never)).toThrow(/must be an id/);
    expect(() => assertOutboxPayload({ nothing: undefined } as never)).toThrow(/must be an id/);
    expect(() => assertOutboxPayload({ flags: [true] } as never)).toThrow(/must be an id/);
    expect(() => assertOutboxPayload([1, 2] as never)).toThrow(/flat object/);
    expect(() => assertOutboxPayload(null as never)).toThrow(/flat object/);
  });

  it('keeps the key "meta" for the relay and wants camelCase keys', () => {
    expect(() => assertOutboxPayload({ meta: 1 })).toThrow(/reserved/);
    expect(() => assertOutboxPayload({ OrderId: 1 })).toThrow(/camelCase/);
    expect(() => assertOutboxPayload({ order_id: 1 })).toThrow(/camelCase/);
  });

  it('limits the number of keys, the length of lists and the total size', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(() => assertOutboxPayload(many)).toThrow(/at most 20 keys/);
    expect(() => assertOutboxPayload({ ids: Array.from({ length: 51 }, (_, i) => i) })).toThrow(/at most 50 elements/);
    // Each part is inside its own limit, but together they are more than 2 KB.
    expect(() => assertOutboxPayload({ codes: Array.from({ length: 50 }, () => 'x'.repeat(64)) })).toThrow(
      /at most 2048 bytes/,
    );
  });
});

describe('packOutboxPayload and jobDataOf', () => {
  it('stores the ids with meta.requestId', () => {
    expect(packOutboxPayload({ orderId: 7 }, 'req-1')).toEqual({ orderId: 7, meta: { requestId: 'req-1' } });
    expect(packOutboxPayload(undefined, 'req-1')).toEqual({ meta: { requestId: 'req-1' } });
  });

  it('stores an empty meta when there is no request id (a job, a script)', () => {
    expect(packOutboxPayload({ orderId: 7 }, undefined)).toEqual({ orderId: 7, meta: {} });
  });

  it('builds the job data from a stored row, with the request id kept apart from the payload', () => {
    const row = {
      id: 1042,
      type: 'order.status_changed',
      aggregateType: 'orders',
      aggregateId: 42,
      payload: packOutboxPayload({ orderId: 42, status: 'completed' }, 'req-9'),
    };
    expect(jobDataOf(row)).toEqual({
      eventId: 1042,
      type: 'order.status_changed',
      aggregateType: 'orders',
      aggregateId: 42,
      payload: { orderId: 42, status: 'completed' },
      requestId: 'req-9',
    });
  });

  it('falls back to outbox-<id> when the row has no usable request id', () => {
    const base = { id: 7, type: 'a.b', aggregateType: 'x', aggregateId: 1 };
    expect(jobDataOf({ ...base, payload: { meta: {} } }).requestId).toBe('outbox-7');
    expect(jobDataOf({ ...base, payload: {} }).requestId).toBe('outbox-7');
    expect(jobDataOf({ ...base, payload: { meta: { requestId: 'bad id with spaces' } } }).requestId).toBe('outbox-7');
    expect(jobDataOf({ ...base, payload: { meta: { requestId: 5 } } }).requestId).toBe('outbox-7');
    expect(jobDataOf({ ...base, payload: { meta: null } }).requestId).toBe('outbox-7');
  });
});
