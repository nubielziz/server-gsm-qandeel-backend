// Unit tests of the webhook delivery rules: the events, the retry schedule, the envelope and the event id, the stored answer.
import { describe, expect, it } from 'bun:test';
import {
  WEBHOOK_EVENT_NAMES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_BODY_LIMIT,
  buildEnvelope,
  eventIdOf,
  eventKeyOf,
  isWebhookEvent,
  nextStep,
  portalStatusOf,
  retryDelayMs,
  storableBody,
  truncate,
} from './webhook-delivery.rules';

const MINUTE = 60_000;

describe('events', () => {
  it('are the four of the public document', () => {
    expect([...WEBHOOK_EVENT_NAMES]).toEqual([
      'order.status_changed',
      'wallet.low_balance',
      'invoice.paid',
      'service.price_changed',
    ]);
  });

  it('isWebhookEvent knows them, and not ping', () => {
    for (const name of WEBHOOK_EVENT_NAMES) expect(isWebhookEvent(name)).toBe(true);
    expect(isWebhookEvent('ping')).toBe(false);
    expect(isWebhookEvent('order.completed')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('doubles from 10 minutes without jitter', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt, 0) / MINUTE)).toEqual([
      10, 20, 40, 80, 160, 320, 640,
    ]);
  });

  it('adds up to about 21 hours over the seven waits, inside the public "8 attempts over about 24 h"', () => {
    const total = [1, 2, 3, 4, 5, 6, 7].reduce((sum, attempt) => sum + retryDelayMs(attempt, 0), 0);
    expect(total / MINUTE / 60).toBeGreaterThan(20);
    expect(total / MINUTE / 60).toBeLessThan(24);
  });

  it('shaves up to 20 percent off at random and never more', () => {
    expect(retryDelayMs(3, 0.999999)).toBeGreaterThanOrEqual(40 * MINUTE * 0.8);
    expect(retryDelayMs(3, 0.5)).toBe(36 * MINUTE);
    expect(retryDelayMs(3, 0)).toBe(40 * MINUTE);
  });

  it('refuses an attempt number that is not a whole number from 1', () => {
    expect(() => retryDelayMs(0, 0)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5, 0)).toThrow(RangeError);
  });
});

describe('nextStep', () => {
  it('schedules a retry after each of the first seven failures', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      expect(nextStep(attempt, false, 0)).toEqual({
        kind: 'retry',
        attempt: attempt + 1,
        delayMs: retryDelayMs(attempt, 0),
      });
    }
  });

  it('gives up after the eighth, and after any attempt past it (a manual retry is one more try)', () => {
    expect(nextStep(8, false, 0)).toEqual({ kind: 'give_up' });
    expect(nextStep(9, false, 0)).toEqual({ kind: 'give_up' });
  });

  it('gives up at once on a refusal that cannot change', () => {
    expect(nextStep(1, true, 0)).toEqual({ kind: 'give_up' });
  });
});

describe('truncate and storableBody', () => {
  it('truncate keeps short text and cuts long text with an ellipsis inside the limit', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('storableBody is null for an empty body and cuts a long one to the stored limit', () => {
    expect(storableBody(new Uint8Array())).toBeNull();
    const long = storableBody(new TextEncoder().encode('a'.repeat(WEBHOOK_RESPONSE_BODY_LIMIT * 3)));
    expect(long?.length).toBe(WEBHOOK_RESPONSE_BODY_LIMIT);
  });

  it('storableBody drops NUL characters, which Postgres refuses in text, and survives binary bytes', () => {
    expect(storableBody(new TextEncoder().encode('ok\u0000ok'))).toBe('okok');
    const binary = storableBody(Uint8Array.from([0xff, 0xfe, 0x00, 0x41]));
    expect(binary).not.toContain('\u0000');
    expect(binary?.endsWith('A')).toBe(true);
  });
});

describe('the envelope and the event id', () => {
  it('buildEnvelope is { id, type, createdAt, data } with an ISO time', () => {
    expect(buildEnvelope('evt_1', 'ping', new Date('2026-11-01T09:30:00.000Z'), { a: 1 })).toEqual({
      id: 'evt_1',
      type: 'ping',
      createdAt: '2026-11-01T09:30:00.000Z',
      data: { a: 1 },
    });
  });

  it('eventIdOf is evt_ and 24 characters of the hash', () => {
    expect(eventIdOf('0123456789abcdef0123456789abcdef0123')).toBe('evt_0123456789abcdef01234567');
  });

  it('eventKeyOf is the outbox row for most events and what changed for a price change', () => {
    expect(eventKeyOf('order.status_changed', 41, { orderId: 9 })).toBe('order.status_changed:41');
    const change = { clientId: 5, serviceId: 12, previousPrice: '4.5000', price: '4.8000' };
    expect(eventKeyOf('service.price_changed', 41, change)).toBe('service.price_changed:5:12:4.5000:4.8000');
    // The same change found by another scan (another outbox row) has the same key.
    expect(eventKeyOf('service.price_changed', 99, change)).toBe(eventKeyOf('service.price_changed', 41, change));
  });
});

describe('portalStatusOf', () => {
  it('words a delivered delivery as succeeded for the portal (B156)', () => {
    expect(portalStatusOf('delivered')).toBe('succeeded');
    expect(portalStatusOf('pending')).toBe('pending');
    expect(portalStatusOf('failed')).toBe('failed');
  });
});
