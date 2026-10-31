// Unit tests for the logging rules of decision 012: masking, redaction, request id binding, level per environment.
import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import { runWithRequestId } from '../../common/request-id';
import { parseEnv } from '../../config';
import { maskEmail, maskImei, maskPhone } from './mask';
import { buildPinoOptions, chooseDestination } from './pino-options';

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
      'user-agent': 'curl/8',
    };
    logger.info({ req: { headers }, res: { headers }, headers, request: { headers } }, 'headers');
    const text = JSON.stringify(lines[0]);
    for (const secret of ['secret-token', 'gsm_admin_session', 'csrf-value', 'idem-1'])
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
      await new Promise((resolve) => setTimeout(resolve, 1));
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
