// Unit tests of what the workers of a publish run share (feature 31, plan 31 sections 6.2 and 6.7): which errors earn a row a second try,
// the text a run keeps for an error, and the tally of a run switch.
import { describe, expect, it } from 'bun:test';
import { MAX_RUN_ERROR_LENGTH } from '@src/modules/storefront/publish/domain/publish-item';
import {
  SWITCH_SKIP_REASONS,
  SwitchTally,
  cancelledRunAudit,
  isRetryableConflict,
  publishRunLabel,
  retryingConflictOnce,
  runErrorText,
} from '@src/modules/storefront/publish/domain/publish-run';

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error('a statement and its values'), { code, constraint });
/** How Drizzle wraps a driver error: the Postgres error is the cause. */
const wrapped = (cause: Error) => Object.assign(new Error('Failed query: select 1'), { cause });

describe('isRetryableConflict', () => {
  it('is true for a deadlock and a serialization failure, also wrapped by Drizzle', () => {
    expect(isRetryableConflict(pgError('40P01'))).toBe(true);
    expect(isRetryableConflict(pgError('40001'))).toBe(true);
    expect(isRetryableConflict(wrapped(pgError('40P01')))).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isRetryableConflict(pgError('23505', 'service_listings_slug_uq'))).toBe(false);
    expect(isRetryableConflict(new Error('boom'))).toBe(false);
    expect(isRetryableConflict('boom')).toBe(false);
    expect(isRetryableConflict(undefined)).toBe(false);
  });
});

describe('retryingConflictOnce', () => {
  const failing = (errors: Error[], value = 'done') => {
    const calls = { count: 0 };
    const work = (): Promise<string> => {
      calls.count += 1;
      const error = errors.shift();
      return error === undefined ? Promise.resolve(value) : Promise.reject(error);
    };
    return { calls, work };
  };

  it('answers at once when the work succeeds', async () => {
    const { calls, work } = failing([]);
    expect(await retryingConflictOnce(work)).toBe('done');
    expect(calls.count).toBe(1);
  });

  it('runs the work once more after a conflict', async () => {
    const { calls, work } = failing([pgError('40P01')]);
    expect(await retryingConflictOnce(work)).toBe('done');
    expect(calls.count).toBe(2);
  });

  it('gives up after the second conflict, with that error', async () => {
    const second = pgError('40001');
    const { calls, work } = failing([pgError('40P01'), second]);
    let caught: unknown;
    await retryingConflictOnce(work).catch((error: unknown) => (caught = error));
    expect(caught).toBe(second);
    expect(calls.count).toBe(2);
  });

  it('never retries another error', async () => {
    const error = pgError('23514', 'some_check');
    const { calls, work } = failing([error]);
    let caught: unknown;
    await retryingConflictOnce(work).catch((thrown: unknown) => (caught = thrown));
    expect(caught).toBe(error);
    expect(calls.count).toBe(1);
  });
});

describe('runErrorText', () => {
  it('reduces a database error to its code and constraint: the driver message carries the statement', () => {
    expect(runErrorText(wrapped(pgError('23514', 'services_prices_check')))).toBe(
      'Database error 23514 (services_prices_check).',
    );
    expect(runErrorText(pgError('57014'))).toBe('Database error 57014.');
  });

  it('keeps the message of any other error, cut to the column', () => {
    expect(runErrorText(new Error('  The chunk went wrong.  '))).toBe('The chunk went wrong.');
    expect(runErrorText(new Error('x'.repeat(MAX_RUN_ERROR_LENGTH + 50)))).toHaveLength(MAX_RUN_ERROR_LENGTH);
  });

  it('says something when there is no message', () => {
    expect(runErrorText(new Error('   '))).toBe('unexpected error');
    expect(runErrorText('boom')).toBe('unexpected error');
  });
});

describe('publishRunLabel', () => {
  it('names the run', () => {
    expect(publishRunLabel(41)).toBe('Publish run #41');
  });
});

describe('SwitchTally', () => {
  it('starts empty', () => {
    const tally = new SwitchTally();
    expect([tally.switched, tally.unchanged, tally.skipped()]).toEqual([0, 0, 0]);
    expect(tally.skippedByReason()).toEqual({});
  });

  it('counts each reason, answers the count of that reason, and adds them up', () => {
    const tally = new SwitchTally();
    expect(tally.skip('no_price')).toBe(1);
    expect(tally.skip('failed')).toBe(1);
    expect(tally.skip('failed')).toBe(2);
    expect(tally.skipped()).toBe(3);
    expect(tally.skippedByReason()).toEqual({ no_price: 1, failed: 2 });
  });

  it('lists the reasons in their fixed order, whatever came first', () => {
    const tally = new SwitchTally();
    for (const reason of [...SWITCH_SKIP_REASONS].reverse()) tally.skip(reason);
    expect(Object.keys(tally.skippedByReason())).toEqual([...SWITCH_SKIP_REASONS]);
  });
});

describe('cancelledRunAudit', () => {
  const counts = { published: 3, skipped: 1, refused: 2 };

  it('carries the counts so far, and replacedBy only when "Check again" made the new run', () => {
    expect(cancelledRunAudit({ total: 9 }, counts)).toEqual({
      status: 'cancelled',
      total: 9,
      published: 3,
      skipped: 1,
      refused: 2,
    });
    expect(cancelledRunAudit({ total: 9 }, counts, 41)).toEqual({
      status: 'cancelled',
      total: 9,
      published: 3,
      skipped: 1,
      refused: 2,
      replacedBy: 41,
    });
  });
});
