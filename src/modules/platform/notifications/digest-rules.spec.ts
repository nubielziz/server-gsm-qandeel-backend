// Unit tests of the price change digest rules (feature 12a, user rule 9).
import { describe, expect, it } from 'bun:test';
import {
  type DigestItem,
  MAX_DIGEST_ITEMS,
  MIN_DIGEST_DELAY_MS,
  addDigestItem,
  describeChanges,
  digestCycleOf,
  digestKey,
  digestSendDelay,
  shortMoney,
} from './digest-rules';

describe('digestCycleOf', () => {
  it('puts a moment in the period that started at the last 06:00 UTC and ends at the next', () => {
    const cycle = digestCycleOf(new Date('2026-11-07T10:30:00.000Z'));
    expect(cycle.day).toBe('2026-11-07');
    expect(cycle.startsAt.toISOString()).toBe('2026-11-07T06:00:00.000Z');
    expect(cycle.sendAt.toISOString()).toBe('2026-11-08T06:00:00.000Z');
  });

  it('keeps the small hours in the day before, and a change at exactly 06:00 in the new period', () => {
    expect(digestCycleOf(new Date('2026-11-07T05:59:59.999Z')).day).toBe('2026-11-06');
    expect(digestCycleOf(new Date('2026-11-07T05:59:59.999Z')).sendAt.toISOString()).toBe('2026-11-07T06:00:00.000Z');
    expect(digestCycleOf(new Date('2026-11-07T06:00:00.000Z')).day).toBe('2026-11-07');
  });

  it('crosses a month and a year end', () => {
    expect(digestCycleOf(new Date('2026-12-31T23:00:00.000Z')).sendAt.toISOString()).toBe('2027-01-01T06:00:00.000Z');
    expect(digestCycleOf(new Date('2027-01-01T01:00:00.000Z')).day).toBe('2026-12-31');
  });

  it('names a merchant, a channel and a day in the dedupe key', () => {
    const key = digestKey('service.price_changed', 'email', 7, digestCycleOf(new Date('2026-11-07T10:00:00.000Z')));
    expect(key).toBe('digest:service.price_changed:email:7:2026-11-07');
  });
});

describe('digestSendDelay', () => {
  const delayAt = (iso: string) => {
    const now = new Date(iso);
    return digestSendDelay(digestCycleOf(now), now);
  };

  it('is the time left until 06:00 UTC when that is longer than the floor', () => {
    expect(delayAt('2026-11-07T10:30:00.000Z')).toBe(19.5 * 3_600_000);
    expect(delayAt('2026-11-07T05:59:00.000Z')).toBe(60_000);
    expect(delayAt('2026-11-07T06:00:00.000Z')).toBe(24 * 3_600_000);
  });

  it('never goes below 10 seconds, so the job cannot run before the row commits', () => {
    expect(MIN_DIGEST_DELAY_MS).toBe(10_000);
    expect(delayAt('2026-11-07T05:59:59.995Z')).toBe(10_000);
    expect(delayAt('2026-11-07T05:59:59.999Z')).toBe(10_000);
    expect(delayAt('2026-11-07T05:59:55.000Z')).toBe(10_000);
    expect(delayAt('2026-11-07T05:59:49.000Z')).toBe(11_000);
  });
});

const item = (eventId: number): DigestItem => ({
  eventId,
  serviceId: eventId,
  serviceName: `Service ${eventId}`,
  previousPrice: '12.0000',
  price: '12.5000',
  currency: 'USD',
});

describe('addDigestItem', () => {
  it('adds an item once per event and stops at the cap', () => {
    const one = addDigestItem([], item(1));
    expect(addDigestItem(one, item(1))).toBe(one);
    expect(addDigestItem(one, item(2))).toHaveLength(2);
    const full = Array.from({ length: MAX_DIGEST_ITEMS }, (_, index) => item(index + 1));
    expect(addDigestItem(full, item(999))).toBe(full);
  });
});

describe('describeChanges and shortMoney', () => {
  it('writes one line per service with both prices', () => {
    expect(describeChanges([item(1), { ...item(2), previousPrice: null, price: '3.1250' }])).toBe(
      '- Service 1: 12.00 to 12.50 USD\n- Service 2: now 3.125 USD',
    );
  });

  it('shows at least two decimals and no useless zeros', () => {
    expect(shortMoney('12.0000')).toBe('12.00');
    expect(shortMoney('12.3400')).toBe('12.34');
    expect(shortMoney('12.3456')).toBe('12.3456');
    expect(shortMoney('7')).toBe('7.00');
    expect(shortMoney('n/a')).toBe('n/a');
  });
});
