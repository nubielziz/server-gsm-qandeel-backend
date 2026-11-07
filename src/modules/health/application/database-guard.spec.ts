// Unit tests of the database outage detection: connection failures become 503 DATABASE_UNAVAILABLE, query errors stay as they are.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../../../common/errors';
import { isDatabaseDown, orUnavailable } from './database-guard';

describe('isDatabaseDown', () => {
  it('recognises refused and lost connections, shutdowns and pool timeouts, also behind a cause', () => {
    expect(isDatabaseDown(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isDatabaseDown(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isDatabaseDown(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDatabaseDown(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(
      isDatabaseDown(new Error('Failed query', { cause: Object.assign(new Error('y'), { code: 'ECONNRESET' }) })),
    ).toBe(true);
  });

  it('does not take a query error for an outage', () => {
    expect(isDatabaseDown(Object.assign(new Error('relation does not exist'), { code: '42P01' }))).toBe(false);
    expect(isDatabaseDown('text')).toBe(false);
    expect(isDatabaseDown(undefined)).toBe(false);
  });
});

describe('orUnavailable', () => {
  it('answers 503 DATABASE_UNAVAILABLE for an outage without leaking its text, and passes anything else through', async () => {
    const outage = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    const failure = await orUnavailable(() => Promise.reject(outage)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('DATABASE_UNAVAILABLE');
    expect((failure as AppError).detail).not.toContain('10.0.0.5');
    const other = new Error('boom');
    expect(await orUnavailable(() => Promise.reject(other)).catch((error: unknown) => error)).toBe(other);
    expect(await orUnavailable(() => Promise.resolve(5))).toBe(5);
  });
});
