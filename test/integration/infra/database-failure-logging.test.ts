// A database failure through the real API (decision 054): the problem's development detail and every log line describe it by its SQLSTATE
// and names, never by the statement or its bound values (the marker).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../../support/app';
import { closeTestDb, testDb } from '../../support/db';
import { DB_FAILURE_MARKER, DatabaseFailureTestController } from '../../support/db-failure-routes';
import { logSink } from '../../support/log-sink';

let t: TestApp;

beforeAll(async () => {
  await testDb();
  t = await createTestApp({ controllers: [DatabaseFailureTestController] });
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});

describe('a database failure', () => {
  it('leaves no statement or value in the answer or the logs', async () => {
    logSink.clear();
    const res = await t.app.inject({ method: 'GET', url: '/t/db-failure' });
    expect(res.statusCode).toBe(500);
    const problem = res.json<{ code: string; detail: string }>();
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toContain('Database error 23514');
    expect(problem.detail).toContain('job_runs_trigger_check');
    expect(res.body).not.toContain(DB_FAILURE_MARKER);
    expect(res.body).not.toContain('Failed query');

    const lines = logSink.lines.map((line) => JSON.stringify(line));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line).not.toContain(DB_FAILURE_MARKER);
      expect(line).not.toContain('Failed query');
      expect(line).not.toContain('insert into');
    }
    const failed = logSink.lines.find((line) => line.msg === 'Request failed with a server error');
    expect((failed?.err as { database?: { sqlState?: string } } | undefined)?.database?.sqlState).toBe('23514');
    expect(logSink.lines.some((line) => line.msg?.startsWith('db failed: '))).toBe(true);
    expect(logSink.lines.some((line) => line.msg === 'nested')).toBe(true);
  });
});
