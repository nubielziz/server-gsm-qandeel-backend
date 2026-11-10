// Unit tests of what the exception filter reports to Sentry (decision 015, feature 24D): unexpected 5xx only, with the request's
// route, surface and id as tags. The filter runs with fakes (no Nest app, no database); the SDK runs with an in-memory transport.
import { afterEach, describe, expect, it } from 'bun:test';
import { HttpException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { parseEnv } from '../../config';
import { MetricsService } from '../../infra/metrics/metrics.service';
import { ErrorReporter, type SentryTransportFactory } from '../../infra/observability/error-reporter';
import { AppError } from './app-error';
import { ProblemExceptionFilter } from './exception.filter';
import { ErrorFormatterRegistry } from './formatter-registry';

const events: { tags?: Record<string, string> }[] = [];
const transport: SentryTransportFactory = () => ({
  send: (envelope) => {
    for (const [header, payload] of envelope[1] as unknown as [{ type: string }, { tags?: Record<string, string> }][]) {
      if (header.type === 'event') events.push(payload);
    }
    return Promise.resolve({});
  },
  flush: () => Promise.resolve(true),
});

const reporters: ErrorReporter[] = [];
afterEach(async () => {
  events.length = 0;
  for (const reporter of reporters.splice(0)) await reporter.onApplicationShutdown();
});

function setup(dsn: string | undefined): { filter: ProblemExceptionFilter; reporter: ErrorReporter } {
  const config = parseEnv({ NODE_ENV: 'test', ...(dsn ? { SENTRY_DSN: dsn } : {}) });
  const reporter = new ErrorReporter(config, { transport });
  reporter.onModuleInit();
  reporters.push(reporter);
  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  } as unknown as PinoLogger;
  const filter = new ProblemExceptionFilter(
    config,
    new ErrorFormatterRegistry(),
    new MetricsService(),
    logger,
    reporter,
  );
  return { filter, reporter };
}

/** Runs the filter on a fake request and returns the status it answered. */
function answer(filter: ProblemExceptionFilter, exception: unknown, path = '/admin/orders/12'): number {
  let status = 0;
  const reply = {
    sent: false,
    code: () => reply,
    status: (value: number) => {
      status = value;
      return reply;
    },
    headers: () => reply,
    type: () => reply,
    send: () => reply,
  };
  const request = {
    id: 'req-77',
    raw: { method: 'GET', url: path, headers: {} },
    routeOptions: { url: '/admin/orders/:id' },
  };
  filter.handle(exception, request as never, reply as never);
  return status;
}

const DSN = 'https://publickey@o0.ingest.sentry.io/1';

describe('ProblemExceptionFilter and Sentry', () => {
  it('reports an unexpected 500 once, with the route, surface, method, code and request id', async () => {
    const { filter, reporter } = setup(DSN);
    expect(answer(filter, new TypeError('cannot read properties of undefined'))).toBe(500);
    await reporter.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({
      process: 'api',
      request_id: 'req-77',
      surface: 'admin',
      route: '/admin/orders/:id',
      method: 'GET',
      code: 'INTERNAL_ERROR',
    });
  });

  it('reports an unhandled framework 5xx and a thrown INTERNAL_ERROR', async () => {
    const { filter, reporter } = setup(DSN);
    expect(answer(filter, new HttpException('upstream broke', 503))).toBe(503);
    expect(answer(filter, new AppError('INTERNAL_ERROR'))).toBe(500);
    await reporter.flush();
    expect(events).toHaveLength(2);
  });

  it('reports nothing for a 4xx answer', async () => {
    const { filter, reporter } = setup(DSN);
    expect(answer(filter, new AppError('NOT_FOUND'))).toBe(404);
    expect(answer(filter, new AppError('FORBIDDEN'))).toBe(403);
    expect(answer(filter, new HttpException('bad', 400))).toBe(400);
    await reporter.flush();
    expect(events).toHaveLength(0);
  });

  it('reports nothing for a deliberate 5xx answer of the catalog, a planned maintenance or a retryable database clash', async () => {
    const { filter, reporter } = setup(DSN);
    expect(answer(filter, new AppError('FX_PROVIDER_DOWN'))).toBe(502);
    expect(answer(filter, new AppError('MAINTENANCE'))).toBe(503);
    expect(answer(filter, Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(409);
    await reporter.flush();
    expect(events).toHaveLength(0);
  });

  it('answers the same and reports nothing when SENTRY_DSN is not set', async () => {
    const { filter, reporter } = setup(undefined);
    expect(answer(filter, new Error('boom'))).toBe(500);
    await reporter.flush();
    expect(events).toHaveLength(0);
  });
});
