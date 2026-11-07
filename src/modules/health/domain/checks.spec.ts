// Unit tests of the check rules: buckets, worst check, uptime, the overall status.
import { describe, expect, it } from 'bun:test';
import { CHECK_RANGES, bucketStarts, bucketStatus, overallStatus, uptimePercent } from './checks';

describe('bucketStarts', () => {
  it('aligns buckets to the width, oldest first, the last one holding now', () => {
    const now = new Date('2026-11-07T10:07:30.000Z');
    const starts = bucketStarts(now, 300, 3);
    expect(starts.map((d) => d.toISOString())).toEqual([
      '2026-11-07T09:55:00.000Z',
      '2026-11-07T10:00:00.000Z',
      '2026-11-07T10:05:00.000Z',
    ]);
  });

  it('gives each range the documented number of buckets', () => {
    expect(Object.fromEntries(Object.entries(CHECK_RANGES).map(([k, v]) => [k, v.buckets]))).toEqual({
      '1h': 60,
      '6h': 72,
      '24h': 48,
      '7d': 56,
    });
  });
});

describe('bucketStatus', () => {
  const counts = (over: Partial<{ down: number; degraded: number; ok: number; unknown: number }>) => ({
    down: 0,
    degraded: 0,
    ok: 0,
    unknown: 0,
    p95: null,
    ...over,
  });
  it('is the worst check, and unknown without checks or with only unknown rows', () => {
    expect(bucketStatus(undefined)).toBe('unknown');
    expect(bucketStatus(counts({ ok: 3 }))).toBe('ok');
    expect(bucketStatus(counts({ ok: 3, degraded: 1 }))).toBe('degraded');
    expect(bucketStatus(counts({ ok: 3, degraded: 1, down: 1 }))).toBe('down');
    expect(bucketStatus(counts({ unknown: 2 }))).toBe('unknown');
  });
});

describe('uptimePercent', () => {
  it('is checks that were not down over all checks, null without checks', () => {
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimePercent(4, 1)).toBe(75);
    expect(uptimePercent(10, 0)).toBe(100);
  });
});

describe('overallStatus', () => {
  const base = {
    core: { postgres: 'ok', redis: 'ok' } as const,
    anyComponentProblem: false,
    openCriticalAlert: false,
    monitoringAvailable: true,
  };
  it('is an outage when a core component is down', () => {
    expect(overallStatus({ ...base, core: { postgres: 'down' } })).toBe('outage');
  });
  it('is degraded for any problem or an open critical alert', () => {
    expect(overallStatus({ ...base, anyComponentProblem: true })).toBe('degraded');
    expect(overallStatus({ ...base, openCriticalAlert: true })).toBe('degraded');
  });
  it('is operational only while monitoring answers', () => {
    expect(overallStatus(base)).toBe('operational');
    expect(overallStatus({ ...base, monitoringAvailable: false })).toBe('unknown');
    expect(overallStatus({ ...base, monitoringAvailable: false, anyComponentProblem: true })).toBe('degraded');
  });
});
