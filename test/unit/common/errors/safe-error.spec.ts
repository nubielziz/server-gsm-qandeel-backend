// Unit tests of the error sanitiser of decision 054: a database failure is its SQLSTATE, names and a fixed sentence.
import { describe, expect, it } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  STATEMENT_REMOVED,
  databaseFailureOf,
  errorTypeOf,
  framesOnly,
  safeErrorText,
  sanitizeError,
  withoutStatementText,
} from '@src/common/errors/safe-error';
import { DB_FAILURE_MARKER, drizzleFailure, pgRefusal } from '../../../support/db-failure';

const EXPECTED =
  'Database error 23514: a check constraint refused the row (table job_runs, constraint job_runs_trigger_check).';

describe('safe error text', () => {
  it('describes a database failure by its SQLSTATE, its names and a fixed sentence', () => {
    const text = safeErrorText(drizzleFailure());
    expect(text).toBe(EXPECTED);
    for (const forbidden of [DB_FAILURE_MARKER, 'Failed query', 'insert into']) expect(text).not.toContain(forbidden);
  });

  it('describes the raw driver error the same way', () => {
    expect(safeErrorText(pgRefusal())).toBe(EXPECTED);
  });

  it('reads the names only when they are identifiers', () => {
    const long = 'c'.repeat(64);
    expect(safeErrorText(drizzleFailure(pgRefusal({ constraint: 'has a space' })))).toBe(
      'Database error 23514: a check constraint refused the row (table job_runs).',
    );
    expect(safeErrorText(drizzleFailure(pgRefusal({ constraint: long })))).not.toContain(long);
  });

  it("finds the failure behind a wrapper and keeps the wrapper's own words", () => {
    const wrapped = new Error('Publish run 5 failed', { cause: drizzleFailure() });
    expect(safeErrorText(wrapped)).toBe(`Publish run 5 failed: ${EXPECTED}`);
    expect(databaseFailureOf(wrapped)?.direct).toBe(false);
    expect(databaseFailureOf(drizzleFailure())?.direct).toBe(true);
  });

  it("names the trigger function from the error's context", () => {
    const failure = drizzleFailure(
      pgRefusal({
        code: 'P0001',
        table: undefined,
        constraint: undefined,
        where: 'PL/pgSQL function ledger_zero_sum() line 9 at RAISE',
      }),
    );
    expect(safeErrorText(failure)).toBe(
      'Database error P0001: a database rule refused the change (function ledger_zero_sum).',
    );
  });

  it('describes a failure without SQLSTATE by its driver code', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(safeErrorText(drizzleFailure(refused))).toBe('Database error ECONNREFUSED: the statement did not complete.');
    const failure = databaseFailureOf(drizzleFailure(Object.assign(new Error('x'), { code: 'EPIPE' })));
    expect(failure?.sqlState).toBeUndefined();
    expect(failure?.driverCode).toBe('EPIPE');
  });

  it('uses the class sentence and the default', () => {
    const cases: Array<[string, string]> = [
      ['23505', 'a unique index refused the row'],
      ['23503', 'a foreign key refused the row'],
      ['23502', 'a required column was empty'],
      ['22001', 'a text was longer than its column allows'],
      ['22P02', 'a value was not in the form its column needs'],
      ['22021', 'a text held a character the database does not accept'],
      ['40001', 'the transaction could not be serialized'],
      ['40P01', 'a deadlock was detected'],
      ['55P03', 'a lock was not granted in time'],
      ['57014', 'the statement was cancelled (a timeout)'],
      ['42501', 'the database role lacks a privilege'],
      ['08006', 'the database connection failed'],
      ['53300', 'the database ran out of a resource'],
      ['XX000', 'the database had an internal error'],
      ['0A000', 'the database refused the statement'],
    ];
    for (const [code, sentence] of cases) {
      const text = safeErrorText(drizzleFailure(pgRefusal({ code, table: undefined, constraint: undefined })));
      expect(text).toBe(`Database error ${code}: ${sentence}.`);
    }
  });

  it('cuts statement text out of any message', () => {
    expect(withoutStatementText(`Saving failed: Failed query: insert into x params: ${DB_FAILURE_MARKER}`)).toBe(
      `Saving failed: ${STATEMENT_REMOVED}`,
    );
    expect(withoutStatementText('plain text')).toBe('plain text');
    expect(safeErrorText(`oops Failed query: select ${DB_FAILURE_MARKER}`)).not.toContain(DB_FAILURE_MARKER);
  });

  it('leaves other errors as they are', () => {
    const plain = new Error('boom');
    expect(sanitizeError(plain)).toBe(plain);
    expect(sanitizeError('text')).toBe('text');
    expect(sanitizeError(undefined)).toBeUndefined();
    expect(safeErrorText(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(safeErrorText(null)).toBe('unknown error');
    expect(safeErrorText({ weird: true })).toBe('[object Object]');
  });

  it('gives a safe copy of a database error', () => {
    const original = drizzleFailure();
    const copy = sanitizeError(original) as Error;
    expect(copy).not.toBe(original);
    expect(copy.name).toBe('DrizzleQueryError');
    expect(copy.message).toBe(EXPECTED);
    expect(copy.stack?.startsWith('DrizzleQueryError: Database error 23514')).toBe(true);
    const lines = (copy.stack ?? '').split('\n').slice(1);
    for (const line of lines) expect(line).toMatch(/^\s+at .*:\d+:\d+\)?$/);
    expect(JSON.stringify(Object.getOwnPropertyNames(copy))).not.toContain('params');
    expect((copy as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify({ ...copy })).not.toContain(DB_FAILURE_MARKER);
    expect(String(copy.stack)).not.toContain(DB_FAILURE_MARKER);
  });

  it('cuts a long text', () => {
    const text = safeErrorText(new Error('x'.repeat(2000)), 1000);
    expect(text).toHaveLength(1000);
    expect(text.endsWith('...')).toBe(true);
  });

  it('names an error by its constructor unless that is generic', () => {
    expect(errorTypeOf(drizzleFailure())).toBe('DrizzleQueryError');
    expect(errorTypeOf(new TypeError('x'))).toBe('TypeError');
    expect(errorTypeOf(new Error('x'))).toBe('Error');
    expect(errorTypeOf({ name: 'Custom' })).toBe('Custom');
    expect(errorTypeOf(7)).toBe('Error');
  });

  it('keeps only the frames of a stack', () => {
    const frames = framesOnly(
      `Error: secret ${DB_FAILURE_MARKER}\n    at run (/app/a.ts:3:9)\n    at <anonymous> (native)\n    at b (/app/b.ts:1:1)`,
    );
    expect(frames).toEqual(['    at run (/app/a.ts:3:9)', '    at b (/app/b.ts:1:1)']);
    expect(framesOnly(undefined)).toEqual([]);
  });

  it('never throws on a hostile value', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('no');
        },
      },
    );
    expect(() => safeErrorText(hostile)).not.toThrow();
    expect(() => sanitizeError(hostile)).not.toThrow();
    const cyclic: { cause?: unknown; message: string } = { message: 'x' };
    cyclic.cause = cyclic;
    expect(databaseFailureOf(cyclic)).toBeUndefined();
    expect(databaseFailureOf(new DrizzleQueryError('select 1', [], undefined))?.sqlState).toBeUndefined();
  });
});
