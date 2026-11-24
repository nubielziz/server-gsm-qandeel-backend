// Unit tests of the optional session of the shop checkout (decision 064): no session is a guest, a retail account is its id, a merchant rank
// is refused, and a cookie-authenticated request needs its CSRF token first.
import { beforeEach, describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import { parseEnv } from '@src/config';
import { OptionalAccountSessionService } from '@src/modules/identity/application/optional-account-session';
import { CSRF_HEADER, CsrfService } from '@src/modules/identity/security/csrf';

const TOKEN_HASH = 'c'.repeat(64);
const csrf = new CsrfService(parseEnv({ NODE_ENV: 'test' }));

/** What `authenticateOptional` answers: a live full session of an account of a rank kind. */
function sessionOf(kind: 'retail' | 'merchant', accountId = 42) {
  return {
    view: { tokenHash: TOKEN_HASH },
    principal: { kind: 'account', accountId, clientId: accountId, rank: { id: 1, kind }, stage: 'active' },
  };
}

const requestWith = (headers: Record<string, string> = {}) => ({ headers }) as unknown as FastifyRequest;
const withCsrf = () => requestWith({ [CSRF_HEADER]: csrf.tokenFor(TOKEN_HASH) });

let answer: unknown;
const asked: unknown[][] = [];
const authenticator = {
  authenticateOptional: (...args: unknown[]) => {
    asked.push(args);
    return Promise.resolve(answer);
  },
};
const service = () => new OptionalAccountSessionService(authenticator as never, csrf);

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error as AppError,
  );

beforeEach(() => {
  answer = undefined;
  asked.length = 0;
});

describe('OptionalAccountSessionService.retailAccountId', () => {
  it('asks for the account session at the full stage only', async () => {
    await service().retailAccountId(requestWith());
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe('account');
    expect(asked[0]![2]).toEqual({ stages: ['active'] });
  });

  it('answers undefined for a visitor with no live session (none, ended, pending or suspended)', async () => {
    answer = undefined;
    expect(await service().retailAccountId(requestWith())).toBeUndefined();
  });

  it('answers the id of a retail account with its CSRF token', async () => {
    answer = sessionOf('retail', 77);
    expect(await service().retailAccountId(withCsrf())).toBe(77);
  });

  it('refuses a retail session without the CSRF token with 403 CSRF_FAILED, before anything is read from it', async () => {
    answer = sessionOf('retail');
    const error = await refusal(service().retailAccountId(requestWith()));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'CSRF_FAILED' });
    expect((await refusal(service().retailAccountId(requestWith({ [CSRF_HEADER]: 'wrong' }))))?.code).toBe(
      'CSRF_FAILED',
    );
  });

  it('refuses a merchant rank with 403 RANK_NOT_ALLOWED and says it orders from its price list', async () => {
    answer = sessionOf('merchant');
    const error = await refusal(service().retailAccountId(withCsrf()));
    expect(error).toMatchObject({ code: 'RANK_NOT_ALLOWED', detail: 'Your account orders from its price list.' });
  });

  it('checks the CSRF token of a merchant rank first: without it the answer is CSRF_FAILED', async () => {
    answer = sessionOf('merchant');
    expect((await refusal(service().retailAccountId(requestWith())))?.code).toBe('CSRF_FAILED');
  });

  it('treats a principal that is not an account as no session', async () => {
    answer = { view: { tokenHash: TOKEN_HASH }, principal: { kind: 'staff' } };
    expect(await service().retailAccountId(withCsrf())).toBeUndefined();
  });
});
