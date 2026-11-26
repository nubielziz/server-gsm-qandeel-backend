// Unit tests of the call log writer that never fails its caller (decision 051): the full record, else a minimal row, else one error line
// with the SQLSTATE alone. A stand-in database executor plays the insert. And the adoption rule of the sync (decisions 042 and 071).
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { DbExecutor } from '@src/infra/db';
import type { CallRecord } from '@src/modules/suppliers/application/supplier-driver';
import {
  CALL_RECORD_NOT_STORED,
  adoptable,
  writeCallLogSafely,
} from '@src/modules/suppliers/application/supplier-sync';
import type { AlignmentCandidate } from '@src/modules/suppliers/infra/foreign-reads.repository';

const record: CallRecord = {
  action: 'placeimeiorder',
  request: { action: 'placeimeiorder', parameters: { ID: '1' } },
  response: { SUCCESS: [{ REFERENCEID: 'R-1' }] },
  httpStatus: 200,
  durationMs: 12,
  error: '',
  outcome: 'ok',
};
const at = new Date('2026-11-21T10:00:00.000Z');

/** An error as the pg driver throws it: a SQLSTATE and a message that may quote the refused value. */
function refused(text: string): Error {
  return Object.assign(new Error(`invalid input: ${text}`), { code: '22P05' });
}

/** A stand-in executor whose inserts answer, in turn, an id or one of the given errors. */
function executor(...answers: Array<number | Error>) {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        rows.push(row);
        const answer = answers.shift();
        return {
          returning: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve([{ id: answer ?? 1 }])),
        };
      },
    }),
  };
  return { db: db as unknown as DbExecutor, rows };
}

describe('writeCallLogSafely', () => {
  const logged = spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  afterEach(() => logged.mockClear());

  it('writes the full record when the database takes it', async () => {
    const { db, rows } = executor(7);
    const reported: unknown[] = [];
    expect(await writeCallLogSafely(db, 3, 9, record, at, (error) => reported.push(error))).toBe(7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      supplierId: 3,
      orderId: 9,
      request: record.request,
      response: record.response,
      error: '',
    });
    expect(reported).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('falls back to a row without the bodies, and hands the first error to the caller once', async () => {
    const first = refused('secret value');
    const { db, rows } = executor(first, 8);
    const reported: unknown[] = [];
    expect(await writeCallLogSafely(db, 3, 9, record, at, (error) => reported.push(error))).toBe(8);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      supplierId: 3,
      orderId: 9,
      action: 'placeimeiorder',
      request: { action: 'placeimeiorder' },
      response: null,
      httpStatus: 200,
      durationMs: 12,
      error: CALL_RECORD_NOT_STORED,
      outcome: 'ok',
      createdAt: at,
    });
    expect(reported).toEqual([first]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs the SQLSTATE alone and answers null when not even the minimal row can be written', async () => {
    const { db } = executor(refused('secret value'), refused('secret value'));
    const reported: unknown[] = [];
    expect(await writeCallLogSafely(db, 3, null, record, at, (error) => reported.push(error))).toBeNull();
    expect(reported).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]![0]);
    expect(line).toBe('The call log row of supplier 3 could not be written (SQLSTATE 22P05).');
    expect(line).not.toContain('secret');
  });

  it('never fails its caller, not even when the hook throws', async () => {
    const { db } = executor(new Error('connection lost'), new Error('connection lost'));
    const result = await writeCallLogSafely(db, 3, 9, record, at, () => {
      throw new Error('reporter down');
    });
    expect(result).toBeNull();
    expect(String(logged.mock.calls[0]![0])).toBe(
      'The call log row of supplier 3 for order 9 could not be written (SQLSTATE unknown).',
    );
  });
});

describe('adoptable', () => {
  const ecidBox = { CUSTOM: { allow: '1', customname: 'ECID', maxlength: '16' } };
  const candidate = (over: Partial<AlignmentCandidate>): AlignmentCandidate => ({
    serviceId: 1,
    type: 'imei',
    raw: ecidBox,
    customFields: [],
    fieldMap: {},
    fields: [],
    ...over,
  });
  const imeiField = { key: 'imei', supplierKey: 'IMEI', required: true, isMainInput: true };

  it('adopts an imei service whose supplier service has a main box, with or without a main-input field (decision 071)', () => {
    expect(adoptable(candidate({}))).toBe(true);
    expect(
      adoptable(candidate({ fields: [{ key: 'model', supplierKey: 'Model', required: false, isMainInput: false }] })),
    ).toBe(true);
    expect(adoptable(candidate({ fields: [imeiField] }))).toBe(true);
  });

  it('never adopts a service of another type, nor one whose supplier service has no main box or one named only IMEI', () => {
    for (const type of ['server', 'remote', 'file']) expect(adoptable(candidate({ type })), type).toBe(false);
    expect(adoptable(candidate({ raw: {} }))).toBe(false);
    expect(adoptable(candidate({ raw: { CUSTOM: { allow: '1', customname: 'IMEI' } }, fields: [imeiField] }))).toBe(
      false,
    );
    expect(adoptable(candidate({ raw: { CUSTOM: { allow: '0', customname: 'ECID' } } }))).toBe(false);
  });
});
