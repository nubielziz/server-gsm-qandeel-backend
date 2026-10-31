// Unit tests of queueJobId (decision 020): ids BullMQ accepts, built from a kind and the ids of the occurrence.
import { describe, expect, it } from 'bun:test';
import { queueJobId } from './job-id';

describe('queueJobId', () => {
  it('joins the kind and the ids with a hyphen', () => {
    expect(queueJobId('outbox', 1042)).toBe('outbox-1042');
    expect(queueJobId('order-poll', 77)).toBe('order-poll-77');
    expect(queueJobId('manual', 12, 'retry')).toBe('manual-12-retry');
  });

  it('is a pure function of its parts, so the same occurrence always gets the same id', () => {
    expect(queueJobId('outbox', 5)).toBe(queueJobId('outbox', 5));
    expect(queueJobId('outbox', 5)).not.toBe(queueJobId('outbox', 6));
  });

  it('refuses what BullMQ refuses: a colon, or an id that is only digits', () => {
    expect(() => queueJobId('outbox:5', 1)).toThrow(RangeError);
    expect(() => queueJobId('outbox', 'a:b')).toThrow(RangeError);
    expect(() => queueJobId('1', 2)).toThrow(/start with a letter/);
    expect(() => queueJobId(7, 8)).toThrow(/start with a letter/);
  });

  it('refuses a missing id, an empty part and odd characters', () => {
    expect(() => queueJobId('outbox')).toThrow(/kind and at least one id/);
    expect(() => queueJobId('outbox', '')).toThrow(RangeError);
    expect(() => queueJobId('outbox', 'a b')).toThrow(RangeError);
    expect(() => queueJobId('outbox', 'a/b')).toThrow(RangeError);
  });

  it('refuses an id longer than 200 characters', () => {
    expect(() => queueJobId('outbox', 'x'.repeat(200))).toThrow(/at most 200/);
    expect(queueJobId('outbox', 'x'.repeat(193))).toHaveLength(200);
  });
});
