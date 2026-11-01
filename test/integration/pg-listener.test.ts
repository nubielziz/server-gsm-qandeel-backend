// Integration tests of PgListener (decision 020) against the test Postgres: a committed NOTIFY arrives and a rolled-back one
// does not, the connection has its own name and is not part of the pool, it comes back by itself after the backend is
// killed (and says it is a reconnect), it keeps trying while Postgres is unreachable, and stop() ends it. The reconnect waits
// are manual timers (decision 031): the test fires them, it does not sleep through them.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { PgListener } from '../../src/infra/db';
import { ManualTimers } from '../support/clock';
import { TEST_DATABASE_URL, closeTestDb, testDb } from '../support/db';
import { eventually, freePort } from '../support/infra';

const NAME = 'gsm-test-pg-listener';
const started: PgListener[] = [];

// The listener logs every reconnect and failed attempt; the lines would bury the test report.
beforeAll(() => Logger.overrideLogger(false));
afterAll(async () => {
  Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
  await Promise.all(started.map((listener) => listener.stop()));
  await closeTestDb();
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((listener) => listener.stop()));
});

function listen(connectionString = TEST_DATABASE_URL, channels = ['gsm_test_channel']) {
  const notifications: Array<[string, string | undefined]> = [];
  const connected: boolean[] = [];
  const timers = new ManualTimers();
  const attempts = { count: 0 };
  const listener = new PgListener({
    connectionString,
    channels,
    applicationName: NAME,
    onNotification: (channel, payload) => notifications.push([channel, payload]),
    onConnected: ({ reconnect }) => connected.push(reconnect),
    reconnectMs: { first: 50, max: 200 },
    timers,
    // Counts the connection attempts; the client itself is the real one.
    createClient: (config) => {
      attempts.count++;
      return new Client(config);
    },
  });
  started.push(listener);
  return { listener, notifications, connected, timers, attempts };
}

/** The server-side processes of the listener connections. */
async function backends(): Promise<number[]> {
  const { pool } = await testDb();
  const { rows } = await pool.query<{ pid: number }>(
    'select pid from pg_stat_activity where datname = current_database() and application_name = $1',
    [NAME],
  );
  return rows.map((row) => row.pid);
}

describe('PgListener on Postgres', () => {
  it('receives a committed NOTIFY and never a rolled-back one', async () => {
    const { pool } = await testDb();
    const { listener, notifications } = listen();
    await listener.start();
    expect(listener.listening).toBe(true);

    const rolledBack = await pool.connect();
    await rolledBack.query('begin');
    await rolledBack.query(`select pg_notify('gsm_test_channel', 'rolled-back')`);
    await rolledBack.query('rollback');
    rolledBack.release();

    const committed = await pool.connect();
    await committed.query('begin');
    await committed.query(`select pg_notify('gsm_test_channel', 'committed')`);
    // Notifications arrive in commit order. A notification that commits now, while the one above is still open, is a
    // barrier: when it has arrived, the open one has been given every chance to arrive before it, and has not.
    await pool.query(`select pg_notify('gsm_test_channel', 'barrier-1')`);
    await eventually(() => (notifications.length > 0 ? true : undefined));
    expect(notifications, 'nothing is delivered before the commit').toEqual([['gsm_test_channel', 'barrier-1']]);
    await committed.query('commit');
    committed.release();

    await eventually(() => (notifications.length > 1 ? true : undefined));
    // The rolled-back one never arrives: everything committed before this later barrier has been delivered by now.
    await pool.query(`select pg_notify('gsm_test_channel', 'barrier-2')`);
    await eventually(() => (notifications.some(([, payload]) => payload === 'barrier-2') ? true : undefined));
    expect(notifications).toEqual([
      ['gsm_test_channel', 'barrier-1'],
      ['gsm_test_channel', 'committed'],
      ['gsm_test_channel', 'barrier-2'],
    ]);
  });

  it('holds exactly one connection of its own, named after the application, and gives it back on stop', async () => {
    const { listener } = listen();
    await listener.start();
    expect(await backends()).toHaveLength(1);
    await listener.stop();
    await eventually(async () => ((await backends()).length === 0 ? true : undefined));
    expect(listener.listening).toBe(false);
  });

  it('comes back by itself after its backend is killed, says it is a reconnect, and receives again', async () => {
    const { pool } = await testDb();
    const { listener, notifications, connected, timers } = listen();
    await listener.start();
    expect(connected).toEqual([false]);
    const [pid] = await backends();

    await pool.query('select pg_terminate_backend($1)', [pid]);
    // The listener notices the loss and plans its reconnect; the test fires the timer.
    await eventually(() => (timers.pending > 0 ? true : undefined));
    timers.advance(1_000);
    await eventually(() => (connected.length === 2 ? true : undefined));
    expect(connected).toEqual([false, true]);
    expect(listener.listening).toBe(true);
    const [newPid] = await backends();
    expect(newPid).not.toBe(pid);
    expect(await backends()).toHaveLength(1);

    await pool.query(`select pg_notify('gsm_test_channel', 'after-reconnect')`);
    await eventually(() => (notifications.length > 0 ? true : undefined));
    expect(notifications).toEqual([['gsm_test_channel', 'after-reconnect']]);
  });

  it('keeps trying while Postgres is unreachable and never throws', async () => {
    const dead = new URL(TEST_DATABASE_URL);
    dead.port = String(await freePort());
    const { listener, connected, timers, attempts } = listen(dead.toString());
    await listener.start();
    expect(listener.listening).toBe(false);
    // Each time its wait is over it tries again, and the wait grows (50, 100, 200 ms, +-20 %).
    const waits: number[] = [];
    for (let round = 1; round <= 3; round++) {
      expect(attempts.count).toBe(round);
      await eventually(() => (timers.pending > 0 ? true : undefined));
      waits.push(timers.delays[0]!);
      timers.advance(waits.at(-1)!);
      await eventually(() => (attempts.count > round ? true : undefined));
    }
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
    expect(listener.listening).toBe(false);
    expect(connected).toEqual([]);
    await listener.stop();
  });
});
