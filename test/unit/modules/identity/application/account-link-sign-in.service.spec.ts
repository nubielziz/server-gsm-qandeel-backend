// Unit tests of the sign-in link of the retail rank (decision 064): who gets a link, that every email runs the same statements, and the
// rules of the exchange (rank, status, the other browser, the guest row that becomes an account, the claim, two-step). The database, the
// token store and the session core are fakes; the integration test runs the same cases through HTTP.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import { parseEnv } from '@src/config';
import { TokenService } from '@src/infra/crypto';
import type { AccountRecord } from '@src/modules/identity/accounts/account-directory';
import { AccountLinkSignInService } from '@src/modules/identity/application/account-link-sign-in.service';
import * as requestMeta from '@src/modules/identity/application/request-meta';
import type { Client } from '@src/modules/identity/db/schema';
import * as clientAdminRepository from '@src/modules/identity/infra/client-admin.repository';
import * as accountRepository from '@src/modules/identity/infra/merchant-auth.repository';
import { AccountCreateGuards } from '@src/modules/identity/ports/account-create-guards';

const calls: string[] = [];
let consumed = true;
let twofa = false;

const NOW = new Date('2026-11-24T10:00:00Z');
const clock = { now: () => NOW, nowMs: () => NOW.getTime() };
const tokenService = new TokenService(parseEnv({ NODE_ENV: 'test' }));
const BROWSER_KEY = 'A'.repeat(43);
const meta = { ip: '203.0.113.9', userAgent: 'test agent', limitKey: '203.0.113.9' };

function account(id: number, overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    email: `user${id}@example.com`,
    name: `User ${id}`,
    status: 'active',
    groupId: 1,
    rankKind: 'retail',
    hasAccount: true,
    hasPassword: false,
    emailVerifiedAt: null,
    country: 'GB',
    currency: null,
    ...overrides,
  };
}

// --- fakes ---
const tx = { name: 'tx' };
const work = { tx, afterCommit: () => undefined };
let accounts: Map<number, AccountRecord>;
/** What the row lock reads when it differs from the first read (the account changed in between). */
let lockedAs: AccountRecord | undefined;
let logins: Map<string, AccountRecord>;
let createdGuests: string[];
let promoted: number[];
let promoteFails: Error | undefined;
let issued: Record<string, unknown>[];
let enqueued: Record<string, unknown>[];
let started: Record<string, unknown>[];
let voided: unknown[][];
let claims: AccountRecord[];
let claimAnswer: { claimedOrders: number; skipped?: 'busy' };
let link: Record<string, unknown> | undefined;
let sessionOfCookie: Record<string, unknown> | undefined;
let revoked: number[];
let budgetOpen: boolean;
let mailPoints: string[];
let limiterError: Error | undefined;
let guardError: Error | undefined;

const db = {
  db: { name: 'pool' },
  runOrDiscard: async (fn: (w: typeof work) => Promise<boolean>) => {
    const keep = await fn(work);
    calls.push(keep ? 'commit' : 'discard');
    return keep;
  },
  runInTransaction: async <T>(fn: (w: typeof work) => Promise<T>) => {
    try {
      const result = await fn(work);
      calls.push('commit');
      return result;
    } catch (error) {
      calls.push('rollback');
      throw error;
    }
  },
};
const directory = {
  findLoginByEmail: (_db: unknown, email: string) => Promise.resolve(logins.get(email)),
  findOrCreateGuest: (_tx: unknown, input: { email: string }) => {
    createdGuests.push(input.email);
    const guest = account(900 + createdGuests.length, { email: input.email, hasAccount: false });
    accounts.set(guest.id, guest);
    return Promise.resolve({ account: guest, created: true });
  },
  lockForKeyShare: (_tx: unknown, id: number) => Promise.resolve(accounts.get(id)),
  lockForUpdate: (_tx: unknown, id: number) => Promise.resolve(lockedAs ?? accounts.get(id)),
  findById: (_db: unknown, id: number) => Promise.resolve(accounts.get(id)),
};
const tokens = {
  issue: (_work: unknown, input: Record<string, unknown>) => {
    calls.push('issue');
    issued.push(input);
    return Promise.resolve({
      tokenId: 50 + issued.length,
      token: 'placeholder',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
  },
  findById: () => Promise.resolve(link),
  consume: () => {
    calls.push('consume');
    return Promise.resolve(consumed);
  },
  askedFrom: (record: { browserHash: string | null }, browserKey: string | undefined) =>
    record.browserHash !== null &&
    browserKey !== undefined &&
    tokenService.equals(record.browserHash, tokenService.hash(browserKey)),
  voidOpenOf: (...args: unknown[]) => {
    calls.push('void');
    voided.push(args.slice(1));
    return Promise.resolve(1);
  },
};
const mail = {
  enqueue: (_work: unknown, input: Record<string, unknown>) => {
    calls.push('enqueue');
    enqueued.push(input);
    return Promise.resolve();
  },
};
const sessions = {
  start: (_work: unknown, _reply: unknown, input: Record<string, unknown>) => {
    calls.push('session');
    started.push(input);
    return Promise.resolve({ expiresAt: NOW });
  },
};
const sessionStore = {
  lookup: () => Promise.resolve(sessionOfCookie),
  revoke: (id: number) => {
    revoked.push(id);
    return Promise.resolve(true);
  },
};
const cookies = { readToken: () => (sessionOfCookie === undefined ? undefined : 'session-cookie-token') };
const guards = new AccountCreateGuards();
const claimService = {
  claim: (_tx: unknown, given: AccountRecord) => {
    calls.push('claim');
    claims.push(given);
    return Promise.resolve(claimAnswer);
  },
};
const limiter = {
  enforceMagicLink: () => {
    calls.push('limiter');
    return limiterError ? Promise.reject(limiterError) : Promise.resolve();
  },
};
const limits = {
  consume: (_name: string, key: string) => {
    calls.push('mail point');
    mailPoints.push(key);
    return Promise.resolve({ allowed: budgetOpen });
  },
};

const service = () =>
  new AccountLinkSignInService(
    db as never,
    tokenService,
    directory as never,
    tokens as never,
    mail,
    sessions as never,
    sessionStore as never,
    cookies as never,
    guards,
    claimService as never,
    limiter as never,
    limits as never,
    clock,
  );

const request = {} as FastifyRequest;
const reply = {} as FastifyReply;

/** A stored sign-in link, usable for an hour unless changed. */
function aLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    subjectType: 'account',
    subjectId: 5,
    purpose: 'magic_link',
    usedAt: null,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    browserHash: null,
    ...overrides,
  };
}

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error as AppError,
  );

afterEach(() => mock.restore());

beforeEach(() => {
  // The repository functions are the only database the service calls directly; each spy is undone by `mock.restore`.
  spyOn(clientAdminRepository, 'updateClientRow').mockImplementation((_tx: unknown, id: number) => {
    if (promoteFails) return Promise.reject(promoteFails);
    promoted.push(id);
    return Promise.resolve(undefined);
  });
  spyOn(accountRepository, 'findClientById').mockImplementation(() =>
    Promise.resolve({ twofaEnabled: twofa } as Client),
  );
  spyOn(accountRepository, 'markClientEmailVerified').mockImplementation(() => {
    calls.push('verified');
    return Promise.resolve();
  });
  spyOn(accountRepository, 'recordClientSignIn').mockImplementation(() => {
    calls.push('signed in');
    return Promise.resolve();
  });
  spyOn(requestMeta, 'requestMetaOf').mockReturnValue(meta);
  calls.length = 0;
  consumed = true;
  twofa = false;
  accounts = new Map();
  lockedAs = undefined;
  logins = new Map();
  createdGuests = [];
  promoted = [];
  promoteFails = undefined;
  issued = [];
  enqueued = [];
  started = [];
  voided = [];
  claims = [];
  claimAnswer = { claimedOrders: 0 };
  link = undefined;
  sessionOfCookie = undefined;
  revoked = [];
  budgetOpen = true;
  mailPoints = [];
  limiterError = undefined;
  guardError = undefined;
  // a fresh registry per test: the blocklist stand-in refuses what guardError says
  (guards as unknown as { checks: Map<string, unknown> }).checks.clear();
  guards.register('stand-in', () => (guardError ? Promise.reject(guardError) : Promise.resolve()));
});

describe('AccountLinkSignInService.requestLink', () => {
  it('makes a guest row for an unknown email, mails it a link and keeps the work', async () => {
    const answer = await service().requestLink('new@example.com', meta);
    expect(createdGuests).toEqual(['new@example.com']);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ accountId: 901, purpose: 'magic_link', keepEarlier: true, ip: '203.0.113.9' });
    expect(enqueued).toEqual([{ kind: 'magic_link', accountId: 901, tokenId: 51 }]);
    expect(calls.at(-1)).toBe('commit');
    expect(answer.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    // the link carries the keyed hash of the cookie's value, never the value itself is stored by this service
    expect(issued[0]!.browserKey).toBe(answer.browserKey);
  });

  it('finds the login row of a retail account first and creates no guest row', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    await service().requestLink('buyer@example.com', meta);
    expect(createdGuests).toEqual([]);
    expect(enqueued).toEqual([{ kind: 'magic_link', accountId: 5, tokenId: 51 }]);
    expect(calls.at(-1)).toBe('commit');
  });

  it('keeps the asking-browser cookie it made and replaces one of the wrong shape', async () => {
    expect((await service().requestLink('a@example.com', meta, BROWSER_KEY)).browserKey).toBe(BROWSER_KEY);
    expect((await service().requestLink('a@example.com', meta, 'short')).browserKey).not.toBe('short');
  });

  it.each([
    ['a merchant rank', { rankKind: 'merchant' as const }],
    ['a suspended account', { status: 'suspended' as const }],
    ['a blocked account', { status: 'blocked' as const }],
    ['an anonymized account', { status: 'anonymized' as const }],
  ])(
    'is silent for %s: the same statements run for an id no account has and are rolled back',
    async (_name, overrides) => {
      const holder = account(5, { email: 'holder@example.com', ...overrides });
      accounts.set(5, holder);
      logins.set('holder@example.com', holder);
      const answer = await service().requestLink('holder@example.com', meta);
      expect(issued[0]!.accountId).toBe(Number.MAX_SAFE_INTEGER);
      expect(enqueued[0]!.accountId).toBe(Number.MAX_SAFE_INTEGER);
      expect(calls.at(-1)).toBe('discard');
      // the answer and the cookie are the same as for any other email
      expect(answer.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    },
  );

  it('runs the same statements, in the same order, for every email', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    const merchant = account(6, { email: 'merchant@example.com', rankKind: 'merchant' });
    accounts.set(6, merchant);
    logins.set('merchant@example.com', merchant);
    const sequences: string[][] = [];
    for (const email of ['buyer@example.com', 'merchant@example.com', 'nobody@example.com']) {
      calls.length = 0;
      await service().requestLink(email, meta);
      sequences.push(calls.filter((call) => call !== 'commit' && call !== 'discard'));
    }
    expect(sequences[1]).toEqual(sequences[0]);
    expect(sequences[2]).toEqual(sequences[0]);
    expect(sequences[0]).toEqual(['limiter', 'mail point', 'issue', 'enqueue']);
  });

  it('is silent for an email the create checks refuse (the blocklist), whether or not it has an account', async () => {
    guardError = new AppError('VALIDATION_FAILED');
    const holder = account(5, { email: 'blocked@example.com' });
    accounts.set(5, holder);
    logins.set('blocked@example.com', holder);
    await service().requestLink('blocked@example.com', meta);
    await service().requestLink('unknown-blocked@example.com', meta);
    expect(issued.map((input) => input.accountId)).toEqual([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    expect(calls.filter((call) => call === 'discard')).toHaveLength(2);
  });

  it('does not hide a failure of a create check that is not a refusal', async () => {
    guardError = new Error('database down');
    expect((await refusal(service().requestLink('a@example.com', meta)))?.message).toBe('database down');
  });

  it("sends nothing once the recipient's mail budget is used up, and still answers as usual", async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    budgetOpen = false;
    const answer = await service().requestLink('buyer@example.com', meta);
    expect(issued[0]!.accountId).toBe(Number.MAX_SAFE_INTEGER);
    expect(calls.at(-1)).toBe('discard');
    expect(answer.browserKey).toHaveLength(43);
  });

  it('spends one mail point for every request, on the key of the account or of "no account"', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    await service().requestLink('buyer@example.com', meta);
    await service().requestLink('nobody@example.com', meta);
    await service().requestLink('buyer@example.com', meta);
    expect(mailPoints).toHaveLength(3);
    expect(mailPoints[0]).toBe(mailPoints[2]);
    // the second request is for a guest row it just made: that is an account too, with a key of its own
    expect(mailPoints[1]).not.toBe(mailPoints[0]!);
  });

  it('counts the request first: a refusal of the limiter does no database work', async () => {
    limiterError = new AppError('RATE_LIMITED');
    expect((await refusal(service().requestLink('a@example.com', meta)))?.code).toBe('RATE_LIMITED');
    expect(calls).toEqual(['limiter']);
  });
});

describe('AccountLinkSignInService.exchange', () => {
  const input = { linkId: 11, claimGuestOrders: false };

  /** A retail login with a usable sign-in link in the store. */
  function given(overrides: Partial<AccountRecord> = {}, linkOverrides: Record<string, unknown> = {}) {
    const buyer = account(5, { email: 'buyer@example.com', ...overrides });
    accounts.set(5, buyer);
    link = aLink(linkOverrides);
    return buyer;
  }

  it('opens the session, stamps the mailbox, voids the other sign-in links and answers the account', async () => {
    given();
    const answer = await service().exchange(input, request, reply);
    expect(answer).toEqual({
      accountId: 5,
      next: 'done',
      requestedHere: false,
      maskedEmail: 'bu•••@example.com',
      claimedOrders: 0,
    });
    expect(started).toEqual([{ accountId: 5, stage: 'active', rankKind: 'retail' }]);
    expect(voided).toEqual([[5, ['magic_link', 'verify_email']]]);
    expect(calls).toEqual(['consume', 'void', 'verified', 'signed in', 'session', 'commit']);
    expect(promoted).toEqual([]);
  });

  it('says the browser that asked for the link asked for it', async () => {
    given({}, { browserHash: tokenService.hash(BROWSER_KEY) });
    expect((await service().exchange({ ...input, browserKey: BROWSER_KEY }, request, reply)).requestedHere).toBe(true);
    expect((await service().exchange({ ...input, browserKey: 'B'.repeat(43) }, request, reply)).requestedHere).toBe(
      false,
    );
    expect((await service().exchange(input, request, reply)).requestedHere).toBe(false);
  });

  it('asks for the code step first when two-step sign-in is on', async () => {
    given();
    twofa = true;
    const answer = await service().exchange(input, request, reply);
    expect(answer.next).toBe('totp');
    expect(started[0]!.stage).toBe('pending_totp');
  });

  it.each([
    ['no such link', () => given(), () => (link = undefined)],
    ['a used link', () => given({}, { usedAt: new Date(NOW.getTime() - 1) }), () => undefined],
    ['an expired link', () => given({}, { expiresAt: new Date(NOW.getTime() - 1) }), () => undefined],
    ['a password link', () => given({}, { purpose: 'reset' }), () => undefined],
    ['an account raised to a merchant rank since the mail', () => given({ rankKind: 'merchant' }), () => undefined],
    ['a suspended account', () => given({ status: 'suspended' }), () => undefined],
    ['a blocked account', () => given({ status: 'blocked' }), () => undefined],
    ['an anonymized account', () => given({ status: 'anonymized' }), () => undefined],
    [
      'a verification link of a guest row',
      () => given({ hasAccount: false }, { purpose: 'verify_email' }),
      () => undefined,
    ],
  ])('answers 410 TOKEN_INVALID for %s, and writes nothing', async (_name, setUp, after) => {
    setUp();
    after();
    const error = await refusal(service().exchange(input, request, reply));
    expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
    expect(started).toEqual([]);
    expect(calls).not.toContain('session');
    expect(calls).not.toContain('consume');
  });

  it('answers 410 when a parallel request used the link first, and opens no session', async () => {
    given();
    consumed = false;
    expect((await refusal(service().exchange(input, request, reply)))?.code).toBe('TOKEN_INVALID');
    expect(calls).toEqual(['consume', 'rollback']);
    expect(started).toEqual([]);
  });

  it('answers 410 when the account changed under the lock: a rank raised or a status changed between the read and the lock', async () => {
    given();
    // the first read sees the retail account; the lock sees the merchant rank
    lockedAs = account(5, { rankKind: 'merchant' });
    expect((await refusal(service().exchange(input, request, reply)))?.code).toBe('TOKEN_INVALID');
    lockedAs = account(5, { status: 'suspended' });
    expect((await refusal(service().exchange(input, request, reply)))?.code).toBe('TOKEN_INVALID');
    expect(started).toEqual([]);
    expect(calls).not.toContain('consume');
  });

  it('makes an account of a guest row, and offers it no claim even when asked', async () => {
    given({ hasAccount: false });
    const answer = await service().exchange({ ...input, claimGuestOrders: true }, request, reply);
    expect(promoted).toEqual([5]);
    expect(claims).toEqual([]);
    expect(answer).toMatchObject({ accountId: 5, claimedOrders: 0 });
    expect(calls.indexOf('void')).toBeLessThan(calls.indexOf('session'));
  });

  it('answers 410 and changes nothing when the email gained another login row since the mail (clients_login_email_uq)', async () => {
    given({ hasAccount: false });
    promoteFails = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'clients_login_email_uq',
    });
    const error = await refusal(service().exchange(input, request, reply));
    expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
    // the whole transaction rolls back: the link is not used up and no session opened
    expect(calls.at(-1)).toBe('rollback');
    expect(started).toEqual([]);
    expect(calls).not.toContain('verified');
  });

  it('does not turn another unique violation into a 410', async () => {
    given({ hasAccount: false });
    promoteFails = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'something_else_uq' });
    expect((await refusal(service().exchange(input, request, reply)))?.message).toBe('duplicate key');
  });

  it('claims the guest orders for a login that asked for it, and tells how many moved', async () => {
    const buyer = given();
    claimAnswer = { claimedOrders: 3 };
    const answer = await service().exchange({ ...input, claimGuestOrders: true }, request, reply);
    expect(claims).toEqual([buyer]);
    expect(answer.claimedOrders).toBe(3);
    expect(answer.claimSkipped).toBeUndefined();
    // the claim runs after the session opened: a busy claim never stops the sign-in
    expect(calls.indexOf('claim')).toBeGreaterThan(calls.indexOf('session'));
  });

  it('does not claim without the box', async () => {
    given();
    await service().exchange({ ...input, claimGuestOrders: false }, request, reply);
    expect(claims).toEqual([]);
  });

  it('signs in and says busy when the claim gave up', async () => {
    given();
    claimAnswer = { claimedOrders: 0, skipped: 'busy' };
    const answer = await service().exchange({ ...input, claimGuestOrders: true }, request, reply);
    expect(answer).toMatchObject({ next: 'done', claimedOrders: 0, claimSkipped: 'busy' });
    expect(calls.at(-1)).toBe('commit');
    expect(started).toHaveLength(1);
  });

  it('refuses the verification link of a retail login (410): only the verification route answers it (decision 052)', async () => {
    given({}, { purpose: 'verify_email' });
    expect(await refusal(service().exchange(input, request, reply))).toMatchObject({ code: 'TOKEN_INVALID' });
    expect(started).toEqual([]);
    expect(calls).not.toContain('consume');
  });

  describe('the browser holds a session', () => {
    const liveSession = (subjectId: number) => ({
      id: 70,
      subjectType: 'account',
      subjectId,
      expiresAtMs: NOW.getTime() + 600_000,
      lastSeenAtMs: NOW.getTime(),
      idleMs: 0,
    });

    it('refuses a link asked for elsewhere while the browser holds a live session of another account (409), and spends nothing', async () => {
      given();
      sessionOfCookie = liveSession(9);
      const error = await refusal(service().exchange(input, request, reply));
      expect(error).toMatchObject({
        code: 'CONFLICT',
        detail: 'This browser is signed in to another account. Sign out first, then open the link again.',
      });
      expect(calls).toEqual([]);
      expect(revoked).toEqual([]);
    });

    it("lets the browser that asked sign in over another account's session, and ends the old one with the exchange", async () => {
      given({}, { browserHash: tokenService.hash(BROWSER_KEY) });
      sessionOfCookie = liveSession(9);
      const answer = await service().exchange({ ...input, browserKey: BROWSER_KEY }, request, reply);
      expect(answer.requestedHere).toBe(true);
      expect(revoked).toEqual([70]);
    });

    it("treats an ended session as none, and ends the account's own old session when signing in again", async () => {
      given();
      sessionOfCookie = { ...liveSession(9), expiresAtMs: NOW.getTime() - 1 };
      expect((await service().exchange(input, request, reply)).accountId).toBe(5);
      sessionOfCookie = liveSession(5);
      await service().exchange(input, request, reply);
      expect(revoked).toEqual([70, 70]);
    });
  });
});
