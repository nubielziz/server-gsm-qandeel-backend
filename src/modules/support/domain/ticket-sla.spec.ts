// Unit tests of the reply targets (RULES support 2, MISMATCHES B62).
import { describe, expect, it } from 'bun:test';
import { TICKET_CATEGORIES } from '../db/schema';
import { PRIORITY_TARGET_MS, defaultPriority, isLate, slaDueAt } from './ticket-sla';

const AT = new Date('2026-11-08T10:00:00.000Z');
const HOUR = 3_600_000;

describe('PRIORITY_TARGET_MS', () => {
  it('is 2 hours for high, 8 for normal and 24 for low (the demo PRIO_TARGET)', () => {
    expect(PRIORITY_TARGET_MS).toEqual({ high: 2 * HOUR, normal: 8 * HOUR, low: 24 * HOUR });
  });
});

describe('defaultPriority', () => {
  it('gives every category a priority: a locked phone and a refund are high, a pre-sale question, a how-to and other are low', () => {
    expect(defaultPriority('failed_unlock')).toBe('high');
    expect(defaultPriority('refund')).toBe('high');
    expect(defaultPriority('delay')).toBe('normal');
    expect(defaultPriority('billing')).toBe('normal');
    expect(defaultPriority('wrong_imei')).toBe('normal');
    expect(defaultPriority('presale')).toBe('low');
    expect(defaultPriority('howto')).toBe('low');
    expect(defaultPriority('other')).toBe('low');
    for (const category of TICKET_CATEGORIES) expect(['high', 'normal', 'low']).toContain(defaultPriority(category));
  });
});

describe('slaDueAt', () => {
  it('is the requester’s last public message plus the target while the ticket is new or open', () => {
    const last = { fromRequester: true, at: AT };
    expect(slaDueAt('new', 'normal', last)?.toISOString()).toBe('2026-11-08T18:00:00.000Z');
    expect(slaDueAt('open', 'high', last)?.toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(slaDueAt('open', 'low', last)?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
  });

  it('is null after a public staff reply, while the ticket waits on the customer, once it is resolved, and without a message', () => {
    expect(slaDueAt('open', 'normal', { fromRequester: false, at: AT })).toBeNull();
    expect(slaDueAt('pending_customer', 'normal', { fromRequester: true, at: AT })).toBeNull();
    expect(slaDueAt('resolved', 'normal', { fromRequester: true, at: AT })).toBeNull();
    expect(slaDueAt('new', 'normal', undefined)).toBeNull();
  });
});

describe('isLate', () => {
  it('is true only when a reply is awaited and its due time has passed', () => {
    const due = new Date(AT.getTime() + HOUR);
    expect(isLate(due, 'open', new Date(AT.getTime() + 2 * HOUR))).toBe(true);
    expect(isLate(due, 'open', AT)).toBe(false);
    expect(isLate(due, 'open', due)).toBe(false);
    expect(isLate(null, 'open', new Date(AT.getTime() + 99 * HOUR))).toBe(false);
    expect(isLate(due, 'resolved', new Date(AT.getTime() + 2 * HOUR))).toBe(false);
  });
});
