// Unit tests of the sign-in link of the retail rank (decisions 064 and 079): who gets a link and who the note (to the typed address, with
// no row made), that every email runs the same statements, the sign-up (the policy, the country, the hash before the lookup, the details
// beside the link of an address without a login, the two mails, the weakest lock), the rules of the exchange (rank, status, the other
// browser, the guest row that becomes an account, the form of a sign-up applied only in its own browser and pending elsewhere, every
// waiting form of the address deleted, the claim, two-step) and the finish of a sign-up. The database, the token store and the session core are fakes; the integration tests run the
// same cases through HTTP.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import { parseEnv } from '@src/config';
import { TokenService } from '@src/infra/crypto';
import type { AccountRecord } from '@src/modules/identity/accounts/account-directory';
import { AccountLinkSignInService } from '@src/modules/identity/application/account-link-sign-in.service';
import * as requestMeta from '@src/modules/identity/application/request-meta';
import type { Client } from '@src/modules/identity/db/schema';
import * as signUpRepository from '@src/modules/identity/infra/account-signup.repository';
import * as clientAdminRepository from '@src/modules/identity/infra/client-admin.repository';
import * as codeFailuresRepository from '@src/modules/identity/infra/code-failures.repository';
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
const work = {
  tx,
  afterCommit: (fn: () => unknown) => {
    afterCommits.push(fn);
  },
};
let accounts: Map<number, AccountRecord>;
/** What the row lock reads when it differs from the first read (the account changed in between). */
let lockedAs: AccountRecord | undefined;
let logins: Map<string, AccountRecord>;
let createdGuests: string[];
let guests: Map<string, AccountRecord>;
let locks: string[];
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
let notes: string[];
let detailWrites: Record<string, unknown>[];
let waiting: Record<string, unknown> | undefined;
let waitingStored: { tokenId: number; details: object }[];
let discardedFor: number[];
let passwordsSaved: object[];
let allRevoked: unknown[][];
let afterCommits: (() => unknown)[];
let locksCleared: string[];
let taxCountries: string[];
let sessionOpenedAt: Date | undefined;
let noticesSent: Record<string, unknown>[];

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
  findLoginByEmail: (_db: unknown, email: string) => {
    calls.push('lookup');
    return Promise.resolve(logins.get(email));
  },
  findGuestByEmail: (_db: unknown, email: string) => {
    calls.push('guest lookup');
    return Promise.resolve(guests.get(email));
  },
  findOrCreateGuest: (_tx: unknown, input: { email: string }) => {
    createdGuests.push(input.email);
    const guest = account(900 + createdGuests.length, { email: input.email, hasAccount: false });
    accounts.set(guest.id, guest);
    return Promise.resolve({ account: guest, created: true });
  },
  lockForKeyShare: (_tx: unknown, id: number) => {
    locks.push(`key share ${id}`);
    return Promise.resolve(accounts.get(id));
  },
  lockForUpdate: (_tx: unknown, id: number) => {
    locks.push(`update ${id}`);
    return Promise.resolve(lockedAs ?? accounts.get(id));
  },
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
  revokeAllOf: (...args: unknown[]) => {
    calls.push('revoke all');
    allRevoked.push(args.slice(0, 3));
    return Promise.resolve(0);
  },
  openedAt: () => {
    calls.push('session age');
    return Promise.resolve(sessionOpenedAt);
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
  enforceSignUpFinish: () => {
    calls.push('finish limiter');
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

const hasher = {
  hash: (password: string) => {
    calls.push('hash');
    return Promise.resolve(`argon2id(${password})`);
  },
};
const money = {
  taxRatesInForce: () => Promise.resolve(taxCountries.map((country) => ({ country }))),
  offered: (_db: unknown, code: string) => Promise.resolve(code === 'GBP' ? { code } : undefined),
  byCode: (_db: unknown, code: string) => Promise.resolve({ code }),
};
const signInLock = {
  clear: (_scope: string, email: string) => {
    locksCleared.push(email);
    return Promise.resolve();
  },
};
const note = {
  enqueue: (_work: unknown, email: string) => {
    calls.push('note');
    notes.push(email);
    return Promise.resolve();
  },
};
const notices = {
  passwordSet: (_work: unknown, recipient: Record<string, unknown>) => {
    calls.push('notice');
    noticesSent.push({ ...recipient });
    return Promise.resolve();
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
    hasher as never,
    money,
    signInLock as never,
    note as never,
    notices as never,
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
  spyOn(clientAdminRepository, 'updateClientRow').mockImplementation(
    (_tx: unknown, id: number, changes: Record<string, unknown>) => {
      if (promoteFails) return Promise.reject(promoteFails);
      if (changes['hasAccount'] === true) promoted.push(id);
      else detailWrites.push({ id, ...changes });
      return Promise.resolve(undefined);
    },
  );
  spyOn(signUpRepository, 'takeWaitingSignUp').mockImplementation(() => {
    calls.push('take details');
    const taken = waiting;
    waiting = undefined;
    return Promise.resolve(taken as never);
  });
  spyOn(signUpRepository, 'discardWaitingSignUps').mockImplementation((_tx: unknown, accountId: number) => {
    calls.push('discard details');
    discardedFor.push(accountId);
    return Promise.resolve(0);
  });
  spyOn(signUpRepository, 'insertWaitingSignUp').mockImplementation(
    (_tx: unknown, tokenId: number, details: object) => {
      calls.push('store details');
      waitingStored.push({ tokenId, details });
      return Promise.resolve();
    },
  );
  spyOn(accountRepository, 'saveClientPassword').mockImplementation((_tx: unknown, input: object) => {
    calls.push('password');
    passwordsSaved.push(input);
    return Promise.resolve(true);
  });
  spyOn(codeFailuresRepository, 'clearCodeFailures').mockImplementation(() => Promise.resolve());
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
  guests = new Map();
  locks = [];
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
  notes = [];
  detailWrites = [];
  waiting = undefined;
  waitingStored = [];
  discardedFor = [];
  passwordsSaved = [];
  allRevoked = [];
  afterCommits = [];
  locksCleared = [];
  taxCountries = ['GB', 'JO'];
  sessionOpenedAt = new Date(NOW.getTime() - 5 * 60_000);
  noticesSent = [];
  // a fresh registry per test: the blocklist stand-in refuses what guardError says
  (guards as unknown as { checks: Map<string, unknown> }).checks.clear();
  guards.register('stand-in', () => (guardError ? Promise.reject(guardError) : Promise.resolve()));
});

describe('AccountLinkSignInService.requestLink', () => {
  it('mails the note with the sign-up page to an unknown email, issues no link (decision 079) and keeps the work', async () => {
    const answer = await service().requestLink('new@example.com', meta);
    // the note goes to the typed address: no guest row is made for it (the review of decision 079), and no row is locked
    expect(createdGuests).toEqual([]);
    expect(notes).toEqual(['new@example.com']);
    expect(locks).toEqual([]);
    expect(issued).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(calls.at(-1)).toBe('commit');
    expect(answer.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the cookie lives as long as a link would, as for every other email
    expect(answer.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('mails the note, not a link, to an email that only a guest row holds', async () => {
    const guest = account(7, { email: 'guest@example.com', hasAccount: false });
    accounts.set(7, guest);
    guests.set('guest@example.com', guest);
    const answer = await service().requestLink('guest@example.com', meta);
    expect(notes).toEqual(['guest@example.com']);
    expect(createdGuests).toEqual([]);
    expect(issued).toEqual([]);
    expect(calls.at(-1)).toBe('commit');
    expect(answer.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('is silent for an address whose guest row is blocked: the note is written and rolled back', async () => {
    guests.set(
      'blocked@example.com',
      account(7, { email: 'blocked@example.com', hasAccount: false, status: 'blocked' }),
    );
    await service().requestLink('blocked@example.com', meta);
    expect(notes).toEqual(['blocked@example.com']);
    expect(calls.at(-1)).toBe('discard');
  });

  it('takes only KEY SHARE on a login row, never FOR UPDATE (the review of decision 079, S2)', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    await service().requestLink('buyer@example.com', meta);
    expect(locks).toEqual(['key share 5']);
  });

  it('mails a link to a retail login, with the asking browser on it', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    const answer = await service().requestLink('buyer@example.com', meta);
    expect(issued[0]).toMatchObject({ accountId: 5, purpose: 'magic_link', keepEarlier: true, ip: '203.0.113.9' });
    expect(answer.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    // the link carries the keyed hash of the cookie's value, never the value itself is stored by this service
    expect(issued[0]!.browserKey).toBe(answer.browserKey);
    expect(notes).toEqual([]);
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

  it('runs the same statements, in the same order, for every login row, and for every address without one', async () => {
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    const merchant = account(6, { email: 'merchant@example.com', rankKind: 'merchant' });
    accounts.set(6, merchant);
    logins.set('merchant@example.com', merchant);
    const sequences: string[][] = [];
    guardError = undefined;
    for (const email of ['buyer@example.com', 'merchant@example.com', 'nobody@example.com', 'other@example.com']) {
      calls.length = 0;
      if (email === 'other@example.com') guardError = new AppError('VALIDATION_FAILED');
      await service().requestLink(email, meta);
      sequences.push(calls.filter((call) => call !== 'commit' && call !== 'discard'));
    }
    expect(sequences[1]).toEqual(sequences[0]);
    expect(sequences[0]).toEqual(['limiter', 'lookup', 'mail point', 'issue', 'enqueue']);
    // the note to an address without a login, kept or (a blocked email) rolled back
    expect(sequences[3]).toEqual(sequences[2]);
    expect(sequences[2]).toEqual(['limiter', 'lookup', 'guest lookup', 'mail point', 'note']);
  });

  it('is silent for an email the create checks refuse (the blocklist), whether or not it has an account', async () => {
    guardError = new AppError('VALIDATION_FAILED');
    const holder = account(5, { email: 'blocked@example.com' });
    accounts.set(5, holder);
    logins.set('blocked@example.com', holder);
    await service().requestLink('blocked@example.com', meta);
    await service().requestLink('unknown-blocked@example.com', meta);
    expect(issued.map((input) => input.accountId)).toEqual([Number.MAX_SAFE_INTEGER]);
    // the note of the unknown address is written in the run that is rolled back
    expect(notes).toEqual(['unknown-blocked@example.com']);
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
    // the second request is for an address without an account: its own budget, keyed by the address
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
    expect(calls).toEqual([
      'consume',
      'void',
      'take details',
      'discard details',
      'verified',
      'signed in',
      'session',
      'commit',
    ]);
    // every waiting form of the address goes with the exchange, the forms of the links it voided included (the review's B2 and S5)
    expect(discardedFor).toEqual([5]);
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

  describe('a link that carries the details of a sign-up (decision 079)', () => {
    const DETAILS = {
      id: 3,
      authTokenId: 11,
      passwordHash: 'argon2id(hash)',
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'GB',
      phone: '+447700900123',
    };

    it('makes the account with the details and the password in the browser that sent the form', async () => {
      given({ hasAccount: false, email: 'new@example.com' }, { browserHash: tokenService.hash(BROWSER_KEY) });
      waiting = { ...DETAILS };
      const answer = await service().exchange({ ...input, browserKey: BROWSER_KEY }, request, reply);
      expect(answer).toMatchObject({ requestedHere: true, passwordSet: true });
      expect('pendingDetails' in answer).toBe(false);
      expect(promoted).toEqual([5]);
      expect(detailWrites).toEqual([
        expect.objectContaining({
          id: 5,
          name: 'Daniel Whitmore',
          country: 'GB',
          phone: '+447700900123',
          currency: 'GBP',
        }),
      ]);
      expect(passwordsSaved).toEqual([
        expect.objectContaining({ id: 5, passwordHash: 'argon2id(hash)', fromMailedLink: true, verifyEmail: false }),
      ]);
      // the invitation and reset links go, the other sessions end before this one opens, and the shop lock ends after the commit
      expect(voided).toContainEqual([5, ['invite', 'reset']]);
      expect(calls.indexOf('revoke all')).toBeLessThan(calls.indexOf('session'));
      expect(allRevoked).toEqual([['account', 5, {}]]);
      for (const fn of afterCommits) await fn();
      expect(locksCleared).toEqual(['new@example.com']);
      // the details are taken (read and deleted) in the transaction of the exchange, after the link was used up, and every other form
      // of the address goes too
      expect(calls.indexOf('take details')).toBeGreaterThan(calls.indexOf('consume'));
      expect(discardedFor).toEqual([5]);
      expect(calls.at(-1)).toBe('commit');
    });

    it.each([
      ['no asking-browser cookie', undefined],
      ['its own valid cookie of another request', 'B'.repeat(43)],
      ['a forged cookie of the right shape', 'A'.repeat(42) + 'B'],
    ])(
      'applies nothing in another browser (%s): no name, country, phone or password, and shows the details to confirm',
      async (_name, browserKey) => {
        given({ hasAccount: false }, { browserHash: tokenService.hash(BROWSER_KEY) });
        waiting = { ...DETAILS };
        const answer = await service().exchange(
          { ...input, ...(browserKey === undefined ? {} : { browserKey }) },
          request,
          reply,
        );
        expect(answer).toMatchObject({ requestedHere: false, passwordSet: false });
        expect(answer.pendingDetails).toEqual({
          firstName: 'Daniel',
          lastName: 'Whitmore',
          country: 'GB',
          phone: '+447700900123',
        });
        expect(JSON.stringify(answer)).not.toContain('argon2id');
        // the account is made and signed in, with nothing of the form
        expect(promoted).toEqual([5]);
        expect(detailWrites).toEqual([]);
        expect(passwordsSaved).toEqual([]);
        expect(allRevoked).toEqual([]);
        expect(started).toHaveLength(1);
        // the waiting hash is gone with the exchange
        expect(waiting).toBeUndefined();
        expect(discardedFor).toEqual([5]);
      },
    );

    it('is a plain sign-in for an account that already had its login: nothing applied, neither key in the answer', async () => {
      given({}, { browserHash: tokenService.hash(BROWSER_KEY) });
      waiting = { ...DETAILS };
      const answer = await service().exchange({ ...input, browserKey: BROWSER_KEY }, request, reply);
      expect('passwordSet' in answer).toBe(false);
      expect('pendingDetails' in answer).toBe(false);
      expect(detailWrites).toEqual([]);
      expect(passwordsSaved).toEqual([]);
      expect(promoted).toEqual([]);
      expect(calls).toContain('take details');
      expect(discardedFor).toEqual([5]);
    });

    it('says nothing of a password for a link without details', async () => {
      given({ hasAccount: false });
      const answer = await service().exchange(input, request, reply);
      expect('passwordSet' in answer).toBe(false);
      expect('pendingDetails' in answer).toBe(false);
      expect(detailWrites).toEqual([]);
      expect(promoted).toEqual([5]);
    });

    it('rolls everything back when the password cannot be written (the account may not act at the write)', async () => {
      given({ hasAccount: false }, { browserHash: tokenService.hash(BROWSER_KEY) });
      waiting = { ...DETAILS };
      spyOn(accountRepository, 'saveClientPassword').mockImplementation(() => Promise.resolve(false));
      const error = await refusal(service().exchange({ ...input, browserKey: BROWSER_KEY }, request, reply));
      expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
      expect(calls.at(-1)).toBe('rollback');
      expect(started).toEqual([]);
    });
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

describe('AccountLinkSignInService.signUp', () => {
  const form = {
    email: 'new@example.com',
    password: 'Xk7mQ2wPzR9tNx',
    firstName: 'Daniel',
    lastName: 'Whitmore',
    country: 'GB',
    phone: '+447700900123',
  };

  it('refuses a weak password on its field before any other work', async () => {
    const error = await refusal(service().signUp({ ...form, password: 'short' }, meta));
    expect(error).toMatchObject({ code: 'WEAK_PASSWORD', errors: [{ field: 'password', code: 'WEAK_PASSWORD' }] });
    expect(calls).toEqual([]);
  });

  it('refuses a password that holds a name of the form', async () => {
    const error = await refusal(service().signUp({ ...form, password: 'whitmore-2026-xyz' }, meta));
    expect(error?.errors?.[0]).toMatchObject({ field: 'password', message: 'Do not use your name in your password.' });
  });

  it('refuses a country the shop does not sell to, before the budget and the hash', async () => {
    const error = await refusal(service().signUp({ ...form, country: 'FR' }, meta));
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'country', code: 'unsupported' }] });
    expect(calls).toEqual([]);
  });

  it('hashes the password before the address is looked up, and keeps the details beside the link of a new guest row', async () => {
    const answer = await service().signUp(form, meta, BROWSER_KEY);
    expect(calls.indexOf('hash')).toBeLessThan(calls.indexOf('lookup'));
    expect(createdGuests).toEqual(['new@example.com']);
    expect(issued[0]).toMatchObject({
      accountId: 901,
      purpose: 'magic_link',
      keepEarlier: true,
      browserKey: BROWSER_KEY,
    });
    // the mail "finish creating your account" (the review's S3)
    expect(enqueued).toEqual([{ kind: 'sign_up_link', accountId: 901, tokenId: 51 }]);
    // an older sign-up keeps its own form beside its own link (the review's B2)
    expect(discardedFor).toEqual([]);
    // the weakest lock that is enough, never FOR UPDATE (the review's S2)
    expect(locks).toEqual(['key share 901']);
    expect(waitingStored).toEqual([
      {
        tokenId: 51,
        details: {
          passwordHash: 'argon2id(Xk7mQ2wPzR9tNx)',
          firstName: 'Daniel',
          lastName: 'Whitmore',
          country: 'GB',
          phone: '+447700900123',
        },
      },
    ]);
    expect(JSON.stringify(waitingStored)).not.toContain('"Xk7mQ2wPzR9tNx"');
    expect(answer).toEqual({ browserKey: BROWSER_KEY, expiresAt: new Date(NOW.getTime() + 3_600_000) });
    expect(calls.at(-1)).toBe('commit');
  });

  it('gives an address with a login account its ordinary link and keeps nothing of the form', async () => {
    const buyer = account(5, { email: 'new@example.com' });
    accounts.set(5, buyer);
    logins.set('new@example.com', buyer);
    await service().signUp(form, meta);
    expect(calls.indexOf('hash')).toBeLessThan(calls.indexOf('lookup'));
    expect(createdGuests).toEqual([]);
    // its ordinary sign-in link, in the mail "you already have an account, nothing was changed" (the review's S3)
    expect(enqueued).toEqual([{ kind: 'sign_up_existing', accountId: 5, tokenId: 51 }]);
    expect(waitingStored).toEqual([]);
    expect(discardedFor).toEqual([]);
    expect(locks).toEqual(['key share 5']);
    expect(calls.at(-1)).toBe('commit');
  });

  it.each([
    ['a merchant rank', { rankKind: 'merchant' as const }],
    ['a suspended account', { status: 'suspended' as const }],
  ])('is silent for %s, with the hash made all the same', async (_name, overrides) => {
    const holder = account(5, { email: 'new@example.com', ...overrides });
    accounts.set(5, holder);
    logins.set('new@example.com', holder);
    await service().signUp(form, meta);
    expect(calls).toContain('hash');
    expect(issued[0]!.accountId).toBe(Number.MAX_SAFE_INTEGER);
    expect(calls.at(-1)).toBe('discard');
  });

  it('runs the same statements for a new address and one whose mail budget is used up, and rolls the second back', async () => {
    const runs: string[][] = [];
    for (const open of [true, false]) {
      calls.length = 0;
      budgetOpen = open;
      await service().signUp(form, meta);
      runs.push(calls.slice(0, -1));
      expect(calls.at(-1)).toBe(open ? 'commit' : 'discard');
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[0]).toEqual(['limiter', 'hash', 'lookup', 'mail point', 'issue', 'enqueue', 'store details']);
  });

  it('keeps each sign-up beside its own link: a second one stores a second form and deletes nothing (the review, B2)', async () => {
    await service().signUp(form, meta);
    await service().signUp({ ...form, lastName: 'Second' }, meta);
    expect(waitingStored.map((row) => row.tokenId)).toEqual([51, 52]);
    expect(waitingStored.map((row) => (row.details as { lastName: string }).lastName)).toEqual(['Whitmore', 'Second']);
    expect(discardedFor).toEqual([]);
  });

  it('spends the point of an address without a login on the key of its note: one budget for its notes and links (the re-review)', async () => {
    await service().requestLink('new@example.com', meta);
    await service().signUp(form, meta);
    expect(notes).toEqual(['new@example.com']);
    expect(waitingStored).toHaveLength(1);
    expect(mailPoints).toHaveLength(2);
    expect(mailPoints[1]).toBe(mailPoints[0]);
    // A login account keeps its own budget, the one of its sign-in link.
    const buyer = account(5, { email: 'buyer@example.com' });
    accounts.set(5, buyer);
    logins.set('buyer@example.com', buyer);
    await service().requestLink('buyer@example.com', meta);
    await service().signUp({ ...form, email: 'buyer@example.com' }, meta);
    expect(mailPoints[3]).toBe(mailPoints[2]);
    expect(mailPoints[2]).not.toBe(mailPoints[0]!);
  });

  it('shares the budget of the sign-in link: a refusal of its limiter stops the sign-up before the hash', async () => {
    limiterError = new AppError('RATE_LIMITED');
    expect((await refusal(service().signUp(form, meta)))?.code).toBe('RATE_LIMITED');
    expect(calls).toEqual(['limiter']);
  });
});

describe('AccountLinkSignInService.finishSignUp', () => {
  const principal = { accountId: 5, session: { id: 70 }, stage: 'active' } as never;
  const form = {
    password: 'Xk7mQ2wPzR9tNx',
    firstName: 'Daniel',
    lastName: 'Whitmore',
    country: 'GB',
    phone: '+447700900123',
  };

  beforeEach(() => {
    // An account a link opened elsewhere: no password and no country yet.
    accounts.set(5, account(5, { email: 'new@example.com', hasPassword: false, country: '' }));
  });

  it('sets the details and the first password, voids the password links and ends the other sessions, keeping this one', async () => {
    await service().finishSignUp(principal, form);
    // The address hears of it with its own mail (`customer.password_set`), in the transaction (the re-review of decision 079).
    expect(noticesSent).toEqual([{ id: 5, name: 'Daniel Whitmore' }]);
    expect(calls.indexOf('notice')).toBeGreaterThan(calls.indexOf('password'));
    expect(calls.indexOf('notice')).toBeLessThan(calls.indexOf('commit'));
    expect(detailWrites).toEqual([
      expect.objectContaining({
        id: 5,
        name: 'Daniel Whitmore',
        country: 'GB',
        currency: 'GBP',
        phone: '+447700900123',
      }),
    ]);
    expect(passwordsSaved).toEqual([
      expect.objectContaining({
        id: 5,
        passwordHash: 'argon2id(Xk7mQ2wPzR9tNx)',
        verifyEmail: false,
        expectedHash: null,
      }),
    ]);
    expect(voided).toEqual([[5, ['invite', 'reset']]]);
    expect(allRevoked).toEqual([['account', 5, { exceptSessionId: 70 }]]);
    // read again under the row lock of the exchange, hashed before the transaction
    expect(locks).toEqual(['update 5']);
    expect(calls.indexOf('hash')).toBeLessThan(calls.indexOf('password'));
    expect(calls.at(-1)).toBe('commit');
  });

  it('refuses an account that already has a password with 409, before any write', async () => {
    accounts.set(5, account(5, { hasPassword: true }));
    expect(await refusal(service().finishSignUp(principal, form))).toMatchObject({ code: 'CONFLICT' });
    expect(calls).not.toContain('hash');
    expect(passwordsSaved).toEqual([]);
  });

  it('refuses with 409 when a password was set between the read and the lock, and writes nothing', async () => {
    lockedAs = account(5, { hasPassword: true });
    expect(await refusal(service().finishSignUp(principal, form))).toMatchObject({ code: 'CONFLICT' });
    expect(detailWrites).toEqual([]);
    expect(calls.at(-1)).toBe('rollback');
  });

  it('refuses with 409 when the guarded write finds a password, and rolls back', async () => {
    spyOn(accountRepository, 'saveClientPassword').mockImplementation(() => Promise.resolve(false));
    expect(await refusal(service().finishSignUp(principal, form))).toMatchObject({ code: 'CONFLICT' });
    expect(calls.at(-1)).toBe('rollback');
  });

  it('judges the password with the email and the new names, and the country of a retail account', async () => {
    expect(await refusal(service().finishSignUp(principal, { ...form, password: 'whitmore-2026-xyz' }))).toMatchObject({
      code: 'WEAK_PASSWORD',
      errors: [{ field: 'password' }],
    });
    expect(await refusal(service().finishSignUp(principal, { ...form, country: 'FR' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'country', code: 'unsupported' }],
    });
    // With no tax window in force any listed country is accepted, and a code of no country is not (the review, B1).
    taxCountries = [];
    expect(await refusal(service().finishSignUp(principal, { ...form, country: 'ZZ' }))).toMatchObject({
      errors: [{ field: 'country', code: 'unsupported' }],
    });
    await service().finishSignUp(principal, { ...form, country: 'FR' });
    expect(detailWrites.at(-1)).toMatchObject({ country: 'FR' });
    expect(passwordsSaved).toHaveLength(1);
  });

  it('counts the try first: a refusal of its limiter does no other work', async () => {
    limiterError = new AppError('RATE_LIMITED');
    expect((await refusal(service().finishSignUp(principal, form)))?.code).toBe('RATE_LIMITED');
    expect(calls).toEqual(['finish limiter']);
  });

  it('refuses a session opened more than an hour ago with 409, before the hash and any write (the re-review of decision 079)', async () => {
    for (const opened of [new Date(NOW.getTime() - 60 * 60_000 - 1), undefined]) {
      calls.length = 0;
      sessionOpenedAt = opened;
      const error = await refusal(service().finishSignUp(principal, form));
      expect(error, String(opened)).toMatchObject({
        code: 'CONFLICT',
        detail:
          'For your security, finish creating your account within an hour of opening the sign-in link. Ask for a new sign-in link, open it and try again.',
      });
      expect(calls).toEqual(['finish limiter', 'session age']);
    }
    expect(detailWrites).toEqual([]);
    expect(passwordsSaved).toEqual([]);
    expect(noticesSent).toEqual([]);
  });

  it('accepts a session opened exactly an hour ago', async () => {
    sessionOpenedAt = new Date(NOW.getTime() - 60 * 60_000);
    await service().finishSignUp(principal, form);
    expect(passwordsSaved).toHaveLength(1);
  });

  it('keeps the currency of an account that confirms its stored country, and derives it for a changed one (as PATCH /store/v1/me)', async () => {
    accounts.set(5, account(5, { hasPassword: false, country: 'GB', currency: 'USD' }));
    await service().finishSignUp(principal, form);
    expect(detailWrites.at(-1)).toMatchObject({ country: 'GB' });
    expect('currency' in detailWrites.at(-1)!).toBe(false);

    accounts.set(5, account(5, { hasPassword: false, country: 'JO', currency: 'USD' }));
    await service().finishSignUp(principal, form);
    expect(detailWrites.at(-1)).toMatchObject({ country: 'GB', currency: 'GBP' });
  });

  it('answers 401 for an account that may not act', async () => {
    accounts.set(5, account(5, { status: 'suspended' }));
    expect((await refusal(service().finishSignUp(principal, form)))?.code).toBe('UNAUTHORIZED');
  });
});
