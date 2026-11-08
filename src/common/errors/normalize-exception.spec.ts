// Unit tests for normalizeException (decision 028): AppError, Nest HttpException, Fastify errors and unknown errors.
import { describe, expect, it } from 'bun:test';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from './app-error';
import { buildProblem } from './problem';
import { codeForStatus, normalizeException } from './normalize-exception';

const dev = { exposeInternals: true };
const prod = { exposeInternals: false };

const fastifyError = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code, name: 'FastifyError' });

describe('normalizeException', () => {
  it('keeps an AppError as it is', () => {
    const error = new AppError('EMAIL_TAKEN', { detail: 'taken' });
    const result = normalizeException(error, prod);
    expect(result.error).toBe(error);
    expect(result.logAsError).toBe(false);
  });

  it('logs an AppError with a 5xx status', () => {
    expect(normalizeException(new AppError('DATABASE_UNAVAILABLE'), prod).logAsError).toBe(true);
    expect(normalizeException(new AppError('NOT_FOUND'), prod).logAsError).toBe(false);
    expect(normalizeException(new AppError('MAINTENANCE'), prod).logAsError).toBe(false);
  });

  it('maps an unknown route (Nest NotFoundException) to NOT_FOUND with a fixed sentence', () => {
    const { error } = normalizeException(new NotFoundException('Cannot GET /secret/path?token=1'), prod);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.detail).toBe('No endpoint matches this request.');
    expect(error.detail).not.toContain('secret');
  });

  it('maps Fastify body errors that Nest wraps as HttpException', () => {
    expect(
      normalizeException(
        new HttpException('Body is not valid JSON but content-type is set to application/json', 400),
        prod,
      ).error.code,
    ).toBe('BAD_REQUEST');
    expect(normalizeException(new HttpException('Request body is too large', 413), prod).error.code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    expect(normalizeException(new HttpException('Unsupported Media Type: text/plain', 415), prod).error.code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('maps raw Fastify errors by status', () => {
    const tooLarge = normalizeException(
      fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE', 'Request body is too large'),
      prod,
    );
    expect(tooLarge.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(tooLarge.logAsError).toBe(false);
    expect(normalizeException(fastifyError(400, 'FST_ERR_CTP_INVALID_JSON_BODY', 'bad json'), prod).error.code).toBe(
      'BAD_REQUEST',
    );
    expect(normalizeException(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE', 'x'), prod).error.code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('keeps the message of explicit 401/403/409 exceptions', () => {
    expect(normalizeException(new ForbiddenException('You need the x:y permission'), prod).error.detail).toBe(
      'You need the x:y permission',
    );
    expect(normalizeException(new BadRequestException('ignored text'), prod).error.detail).toBe(
      'The request could not be read. Check that the URL and the JSON body are valid.',
    );
  });

  it('turns anything else into INTERNAL_ERROR with a generic detail in production', () => {
    const secret = new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    const { error, logAsError } = normalizeException(secret, prod);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.status).toBe(500);
    expect(logAsError).toBe(true);
    expect(error.detail).not.toContain('hunter2');
    expect(error.detail).not.toContain('ECONNREFUSED');
    expect(error.cause).toBe(secret);
  });

  it('shows the message (never the stack) outside production', () => {
    const { error } = normalizeException(new TypeError('boom'), dev);
    expect(error.detail).toBe('TypeError: boom');
    expect(error.detail).not.toContain(' at ');
  });

  it('treats a raw ZodError and non-Error values as server faults', () => {
    const zodError = z.string().safeParse(1).error!;
    expect(normalizeException(zodError, prod).error.code).toBe('INTERNAL_ERROR');
    expect(normalizeException('a string', prod).error.code).toBe('INTERNAL_ERROR');
    expect(normalizeException(undefined, prod).error.code).toBe('INTERNAL_ERROR');
  });

  it('maps a 5xx HttpException without leaking its message in production', () => {
    const result = normalizeException(new HttpException('database password is x', 502), prod);
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.detail).not.toContain('password');
    expect(result.logAsError).toBe(true);
  });
});

describe('normalizeException with a Postgres deadlock or serialization failure', () => {
  const retryDetail = 'This was changed by another request at the same moment. Try again.';
  const driverError = (code: string) => Object.assign(new Error('driver error'), { code });

  it.each([
    ['40P01', 'deadlock detected'],
    ['40001', 'serialization failure'],
  ])('answers SQLSTATE %s (%s) as a retryable 409 CONFLICT, logged as a warning only', (code) => {
    const exception = driverError(code);
    for (const options of [prod, dev]) {
      const result = normalizeException(exception, options);
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.status).toBe(409);
      expect(result.error.detail).toBe(retryDetail);
      expect(result.error.cause).toBe(exception);
      expect(result.logAsError).toBe(false);
      expect(result.logAsWarning).toBe(true);
    }
  });

  it('finds the SQLSTATE in the cause of a wrapped error (the way Drizzle wraps the driver error)', () => {
    const wrapped = new Error('Failed query: update "ledger_accounts" set "balance" = $1', {
      cause: driverError('40P01'),
    });
    const result = normalizeException(wrapped, prod);
    expect(result.error.code).toBe('CONFLICT');
    expect(result.error.detail).toBe(retryDetail);
    expect(result.error.detail).not.toContain('ledger_accounts');
    expect(result.logAsWarning).toBe(true);
    const twice = normalizeException(new Error('outer', { cause: wrapped }), prod);
    expect(twice.error.code).toBe('CONFLICT');
  });

  it('keeps every other Postgres error a server fault', () => {
    for (const code of ['23505', '57014', '40002']) {
      const result = normalizeException(new Error('wrapped', { cause: driverError(code) }), prod);
      expect(result.error.code).toBe('INTERNAL_ERROR');
      expect(result.logAsError).toBe(true);
      expect(result.logAsWarning).toBe(false);
    }
  });
});

describe('codeForStatus', () => {
  it('maps the statuses the framework produces', () => {
    expect(codeForStatus(409)).toBe('CONFLICT');
    expect(codeForStatus(422)).toBe('VALIDATION_FAILED');
    expect(codeForStatus(429)).toBe('RATE_LIMITED');
    expect(codeForStatus(503)).toBe('UNAVAILABLE');
    expect(codeForStatus(418)).toBe('BAD_REQUEST');
    expect(codeForStatus(599)).toBe('INTERNAL_ERROR');
  });
});

describe('buildProblem', () => {
  it('builds the decision-028 body', () => {
    const error = new AppError('VALIDATION_FAILED', {
      detail: 'One field is not valid.',
      errors: [{ field: 'items.0.imei', code: 'too_small', message: 'Too short' }],
    });
    expect(buildProblem(error, { requestId: 'r1', errorsBaseUrl: 'https://errors.gsm.example' })).toEqual({
      type: 'https://errors.gsm.example/validation-failed',
      title: 'Some fields are not valid.',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'One field is not valid.',
      errors: [{ field: 'items.0.imei', code: 'too_small', message: 'Too short' }],
      requestId: 'r1',
    });
  });

  it('defaults detail to the title and omits an empty errors list', () => {
    const problem = buildProblem(new AppError('NOT_FOUND'), { requestId: 'r2', errorsBaseUrl: 'http://x/errors' });
    expect(problem.detail).toBe('The requested item was not found.');
    expect('errors' in problem).toBe(false);
  });

  it('adds the extension members of the error, and lets the fixed members win', () => {
    const error = new AppError('MAINTENANCE', {
      detail: 'Back soon.',
      extensions: { expectedEndAt: '2026-03-01T10:00:00.000Z', status: 200, requestId: 'forged' },
    });
    expect(buildProblem(error, { requestId: 'r3', errorsBaseUrl: 'http://x/errors' })).toEqual({
      type: 'http://x/errors/maintenance',
      title: 'The service is in maintenance.',
      status: 503,
      code: 'MAINTENANCE',
      detail: 'Back soon.',
      requestId: 'r3',
      expectedEndAt: '2026-03-01T10:00:00.000Z',
    });
  });
});
