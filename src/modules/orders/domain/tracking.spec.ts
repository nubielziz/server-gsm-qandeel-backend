// Unit tests of the public order tracking rules (feature 14a).
import { describe, expect, it } from 'bun:test';
import { ORDER_EVENT_TYPES } from '../db/schema';
import { TRACKING_EVENT_TYPES, TRACKING_EVENT_WORDS, maskInput } from './tracking';

describe('TRACKING_EVENT_TYPES', () => {
  it('shows only types the order engine writes, and none of the staff-only ones', () => {
    for (const type of TRACKING_EVENT_TYPES) expect(ORDER_EVENT_TYPES as readonly string[]).toContain(type);
    for (const hidden of [
      'hold',
      'dispatch',
      'ack',
      'settle',
      'release',
      'retry',
      'review',
      'supplier_changed',
      'verification',
      'note',
      'risk',
      'notify',
      'dispute',
      'fetch',
    ]) {
      expect(TRACKING_EVENT_TYPES as string[], hidden).not.toContain(hidden);
    }
    expect(TRACKING_EVENT_WORDS.created).toBe('Order received');
  });
});

describe('maskInput', () => {
  it('keeps the last four characters', () => {
    expect(maskInput('353890110000004')).toBe('•••••••••••0004');
    expect(maskInput('sam_01')).toBe('••m_01');
    expect(maskInput(' 12345 ')).toBe('•2345');
  });

  it('hides a short input completely and says nothing for an empty one', () => {
    expect(maskInput('abc')).toBe('•••');
    expect(maskInput('abcd')).toBe('••••');
    expect(maskInput('')).toBeNull();
    expect(maskInput('   ')).toBeNull();
    expect(maskInput(null)).toBeNull();
  });
});
