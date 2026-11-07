// Unit tests of the delivery time reading (resolution orders-suppliers-10).
import { describe, expect, it } from 'bun:test';
import { slaMinutesOf } from './sla-time';

describe('slaMinutesOf', () => {
  it.each([
    ['Instant', 1440, 5],
    ['instant delivery', 1440, 5],
    ['30 min', 1440, 30],
    ['45 Minutes', 1440, 45],
    ['1-2 hours', 1440, 120],
    ['3 hours', 1440, 180],
    ['1-3 days', 1440, 4320],
    ['2 days', 1440, 2880],
    ['5-10 min', 1440, 10],
  ])('reads %s as the upper bound in minutes', (text, fallback, expected) => {
    expect(slaMinutesOf(text, fallback)).toBe(expected);
  });

  it('uses the fallback when the text cannot be read or gives zero', () => {
    expect(slaMinutesOf('', 1440)).toBe(1440);
    expect(slaMinutesOf('soon', 600)).toBe(600);
    expect(slaMinutesOf('0 min', 600)).toBe(600);
    expect(slaMinutesOf('5 fortnights', 600)).toBe(600);
  });
});
