// Unit tests for the logging rules of decision 012: masking, redaction, request id binding, level per environment, the level of an
// access log line (live event streams at debug, decision 037).
import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { runWithRequestId } from '@src/common/request-id';
import { parseEnv } from '@src/config';
import { accessLogLevel } from '@src/infra/logging/access-log';
import { maskEmail, maskImei, maskPhone } from '@src/infra/logging/mask';
import { buildPinoOptions, chooseDestination } from '@src/infra/logging/pino-options';
import { redactLogObject } from '@src/infra/logging/redaction';
import { DB_FAILURE_MARKER, drizzleFailure } from '../../../support/db-failure';

/** A pino logger with the project's options writing JSON lines into an array. */
function capture(env: Record<string, string> = { NODE_ENV: 'test', LOG_LEVEL: 'trace' }) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(buildPinoOptions(parseEnv(env), 'api'), {
    write: (text: string) => void lines.push(JSON.parse(text) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('masking', () => {
  it('masks an email as r***@domain', () => {
    expect(maskEmail('rami@gsm-supply.example')).toBe('r***@gsm-supply.example');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('not an email')).toBe('***');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail(undefined)).toBe('***');
    expect(maskEmail({ email: 'x@y.z' })).toBe('***');
  });

  it('keeps the last 3 digits of a phone number', () => {
    expect(maskPhone('+962 79 123 4567')).toBe('***567');
    expect(maskPhone(962791234567)).toBe('***567');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone(null)).toBe('***');
  });

  it('keeps the last 4 digits of an IMEI', () => {
    expect(maskImei('356938035643809')).toBe('***3809');
    expect(maskImei('35-693803-564380-9')).toBe('***3809');
    expect(maskImei('1234')).toBe('***');
  });
});

describe('pino options', () => {
  it('masks email, phone and imei fields through serializers', () => {
    const { logger, lines } = capture();
    logger.info(
      { email: 'rami@gsm-supply.example', phone: '+962791234567', imei: '356938035643809', name: 'Rami' },
      'login',
    );
    expect(lines[0]).toMatchObject({
      email: 'r***@gsm-supply.example',
      phone: '***567',
      imei: '***3809',
      name: 'Rami',
      msg: 'login',
    });
  });

  it('redacts credential headers wherever a headers object sits', () => {
    const { logger, lines } = capture();
    const headers = {
      authorization: 'Bearer secret-token',
      cookie: 'gsm_admin_session=abc',
      'set-cookie': ['gsm_admin_session=abc; HttpOnly'],
      'x-csrf-token': 'csrf-value',
      'idempotency-key': 'idem-1',
      'x-turnstile-token': 'turnstile-value',
      'user-agent': 'curl/8',
    };
    logger.info({ req: { headers }, res: { headers }, headers, request: { headers } }, 'headers');
    const text = JSON.stringify(lines[0]);
    for (const secret of ['secret-token', 'gsm_admin_session', 'csrf-value', 'idem-1', 'turnstile-value'])
      expect(text).not.toContain(secret);
    expect((lines[0]?.req as { headers: Record<string, string> }).headers['user-agent']).toBe('curl/8');
    expect((lines[0]?.req as { headers: Record<string, string> }).headers.authorization).toBe('[redacted]');
  });

  it('redacts secret fields at the top level and nested', () => {
    const { logger, lines } = capture();
    const secrets = {
      password: 'p1',
      currentPassword: 'p2',
      newPassword: 'p3',
      token: 't1',
      secret: 's1',
      apiaccesskey: 'k1',
      apiKey: 'k2',
      totpSecret: 'ts',
      otpauthUrl: 'otpauth://totp/x?secret=ABC',
    };
    logger.info({ ...secrets, payload: { ...secrets }, deep: { a: { b: { ...secrets } } } }, 'secrets');
    const text = JSON.stringify(lines[0]);
    for (const value of ['p1', 'p2', 'p3', 't1', 's1', 'k1', 'k2', 'otpauth://', 'ABC'])
      expect(text).not.toContain(`"${value}`);
    expect(lines[0]?.password).toBe('[redacted]');
    expect((lines[0]?.payload as Record<string, string>).apiKey).toBe('[redacted]');
  });

  it('redacts the 2FA code inside a body but keeps error codes in logs', () => {
    const { logger, lines } = capture();
    logger.info({ body: { code: '123456', email: 'x' }, req: { body: { code: '654321' } } }, 'body');
    logger.error({ err: new Error('boom'), code: 'NOT_FOUND', ctx: { code: 'ECONNRESET' } }, 'failure');
    const body = JSON.stringify(lines[0]);
    expect(body).not.toContain('123456');
    expect(body).not.toContain('654321');
    expect(lines[1]?.code).toBe('NOT_FOUND');
    expect((lines[1]?.ctx as { code: string }).code).toBe('ECONNRESET');
  });

  it('binds the request id to every line while a request runs', async () => {
    const { logger, lines } = capture();
    logger.info('before');
    await runWithRequestId('req-42', async () => {
      logger.info('inside');
      // A turn of the event loop, so the context must survive a real asynchronous hop (no timer, no wait).
      await new Promise((resolve) => setImmediate(resolve));
      logger.warn({ extra: 1 }, 'after await');
    });
    logger.info('after');
    expect(lines.map((line) => line.requestId)).toEqual([undefined, 'req-42', 'req-42', undefined]);
  });

  it('lets an explicit requestId win without duplicating the key', () => {
    const lines: string[] = [];
    const logger = pino(buildPinoOptions(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'trace' }), 'api'), {
      write: (text: string) => void lines.push(text),
    });
    runWithRequestId('from-context', () => logger.info({ requestId: 'explicit' }, 'x'));
    expect(lines[0]?.match(/"requestId"/g)?.length).toBe(1);
    expect(lines[0]).toContain('"requestId":"explicit"');
  });

  it('labels lines with the service and uses ISO times', () => {
    const { logger, lines } = capture();
    logger.info('hello');
    expect(lines[0]?.service).toBe('api');
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('follows the level per environment', () => {
    expect(buildPinoOptions(parseEnv({ NODE_ENV: 'test' }), 'api').level).toBe('warn');
    expect(buildPinoOptions(parseEnv({ NODE_ENV: 'development' }), 'api').level).toBe('debug');
    expect(buildPinoOptions(parseEnv({ NODE_ENV: 'development', LOG_LEVEL: 'error' }), 'worker').level).toBe('error');
    const { logger, lines } = capture({ NODE_ENV: 'test' });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });
});

describe('log destination', () => {
  it('uses the injected stream, pretty text only in development and plain JSON otherwise', async () => {
    const injected = { write: () => undefined };
    expect(await chooseDestination(parseEnv({ NODE_ENV: 'test' }), injected)).toBe(injected);
    expect(await chooseDestination(parseEnv({ NODE_ENV: 'test' }), undefined)).toBeUndefined();
    expect(await chooseDestination(parseEnv({ NODE_ENV: 'development' }), undefined)).toBeDefined();
  });
});

describe('accessLogLevel', () => {
  const facts = {
    route: '/admin/orders',
    status: 200,
    code: undefined,
    contentType: 'application/json; charset=utf-8',
  };

  it('logs successes at info, refusals at warn and faults at error, a maintenance 503 like a refusal', () => {
    expect(accessLogLevel(facts)).toBe('log');
    expect(accessLogLevel({ ...facts, status: 404, code: 'NOT_FOUND' })).toBe('warn');
    expect(accessLogLevel({ ...facts, status: 500, code: 'INTERNAL_ERROR' })).toBe('error');
    expect(accessLogLevel({ ...facts, status: 503, code: 'MAINTENANCE' })).toBe('warn');
  });

  it('logs health probes, metric scrapes and live event streams at debug (decision 037)', () => {
    expect(accessLogLevel({ ...facts, route: '/health' })).toBe('debug');
    expect(accessLogLevel({ ...facts, route: '/metrics' })).toBe('debug');
    expect(
      accessLogLevel({ ...facts, route: '/store/v1/me/stream', contentType: 'text/event-stream; charset=utf-8' }),
    ).toBe('debug');
  });

  it('keeps a refused stream (a problem+json answer) at warn', () => {
    expect(
      accessLogLevel({
        ...facts,
        route: '/store/v1/me/stream',
        status: 429,
        code: 'RATE_LIMITED',
        contentType: 'application/problem+json',
      }),
    ).toBe('warn');
  });
});

/** The logger nestjs-pino builds from the same options: pino-http wraps the `err` serializer, so a serializer sees the standard form. */
function captureHttp() {
  const lines: Array<Record<string, unknown>> = [];
  const { logger } = pinoHttp(
    { ...buildPinoOptions(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'trace' }), 'api'), autoLogging: false },
    { write: (text: string) => void lines.push(JSON.parse(text) as Record<string, unknown>) },
  );
  return { logger, lines };
}

describe('database failures in log lines (decision 054)', () => {
  for (const [name, make] of [
    ['a plain pino logger', capture],
    ['the pino-http logger of nestjs-pino', captureHttp],
  ] as const) {
    it(`never writes a database statement or its values, whatever way the error is logged: ${name}`, () => {
      const { logger, lines } = make();
      const failure = drizzleFailure();
      logger.error({ err: failure, requestId: 'r1' }, 'with a message');
      logger.error(failure);
      logger.error('db: ' + failure.message);
      logger.error({ detail: { error: failure } }, 'nested');
      logger.error({ err: new Error('outer', { cause: failure }) }, 'wrapped');
      logger.warn({ msg: 'nested', detail: { deeper: { error: failure } } });
      expect(lines).toHaveLength(6);
      for (const line of lines) {
        const text = JSON.stringify(line);
        expect(text).not.toContain(DB_FAILURE_MARKER);
        expect(text).not.toContain('Failed query');
        expect(text).not.toContain('insert into');
      }
      expect((lines[0]?.err as { database: unknown }).database).toEqual({
        sqlState: '23514',
        table: 'job_runs',
        constraint: 'job_runs_trigger_check',
      });
      expect((lines[0]?.err as { message: string }).message).toStartWith('Database error 23514');
    });
  }

  it('keeps logging any other error in full', () => {
    const { logger, lines } = capture();
    const failure = Object.assign(new Error('supplier said no'), { statusCode: 502 });
    logger.error({ err: failure }, 'upstream');
    expect(lines[0]?.err).toMatchObject({ type: 'Error', message: 'supplier said no', statusCode: 502 });
  });

  it('removes statement text from a finished line and keeps the line valid JSON', () => {
    const { logger, lines } = capture();
    logger.error('before Failed query: select "a\\"b" from t params: x tail');
    expect(lines[0]?.msg).toBe('before [database statement removed]');
  });
});

describe('the log walk (decision 054)', () => {
  const secrets = {
    passwordHash: 'h',
    tokenHash: 't',
    configEnc: 'e',
    apiaccesskey: 'k',
    otpauthUrl: 'otpauth://totp/x?secret=ABC',
    recoveryCodes: ['a', 'b'],
    sentryDsn: 'https://key@sentry.example/1',
    'x-gsm-signature': 'sig',
  };

  it('redacts secret names at any depth', () => {
    const { logger, lines } = capture();
    logger.info({ ...secrets, one: { ...secrets }, five: { a: { b: { c: { d: { ...secrets } } } } } }, 'deep');
    const text = JSON.stringify(lines[0]);
    for (const value of ['"h"', '"t"', '"e"', '"k"', 'otpauth://', 'ABC', '"sig"', 'sentry.example', '"a","b"'])
      expect(text).not.toContain(value);
    const five = (lines[0]?.five as { a: { b: { c: { d: Record<string, unknown> } } } }).a.b.c.d;
    for (const key of Object.keys(secrets)) expect(five[key], key).toBe('[redacted]');
  });

  it('keeps flags and the boot summary markers readable under a secret name', () => {
    const { logger, lines } = capture();
    logger.info(
      { mustChangePassword: true, security: { tokenPepper: '[set]', lookupHashKey: '[unset]', salt: null } },
      'summary',
    );
    expect(lines[0]).toMatchObject({
      mustChangePassword: true,
      security: { tokenPepper: '[set]', lookupHashKey: '[unset]', salt: null },
    });
  });

  it('masks e-mail, phone and IMEI at any depth and keeps the top-level values of before', () => {
    const { logger, lines } = capture();
    logger.info({ email: 'rami@gsm-supply.example', phone: '+962791234567', imei: '356938035643809' }, 'top');
    logger.info(
      {
        customer: { email: 'rami@gsm-supply.example', phone: '+962791234567' },
        items: [{ imei: '356938035643809' }],
        emails: ['a@b.co', 'c@d.co'],
        recipientEmail: 'z@x.io',
      },
      'nested',
    );
    expect(lines[0]).toMatchObject({ email: 'r***@gsm-supply.example', phone: '***567', imei: '***3809' });
    expect(lines[1]).toMatchObject({
      customer: { email: 'r***@gsm-supply.example', phone: '***567' },
      items: [{ imei: '***3809' }],
      emails: ['a***@b.co', 'c***@d.co'],
      recipientEmail: 'z***@x.io',
    });
  });

  it('is bounded in depth and in work, never throws and does not change its input', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const walked = redactLogObject({ deep });
    expect(JSON.stringify(walked)).toContain('[truncated]');
    const wide = redactLogObject({ values: Array.from({ length: 20_000 }, (_, i) => i) });
    expect((wide.values as unknown[]).length).toBeLessThan(6000);
    expect((wide.values as unknown[]).at(-1)).toBe('[truncated]');
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('no');
        },
      },
    );
    expect(() => redactLogObject(hostile as Record<string, unknown>)).not.toThrow();
    const input = { token: 't', nested: { password: 'p' } };
    redactLogObject(input);
    expect(input).toEqual({ token: 't', nested: { password: 'p' } });
  });

  it('keeps dates and other class instances as they are', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    expect(redactLogObject({ at: when, nested: { at: when } })).toEqual({ at: when, nested: { at: when } });
  });

  it('costs little for a typical access-log line', () => {
    const line = {
      msg: 'request completed',
      requestId: 'r-1',
      method: 'GET',
      route: '/admin/orders',
      status: 200,
      durationMs: 3.2,
      code: 'X',
    };
    const rounds = 20_000;
    const started = performance.now();
    for (let i = 0; i < rounds; i++) redactLogObject(line);
    const microseconds = ((performance.now() - started) * 1000) / rounds;
    // Measured on the development machine at a few microseconds; the bound is coarse on purpose.
    expect(microseconds).toBeLessThan(100);
  });
});
