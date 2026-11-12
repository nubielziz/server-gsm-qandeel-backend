// Unit tests of the supplier quick add rules (feature 26, B214): the groups of a scope, when a live run is stalled, how a run reads on the
// wire, the chunks of the work list and the reason a failed item reports.
import { describe, expect, it } from 'bun:test';
import {
  MAX_ITEM_FAILURES,
  QUICK_ADD_CHUNK,
  QUICK_ADD_STALE_MS,
  type QuickAddRunRecord,
  STALLED_ERROR,
  chunksOf,
  failureReason,
  isStalled,
  runErrorText,
  runView,
  uniqueGroups,
} from './quick-add';

const NOW = Date.parse('2026-11-11T10:00:00.000Z');

const record = (overrides: Partial<QuickAddRunRecord> = {}): QuickAddRunRecord => ({
  id: 7,
  supplierId: 2,
  scope: 'groups',
  groups: [{ type: 'IMEI', remoteGroup: 'Apple iPhone' }],
  serviceStatus: 'active',
  status: 'running',
  total: 80,
  createdCount: 29,
  skippedCount: 1,
  failedCount: 2,
  categoriesCreated: 1,
  createdWithQuantity: 3,
  failures: [{ supplierServiceId: 5, name: 'Broken', reason: 'services_cost_check' }],
  error: null,
  requestedBy: 4,
  createdAt: new Date(NOW - 60_000),
  startedAt: new Date(NOW - 59_000),
  finishedAt: null,
  heartbeatAt: new Date(NOW - 1_000),
  ...overrides,
});

describe('uniqueGroups', () => {
  it('drops exact repeats, keeps the first and the order', () => {
    const groups = uniqueGroups([
      { type: 'IMEI', remoteGroup: 'Apple' },
      { type: 'SERVER', remoteGroup: 'Apple' },
      { type: 'IMEI', remoteGroup: 'Apple' },
      { type: 'IMEI', remoteGroup: 'Samsung' },
    ]);
    expect(groups).toEqual([
      { type: 'IMEI', remoteGroup: 'Apple' },
      { type: 'SERVER', remoteGroup: 'Apple' },
      { type: 'IMEI', remoteGroup: 'Samsung' },
    ]);
  });

  it('compares the stored text exactly: case and spaces make another group', () => {
    expect(
      uniqueGroups([
        { type: 'IMEI', remoteGroup: 'Apple' },
        { type: 'IMEI', remoteGroup: 'apple' },
        { type: 'IMEI', remoteGroup: 'Apple ' },
        { type: 'imei', remoteGroup: 'Apple' },
      ]),
    ).toHaveLength(4);
  });

  it('does not mistake two pairs for one when the text of one runs into the other', () => {
    expect(
      uniqueGroups([
        { type: 'a', remoteGroup: 'b\u0000c' },
        { type: 'a\u0000b', remoteGroup: 'c' },
      ]),
    ).toHaveLength(2);
  });

  it('keeps the empty group name', () => {
    expect(uniqueGroups([{ type: 'IMEI', remoteGroup: '' }])).toEqual([{ type: 'IMEI', remoteGroup: '' }]);
  });
});

describe('isStalled', () => {
  const heartbeat = (age: number) => new Date(NOW - age);

  it('is false at the limit and true one millisecond past it, for a running run', () => {
    expect(isStalled({ status: 'running', heartbeatAt: heartbeat(QUICK_ADD_STALE_MS) }, NOW)).toBe(false);
    expect(isStalled({ status: 'running', heartbeatAt: heartbeat(QUICK_ADD_STALE_MS + 1) }, NOW)).toBe(true);
  });

  it('does the same for a queued run (the worker never picked it up)', () => {
    expect(isStalled({ status: 'queued', heartbeatAt: heartbeat(QUICK_ADD_STALE_MS) }, NOW)).toBe(false);
    expect(isStalled({ status: 'queued', heartbeatAt: heartbeat(QUICK_ADD_STALE_MS + 1) }, NOW)).toBe(true);
  });

  it('is never true for a finished run, however old', () => {
    const old = heartbeat(QUICK_ADD_STALE_MS * 100);
    expect(isStalled({ status: 'succeeded', heartbeatAt: old }, NOW)).toBe(false);
    expect(isStalled({ status: 'failed', heartbeatAt: old }, NOW)).toBe(false);
  });
});

describe('runView', () => {
  it('adds the three counts into processed and sends dates as ISO text', () => {
    const view = runView(record(), NOW);
    expect(view).toMatchObject({
      id: 7,
      supplierId: 2,
      scope: 'groups',
      status: 'running',
      total: 80,
      processed: 32,
      created: 29,
      skipped: 1,
      failed: 2,
      categoriesCreated: 1,
      error: null,
      requestedBy: 4,
      createdAt: '2026-11-11T09:59:00.000Z',
      startedAt: '2026-11-11T09:59:01.000Z',
      finishedAt: null,
    });
    expect(view.groups).toEqual([{ type: 'IMEI', remoteGroup: 'Apple iPhone' }]);
    expect(view.failures).toEqual([{ supplierServiceId: 5, name: 'Broken', reason: 'services_cost_check' }]);
  });

  it('never sends the internal columns', () => {
    const keys = Object.keys(runView(record(), NOW)).sort();
    expect(keys).not.toContain('heartbeatAt');
    expect(keys).not.toContain('createdWithQuantity');
  });

  it('shows a stalled run as failed with the stalled error and no finish time, keeping its counts', () => {
    const stale = record({ heartbeatAt: new Date(NOW - QUICK_ADD_STALE_MS - 1) });
    const view = runView(stale, NOW);
    expect(view).toMatchObject({
      status: 'failed',
      error: STALLED_ERROR,
      finishedAt: null,
      processed: 32,
      created: 29,
    });
  });

  it('keeps the error and finish time of a run that really ended', () => {
    const ended = record({
      status: 'failed',
      error: 'Too many services could not be added (20). The rest was not tried.',
      finishedAt: new Date(NOW - 500),
      heartbeatAt: new Date(NOW - QUICK_ADD_STALE_MS * 10),
    });
    expect(runView(ended, NOW)).toMatchObject({
      status: 'failed',
      error: 'Too many services could not be added (20). The rest was not tried.',
      finishedAt: '2026-11-11T09:59:59.500Z',
    });
  });

  it('reads a finished run as it is', () => {
    const done = record({ status: 'succeeded', finishedAt: new Date(NOW - 10), heartbeatAt: new Date(NOW - 10) });
    expect(runView(done, NOW)).toMatchObject({ status: 'succeeded', error: null });
  });
});

describe('chunksOf', () => {
  it('cuts a list into consecutive chunks of at most the size', () => {
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunksOf([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('gives no chunk for an empty list and refuses a size under one', () => {
    expect(chunksOf([], 100)).toEqual([]);
    expect(() => chunksOf([1], 0)).toThrow(RangeError);
    expect(() => chunksOf([1], 1.5)).toThrow(RangeError);
  });

  it('cuts 250 ids into 100, 100 and 50', () => {
    const ids = Array.from({ length: 250 }, (_, index) => index + 1);
    expect(chunksOf(ids, QUICK_ADD_CHUNK).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });
});

describe('failureReason', () => {
  it('is the Postgres constraint name, also when the driver error is the cause of another', () => {
    const database = Object.assign(new Error('violates'), { code: '23514', constraint: 'services_cost_check' });
    expect(failureReason(database)).toBe('services_cost_check');
    expect(failureReason(new Error('Failed query', { cause: database }))).toBe('services_cost_check');
  });

  it('is "unexpected error" for anything else, and never carries the message', () => {
    expect(failureReason(new Error('secret SQL text'))).toBe('unexpected error');
    expect(failureReason('boom')).toBe('unexpected error');
    expect(failureReason(Object.assign(new Error('x'), { code: '23505' }))).toBe('unexpected error');
  });
});

describe('runErrorText', () => {
  it('keeps the message of an ordinary error, at most 500 characters', () => {
    expect(runErrorText(new Error('Cannot reach the queue'))).toBe('Cannot reach the queue');
    expect(runErrorText(new Error('x'.repeat(900)))).toHaveLength(500);
  });

  it('reduces a database error to its code and constraint, so no statement reaches staff', () => {
    const database = Object.assign(new Error('insert into services ...'), {
      code: '23505',
      constraint: 'services_code_uq',
    });
    expect(runErrorText(database)).toBe('Database error 23505 (services_code_uq).');
    expect(runErrorText(new Error('Failed query', { cause: Object.assign(new Error('x'), { code: '40001' }) }))).toBe(
      'Database error 40001.',
    );
  });

  it('says "unexpected error" when there is no message', () => {
    expect(runErrorText(new Error('  '))).toBe('unexpected error');
    expect(runErrorText(undefined)).toBe('unexpected error');
  });
});

describe('limits', () => {
  it('keep the plan numbers', () => {
    expect(QUICK_ADD_CHUNK).toBe(100);
    expect(QUICK_ADD_STALE_MS).toBe(300_000);
    expect(MAX_ITEM_FAILURES).toBe(20);
  });
});
