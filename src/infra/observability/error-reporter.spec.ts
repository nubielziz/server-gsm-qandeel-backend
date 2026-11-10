// Spike and unit tests of the Sentry wiring (decision 015, feature 24D): the SDK runs under Bun with an in-memory transport,
// delivers one scrubbed event per capture, and does nothing at all without a DSN.
import { afterEach, describe, expect, it } from 'bun:test';
import * as Sentry from '@sentry/bun';
import { parseEnv } from '../../config';
import { ErrorReporter, type SentryTransportFactory } from './error-reporter';

interface SentryEvent {
  message?: string;
  level?: string;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  request?: unknown;
  user?: unknown;
  server_name?: string;
  exception?: { values?: { type?: string; value?: string; stacktrace?: { frames?: unknown[] } }[] };
}

/** A transport that keeps what the SDK would have sent; `failing` makes every send fail. */
function memoryTransport(failing = false): {
  factory: SentryTransportFactory;
  events: SentryEvent[];
  sent: () => number;
} {
  const events: SentryEvent[] = [];
  let sent = 0;
  const factory: SentryTransportFactory = () => ({
    send: (envelope) => {
      sent += 1;
      if (failing) return Promise.reject(new Error('network down'));
      for (const [header, payload] of envelope[1] as unknown as [{ type: string }, SentryEvent][]) {
        if (header.type === 'event') events.push(payload);
      }
      return Promise.resolve({});
    },
    flush: () => Promise.resolve(true),
  });
  return { factory, events, sent: () => sent };
}

const DSN = 'https://publickey@o0.ingest.sentry.io/1';
const config = (env: Record<string, string> = {}) => parseEnv({ NODE_ENV: 'test', ...env });

const reporters: ErrorReporter[] = [];
function start(env: Record<string, string>, transport?: SentryTransportFactory): ErrorReporter {
  const reporter = new ErrorReporter(config(env), transport ? { transport } : undefined);
  reporters.push(reporter);
  reporter.onModuleInit();
  return reporter;
}
afterEach(async () => {
  for (const reporter of reporters.splice(0)) await reporter.onApplicationShutdown();
});

describe('without SENTRY_DSN', () => {
  it('is a no-op: the SDK is never initialised and nothing is sent', async () => {
    const { factory, sent } = memoryTransport();
    const reporter = start({}, factory);
    expect(reporter.enabled).toBe(false);
    reporter.capture(new Error('boom'), { process: 'api' });
    expect(await reporter.flush()).toBe(true);
    expect(Sentry.getClient()).toBeUndefined();
    expect(sent()).toBe(0);
  });

  it('opens no connection at import or at shutdown', async () => {
    const reporter = start({});
    await reporter.onApplicationShutdown();
    expect(Sentry.getClient()).toBeUndefined();
  });
});

describe('with SENTRY_DSN', () => {
  it('delivers one scrubbed event per capture, tagged with where it happened', async () => {
    const { factory, events } = memoryTransport();
    const reporter = start({ SENTRY_DSN: DSN, APP_VERSION: '1.2.3', GIT_SHA: 'abcdef0123456' }, factory);
    expect(reporter.enabled).toBe(true);
    reporter.capture(new Error('lookup failed for rania@example.com, imei 356938035643809'), {
      process: 'api',
      requestId: 'req-42',
      surface: 'admin',
      route: '/admin/orders/:id',
      method: 'GET',
      code: 'INTERNAL_ERROR',
    });
    expect(await reporter.flush()).toBe(true);

    expect(events).toHaveLength(1);
    const event = events[0] as SentryEvent;
    expect(event.tags).toEqual({
      process: 'api',
      request_id: 'req-42',
      surface: 'admin',
      route: '/admin/orders/:id',
      method: 'GET',
      code: 'INTERNAL_ERROR',
    });
    expect(event.release).toBe('1.2.3+abcdef0');
    expect(event.environment).toBe('test');
    const value = event.exception?.values?.[0];
    expect(value?.type).toBe('Error');
    expect(value?.value).toBe('lookup failed for r***@example.com, imei ***3809');
    expect(value?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.server_name).toBeUndefined();
  });

  it('tags a job failure with its queue and job name', async () => {
    const { factory, events } = memoryTransport();
    const reporter = start({ SENTRY_DSN: DSN }, factory);
    reporter.capture(new Error('supplier timeout'), { process: 'worker', queue: 'supplier-dispatch', job: 'dispatch' });
    await reporter.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({ process: 'worker', queue: 'supplier-dispatch', job: 'dispatch' });
  });

  it('never throws when the transport fails', async () => {
    const { factory, sent } = memoryTransport(true);
    const reporter = start({ SENTRY_DSN: DSN }, factory);
    expect(() => reporter.capture(new Error('boom'), { process: 'api' })).not.toThrow();
    await reporter.flush();
    expect(sent()).toBeGreaterThan(0);
  });

  it('stops the SDK on shutdown, and a capture after that does nothing', async () => {
    const { factory, events } = memoryTransport();
    const reporter = start({ SENTRY_DSN: DSN }, factory);
    reporter.capture(new Error('before'), { process: 'api' });
    await reporter.onApplicationShutdown();
    expect(events).toHaveLength(1);
    expect(reporter.enabled).toBe(false);
    reporter.capture(new Error('after'), { process: 'api' });
    await reporter.flush();
    expect(events).toHaveLength(1);
  });
});
