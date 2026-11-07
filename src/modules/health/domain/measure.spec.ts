// Unit tests of the measured-value rules: states against thresholds, rounding by unit, the worst-of fold.
import { describe, expect, it } from 'bun:test';
import { SPEC, latencySpec, measure, roundFor, stateOf, worst } from './measure';

describe('stateOf', () => {
  it('has no verdict without a value, and compares strictly beyond the limit on the bad side', () => {
    expect(stateOf(SPEC.apiP95, null)).toBe('unknown');
    expect(stateOf(SPEC.apiP95, Number.NaN)).toBe('unknown');
    expect(stateOf(SPEC.apiP95, 800)).toBe('ok');
    expect(stateOf(SPEC.apiP95, 801)).toBe('warn');
    expect(stateOf(SPEC.apiP95, 1501)).toBe('crit');
  });

  it('reads the below direction for uptime and hit rate', () => {
    expect(stateOf(SPEC.uptime, 99.95)).toBe('ok');
    expect(stateOf(SPEC.uptime, 99.7)).toBe('warn');
    expect(stateOf(SPEC.uptime, 99.4)).toBe('crit');
    expect(stateOf(SPEC.hitRate, 95)).toBe('ok');
    expect(stateOf(SPEC.hitRate, 69)).toBe('crit');
  });

  it('treats a figure without limits as ok when it has a value', () => {
    expect(stateOf(SPEC.traffic, 12)).toBe('ok');
    expect(stateOf(SPEC.alertsOpen, 0)).toBe('ok');
  });
});

describe('measure', () => {
  it('rounds by unit and judges the rounded value', () => {
    expect(measure(SPEC.rate5xx, 0.4999)).toMatchObject({
      value: 0.5,
      state: 'ok',
      warn: 0.5,
      crit: 2,
      direction: 'above',
    });
    expect(measure(SPEC.redisLatency, 0.44)).toMatchObject({ value: 0.4, state: 'ok' });
    expect(measure(SPEC.apiP95, 812.6)).toMatchObject({ value: 813, state: 'warn' });
    expect(measure(SPEC.traffic, 12.34)).toEqual({ value: 12.3, unit: 'per_min', state: 'ok' });
    expect(measure(SPEC.queueAge, null)).toMatchObject({ value: null, state: 'unknown', unit: 's' });
  });

  it('rounds seconds to one decimal only while small', () => {
    expect(roundFor('s', 3.26)).toBe(3.3);
    expect(roundFor('s', 125.6)).toBe(126);
    expect(roundFor('count', 4.4)).toBe(4);
  });
});

describe('worst and latencySpec', () => {
  it('orders crit, warn, unknown, ok', () => {
    expect(worst(['ok', 'warn', 'crit'])).toBe('crit');
    expect(worst(['ok', 'unknown', 'warn'])).toBe('warn');
    expect(worst(['ok', 'unknown'])).toBe('unknown');
    expect(worst([])).toBe('ok');
  });

  it('gives each component kind its limits', () => {
    expect(latencySpec('postgres')).toMatchObject({ warn: 100, crit: 500 });
    expect(latencySpec('supplier:3')).toMatchObject({ warn: 2000, crit: 5000 });
    expect(latencySpec('gateway:1')).toMatchObject({ warn: 1500, crit: 4000 });
  });
});
