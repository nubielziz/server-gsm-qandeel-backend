// Unit tests of the poll rhythm.
import { describe, expect, it } from 'bun:test';
import { pollIntervalMs } from './poll-schedule';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('pollIntervalMs', () => {
  it('is one minute in the first hour, five minutes after it and thirty minutes after the slow limit', () => {
    expect(pollIntervalMs(0, 24)).toBe(MIN);
    expect(pollIntervalMs(59 * MIN, 24)).toBe(MIN);
    expect(pollIntervalMs(HOUR, 24)).toBe(5 * MIN);
    expect(pollIntervalMs(23 * HOUR, 24)).toBe(5 * MIN);
    expect(pollIntervalMs(24 * HOUR, 24)).toBe(30 * MIN);
    expect(pollIntervalMs(2 * HOUR, 2)).toBe(30 * MIN);
  });
});
