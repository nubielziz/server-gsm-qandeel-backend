// Unit tests of the schedule words of the jobs list.
import { describe, expect, it } from 'bun:test';
import { cronOf, cronText, jobLabel } from './cron-text';

describe('cronOf', () => {
  it('keeps a pattern and turns whole intervals into cron', () => {
    expect(cronOf({ pattern: '15 3 * * *' })).toBe('15 3 * * *');
    expect(cronOf({ every: 60_000 })).toBe('* * * * *');
    expect(cronOf({ every: 15 * 60_000 })).toBe('*/15 * * * *');
    expect(cronOf({ every: 3_600_000 })).toBe('0 * * * *');
    expect(cronOf({ every: 6 * 3_600_000 })).toBe('0 */6 * * *');
    expect(cronOf({ every: 86_400_000 })).toBe('0 0 * * *');
    expect(cronOf({ every: 7_000 })).toBe('every 7 s');
    expect(cronOf({})).toBe('');
  });
});

describe('cronText', () => {
  it('writes the common schedules in words and leaves the rest empty', () => {
    expect(cronText('* * * * *')).toBe('Every minute');
    expect(cronText('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronText('30 3 * * *')).toBe('Daily at 03:30 UTC');
    expect(cronText('0 * * * *')).toBe('Every hour');
    expect(cronText('0 */6 * * *')).toBe('Every 6 hours');
    expect(cronText('0 9 * * 1')).toBe('Every Monday at 09:00 UTC');
    expect(cronText('every 7 s')).toBe('Every 7 seconds');
    expect(cronText('1-5 * * * *')).toBe('');
    expect(cronText('not cron')).toBe('');
  });
});

describe('jobLabel', () => {
  it('puts the key in words', () => {
    expect(jobLabel('session_purge')).toBe('Session purge');
    expect(jobLabel('price-sync')).toBe('Price sync');
  });
});
