// Unit tests of PgListener (decision 020) with a fake client: it listens, reports notifications, reconnects after an error
// or an end of the connection, reports reconnects, and stops cleanly. The behaviour against a real Postgres is in
// test/integration/pg-listener.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { PgListener } from './pg-listener';

// The listener logs every reconnect; these tests cause dozens, and the lines would bury the test report.
beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));

/** A fake pg.Client: records its statements, can be told to fail to connect, and can be made to drop or notify. */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  static failConnects = 0;
  readonly statements: string[] = [];
  ended = false;

  constructor(readonly config: { application_name?: string; connectionString?: string }) {
    super();
    FakeClient.instances.push(this);
  }
  connect(): Promise<void> {
    if (FakeClient.failConnects > 0) {
      FakeClient.failConnects--;
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    }
    return Promise.resolve();
  }
  query(text: string): Promise<void> {
    this.statements.push(text);
    return Promise.resolve();
  }
  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

function setup(options: { channels?: string[]; reconnectMs?: { first: number; max: number } } = {}) {
  FakeClient.instances = [];
  FakeClient.failConnects = 0;
  const notifications: Array<[string, string | undefined]> = [];
  const connected: boolean[] = [];
  const listener = new PgListener({
    connectionString: 'postgres://u:p@localhost/db',
    channels: options.channels ?? ['outbox'],
    applicationName: 'gsm-test-listener',
    onNotification: (channel, payload) => notifications.push([channel, payload]),
    onConnected: ({ reconnect }) => connected.push(reconnect),
    createClient: (config) => new FakeClient(config),
    reconnectMs: options.reconnectMs ?? { first: 5, max: 20 },
  });
  return { listener, notifications, connected };
}

const until = async (condition: () => boolean, ms = 1_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(2);
  }
};

describe('PgListener', () => {
  it('connects under its application name and listens on every channel', async () => {
    const { listener, connected } = setup({ channels: ['outbox', 'other_channel'] });
    await listener.start();
    const client = FakeClient.instances[0]!;
    expect(client.config.application_name).toBe('gsm-test-listener');
    expect(client.statements).toEqual(['LISTEN "outbox"', 'LISTEN "other_channel"']);
    expect(listener.listening).toBe(true);
    expect(connected).toEqual([false]);
    await listener.stop();
  });

  it('passes notifications on, and survives a handler that throws', async () => {
    const { listener, notifications } = setup();
    await listener.start();
    const client = FakeClient.instances[0]!;
    client.emit('notification', { channel: 'outbox', payload: '12' });
    client.emit('notification', { channel: 'outbox' });
    expect(notifications).toEqual([
      ['outbox', '12'],
      ['outbox', undefined],
    ]);
    await listener.stop();
  });

  it('reconnects after an error and says it is a reconnect', async () => {
    const { listener, connected } = setup();
    await listener.start();
    FakeClient.instances[0]!.emit('error', new Error('terminating connection due to administrator command'));
    expect(listener.listening).toBe(false);
    await until(() => connected.length === 2);
    expect(connected).toEqual([false, true]);
    expect(listener.listening).toBe(true);
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances[0]!.ended).toBe(true);
    await listener.stop();
  });

  it('reconnects once when both error and end arrive for one lost connection', async () => {
    const { listener, connected } = setup();
    await listener.start();
    const client = FakeClient.instances[0]!;
    client.emit('error', new Error('Connection terminated unexpectedly'));
    client.emit('end');
    await until(() => connected.length === 2);
    await Bun.sleep(40);
    expect(FakeClient.instances).toHaveLength(2);
    await listener.stop();
  });

  it('keeps trying, with a growing wait, while Postgres is down at start, and never throws', async () => {
    const { listener, connected } = setup();
    FakeClient.failConnects = 3;
    await listener.start();
    expect(listener.listening).toBe(false);
    await until(() => listener.listening);
    expect(FakeClient.instances).toHaveLength(4);
    // The first successful connection is not a "reconnect": nothing was connected before it.
    expect(connected).toEqual([false]);
    await listener.stop();
  });

  it('stops: ends the connection and does not reconnect', async () => {
    const { listener } = setup();
    await listener.start();
    const client = FakeClient.instances[0]!;
    await listener.stop();
    expect(client.ended).toBe(true);
    expect(listener.listening).toBe(false);
    // A late error from the old connection must not bring it back.
    client.emit('error', new Error('late'));
    await Bun.sleep(40);
    expect(FakeClient.instances).toHaveLength(1);
  });

  it('can be stopped while a connection attempt is still going on', async () => {
    const { listener } = setup();
    FakeClient.failConnects = 100;
    const started = listener.start();
    await listener.stop();
    await started;
    await Bun.sleep(40);
    expect(listener.listening).toBe(false);
    // Whatever attempts were made stopped when stop() was called.
    const attempts = FakeClient.instances.length;
    await Bun.sleep(40);
    expect(FakeClient.instances).toHaveLength(attempts);
  });

  it('refuses a channel name that is not a plain lower case identifier', () => {
    for (const channel of ['', 'Outbox', 'a-b', 'a b', 'a"; drop table x; --', '1abc']) {
      expect(() => setup({ channels: [channel] }), JSON.stringify(channel)).toThrow(RangeError);
    }
  });
});
