// Unit tests of the email verification of every account (decision 064, B123, decision 052): the link proves the mailbox, the holder's
// session proves the password, and an account that may not act gets the one 410. The database, the token store and the session core are fakes.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import { parseEnv } from '@src/config';
import type { AccountRecord } from '@src/modules/identity/accounts/account-directory';
import { AccountEmailVerificationService } from '@src/modules/identity/application/account-email-verification.service';
import * as accountRepository from '@src/modules/identity/infra/merchant-auth.repository';
import type { AccountPrincipal } from '@src/modules/identity/ports/account-principal';
import { CSRF_HEADER, CsrfService } from '@src/modules/identity/security/csrf';

const calls: string[] = [];
let consumed = true;
let voidPassword: boolean | undefined;

const NOW = new Date('2026-11-24T10:00:00Z');
const clock = { now: () => NOW, nowMs: () => NOW.getTime() };
const csrf = new CsrfService(parseEnv({ NODE_ENV: 'test' }));
const TOKEN_HASH = 'd'.repeat(64);
const meta = { ip: '203.0.113.9', userAgent: 'test agent', limitKey: '203.0.113.9' };

function account(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 5,
    email: 'buyer@example.com',
    name: 'Buyer',
    status: 'active',
    groupId: 1,
    rankKind: 'retail',
    hasAccount: true,
    hasPassword: true,
    emailVerifiedAt: null,
    country: 'GB',
    currency: null,
    ...overrides,
  };
}

let stored: AccountRecord | undefined;
let lockedAs: AccountRecord | undefined;
let link: Record<string, unknown> | undefined;
let authenticated: unknown;
let asked: number;
let enforced: string[][];
let issued: Record<string, unknown>[];
let enqueued: Record<string, unknown>[];
let revokedFor: number[];
let invalidated: number[];
let afterCommit: Array<() => void | Promise<void>>;

const work = {
  tx: { name: 'tx' },
  afterCommit: (callback: () => void | Promise<void>) => {
    afterCommit.push(callback);
  },
};
const db = {
  db: { name: 'pool' },
  runInTransaction: async <T>(fn: (w: typeof work) => Promise<T>) => {
    try {
      const result = await fn(work);
      calls.push('commit');
      for (const callback of afterCommit) await callback();
      return result;
    } catch (error) {
      calls.push('rollback');
      throw error;
    }
  },
};
const directory = {
  findById: () => Promise.resolve(stored),
  lockForUpdate: () => Promise.resolve(lockedAs ?? stored),
};
const tokens = {
  findByHash: () => Promise.resolve(link),
  consume: () => {
    calls.push('consume');
    return Promise.resolve(consumed);
  },
  issue: (_work: unknown, input: Record<string, unknown>) => {
    issued.push(input);
    return Promise.resolve({ tokenId: 90, token: 'placeholder' });
  },
};
const mail = {
  enqueue: (_work: unknown, input: Record<string, unknown>) => {
    enqueued.push(input);
    return Promise.resolve();
  },
};
const sessions = {
  revokeAll: (_tx: unknown, id: number) => {
    revokedFor.push(id);
    return Promise.resolve(2);
  },
  invalidate: (id: number) => {
    invalidated.push(id);
    return Promise.resolve();
  },
};
const authenticator = {
  authenticateOptional: () => {
    asked += 1;
    return Promise.resolve(authenticated);
  },
};
const limiter = {
  enforceLink: (limitKey: string) => {
    enforced.push(['token', limitKey]);
    return Promise.resolve();
  },
};
const limits = {
  enforce: (...args: string[]) => {
    enforced.push(args);
    return Promise.resolve();
  },
};

const service = () =>
  new AccountEmailVerificationService(
    db as never,
    directory as never,
    tokens as never,
    mail,
    sessions as never,
    authenticator as never,
    csrf,
    limiter as never,
    limits as never,
    clock,
  );

const withCsrf = () => ({ headers: { [CSRF_HEADER]: csrf.tokenFor(TOKEN_HASH) } }) as unknown as FastifyRequest;
const withoutCsrf = () => ({ headers: {} }) as unknown as FastifyRequest;

/** A full session of an account, as `authenticateOptional` answers it. */
const sessionOf = (accountId: number) => ({
  view: { tokenHash: TOKEN_HASH },
  principal: { kind: 'account', accountId, clientId: accountId, rank: { id: 1, kind: 'retail' }, stage: 'active' },
});

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error as AppError,
  );

afterEach(() => mock.restore());

beforeEach(() => {
  // The repository functions are the only database the service calls directly; each spy is undone by `mock.restore`.
  spyOn(accountRepository, 'markClientEmailVerified').mockImplementation(
    (_tx: unknown, _id: number, _now: Date, options: { voidPassword?: boolean } = {}) => {
      calls.push('verified');
      voidPassword = options.voidPassword;
      return Promise.resolve();
    },
  );
  calls.length = 0;
  consumed = true;
  voidPassword = undefined;
  stored = account();
  lockedAs = undefined;
  link = {
    id: 21,
    purpose: 'verify_email',
    subjectId: 5,
    usedAt: null,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  };
  authenticated = undefined;
  asked = 0;
  enforced = [];
  issued = [];
  enqueued = [];
  revokedFor = [];
  invalidated = [];
  afterCommit = [];
});

describe('AccountEmailVerificationService.verify', () => {
  it('counts the try of the address first', async () => {
    await service().verify('token', withoutCsrf(), meta);
    expect(enforced[0]).toEqual(['token', '203.0.113.9']);
  });

  it("with the holder's full session and its CSRF token it only stamps the mailbox", async () => {
    authenticated = sessionOf(5);
    await service().verify('token', withCsrf(), meta);
    expect(voidPassword).toBe(false);
    expect(revokedFor).toEqual([]);
    expect(issued).toEqual([]);
    expect(calls).toEqual(['consume', 'verified', 'commit']);
  });

  it('without that session the password and the second factor end, every session ends and a reset link is mailed', async () => {
    await service().verify('token', withoutCsrf(), meta);
    expect(voidPassword).toBe(true);
    expect(revokedFor).toEqual([5]);
    expect(issued).toEqual([{ accountId: 5, purpose: 'reset', ip: '203.0.113.9' }]);
    expect(enqueued).toEqual([{ kind: 'password_reset', accountId: 5, tokenId: 90 }]);
    // the cached views of the ended sessions are dropped after the commit, never before
    expect(invalidated).toEqual([5]);
  });

  it('treats the session of another account as no session', async () => {
    authenticated = sessionOf(99);
    await service().verify('token', withCsrf(), meta);
    expect(voidPassword).toBe(true);
    expect(revokedFor).toEqual([5]);
  });

  it('only stamps an account without a password, and never reads a session for it', async () => {
    stored = account({ hasPassword: false });
    await service().verify('token', withoutCsrf(), meta);
    expect(voidPassword).toBe(false);
    expect(revokedFor).toEqual([]);
    expect(issued).toEqual([]);
    expect(asked).toBe(0);
  });

  it("answers 403 CSRF_FAILED for the holder's session without its token, and the link stays usable", async () => {
    authenticated = sessionOf(5);
    const error = await refusal(service().verify('token', withoutCsrf(), meta));
    expect(error).toMatchObject({ code: 'CSRF_FAILED' });
    // the use of the link and nothing else is rolled back with the transaction
    expect(calls.at(-1)).toBe('rollback');
    expect(calls).not.toContain('verified');
    expect(revokedFor).toEqual([]);
  });

  it.each([
    ['an unknown link', () => (link = undefined)],
    ['a used link', () => (link = { ...link, usedAt: new Date(NOW.getTime() - 1) })],
    ['an expired link', () => (link = { ...link, expiresAt: new Date(NOW.getTime() - 1) })],
    ['a sign-in link', () => (link = { ...link, purpose: 'magic_link' })],
    ['a password link', () => (link = { ...link, purpose: 'reset' })],
    ['a suspended account', () => (stored = account({ status: 'suspended' }))],
    ['a blocked account', () => (stored = account({ status: 'blocked' }))],
    ['an anonymized account', () => (stored = account({ status: 'anonymized' }))],
    ['a guest row', () => (stored = account({ hasAccount: false, hasPassword: false }))],
    ['a missing account', () => (stored = undefined)],
  ])('answers 410 TOKEN_INVALID for %s, and writes nothing', async (_name, setUp) => {
    setUp();
    const error = await refusal(service().verify('token', withoutCsrf(), meta));
    expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
    expect(calls).not.toContain('verified');
    expect(calls).not.toContain('consume');
  });

  it('answers 410 when the account stopped being able to act between the read and the row lock', async () => {
    lockedAs = account({ status: 'suspended' });
    expect((await refusal(service().verify('token', withoutCsrf(), meta)))?.code).toBe('TOKEN_INVALID');
    expect(calls).toEqual(['rollback']);
  });

  it('answers 410 when a parallel request used the link first', async () => {
    consumed = false;
    expect((await refusal(service().verify('token', withoutCsrf(), meta)))?.code).toBe('TOKEN_INVALID');
    expect(calls).toEqual(['consume', 'rollback']);
    expect(revokedFor).toEqual([]);
  });

  it('reads the password under the row lock: one set a moment ago is protected', async () => {
    stored = account({ hasPassword: false });
    lockedAs = account({ hasPassword: true });
    await service().verify('token', withoutCsrf(), meta);
    expect(voidPassword).toBe(true);
    expect(revokedFor).toEqual([5]);
  });
});

describe('AccountEmailVerificationService.resend', () => {
  const principal = { accountId: 5 } as AccountPrincipal;

  it('issues a verification link, queues its mail and counts one point of the account-mail budget', async () => {
    await service().resend(principal, meta);
    expect(enforced).toHaveLength(1);
    expect(enforced[0]![0]).toBe('account-mail');
    expect(issued).toEqual([{ accountId: 5, purpose: 'verify_email', ip: '203.0.113.9' }]);
    expect(enqueued).toEqual([{ kind: 'email_verification', accountId: 5, tokenId: 90 }]);
  });

  it('answers 409 CONFLICT for an address that is already verified', async () => {
    stored = account({ emailVerifiedAt: NOW });
    const error = await refusal(service().resend(principal, meta));
    expect(error).toMatchObject({ code: 'CONFLICT', detail: 'This email address is already verified.' });
    expect(enforced).toEqual([]);
    expect(issued).toEqual([]);
  });

  it('answers 403 ACCOUNT_SUSPENDED for a suspended or blocked account and 401 for an anonymized or missing one', async () => {
    stored = account({ status: 'suspended' });
    expect((await refusal(service().resend(principal, meta)))?.code).toBe('ACCOUNT_SUSPENDED');
    stored = account({ status: 'blocked' });
    expect((await refusal(service().resend(principal, meta)))?.code).toBe('ACCOUNT_SUSPENDED');
    stored = account({ status: 'anonymized' });
    expect((await refusal(service().resend(principal, meta)))?.code).toBe('UNAUTHORIZED');
    stored = undefined;
    expect((await refusal(service().resend(principal, meta)))?.code).toBe('UNAUTHORIZED');
    expect(issued).toEqual([]);
  });
});
