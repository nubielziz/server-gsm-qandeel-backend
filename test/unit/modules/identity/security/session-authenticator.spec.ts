// Unit tests of the session authenticator over fakes (decisions 018, 053 and 064): the one account principal, the order of the checks, the
// upload pre-check with the rank gate, and the failed-lookup budget that both URL families of the accounts share.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import type { RateLimitService } from '@src/infra/rate-limit';
import type { RolePermissions } from '@src/modules/identity/security/role-permissions';
import {
  SessionAuthenticator,
  assertRankAllowed,
  sessionFailureKey,
} from '@src/modules/identity/security/session-authenticator';
import type { SessionCookies } from '@src/modules/identity/security/session-cookies';
import type { SessionService } from '@src/modules/identity/security/session.service';
import type { SessionView, SubjectSnapshot } from '@src/modules/identity/security/session.types';
import { TestClock } from '../../../../support/clock';
import { expectRejection } from '../../../../support/rejection';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
const request = { ip: '203.0.113.7' } as FastifyRequest;

function viewOf(over: Partial<SessionView> & { subject?: SubjectSnapshot } = {}): SessionView {
  return {
    id: 11,
    tokenHash: 'h'.repeat(64),
    subjectType: 'account',
    subjectId: 5,
    stage: 'active',
    ip: '203.0.113.7',
    userAgent: 'bun-test',
    lastSeenAtMs: clock.nowMs(),
    expiresAtMs: clock.nowMs() + 3_600_000,
    idleMs: 600_000,
    subject: { state: 'ok', name: 'Lina S.', rank: { id: 2, kind: 'retail' } },
    ...over,
  };
}

/** An authenticator over fakes; `view` is what the session store answers (`undefined`: no live session), `token` the cookie (`null`: none). */
function authenticatorFor(view: SessionView | undefined, token: string | null = 'a'.repeat(43)) {
  const revoked: Array<[string, number]> = [];
  const consumed: string[] = [];
  const cookies = { readToken: () => token ?? undefined } as unknown as SessionCookies;
  const sessions = {
    lookup: () => Promise.resolve(view),
    lookupCached: () => Promise.resolve(view),
    touch: () => Promise.resolve(false),
    revokeAllOf: (subjectType: string, subjectId: number) => {
      revoked.push([subjectType, subjectId]);
      return Promise.resolve(2);
    },
  } as unknown as SessionService;
  const roles = { permissionsOf: () => Promise.resolve(['staff:read']) } as unknown as RolePermissions;
  const limits = {
    peek: () => Promise.resolve({ allowed: true }),
    consume: (_limiter: string, key: string) => {
      consumed.push(key);
      return Promise.resolve({ allowed: true });
    },
  } as unknown as RateLimitService;
  return { authenticator: new SessionAuthenticator(cookies, sessions, roles, limits, clock), revoked, consumed };
}

const stages = { stages: ['active'] } as const;

describe('authenticate an account', () => {
  it('builds the one account principal with the rank, for a retail and a merchant account alike', async () => {
    for (const kind of ['retail', 'merchant'] as const) {
      const view = viewOf({ subject: { state: 'ok', name: 'Lina S.', rank: { id: 2, kind } } });
      const { principal } = await authenticatorFor(view).authenticator.authenticate('account', request, stages);
      expect(principal, kind).toEqual({
        kind: 'account',
        accountId: 5,
        // The same value, kept for the merchant controllers written before the accounts merged.
        clientId: 5,
        rank: { id: 2, kind },
        stage: 'active',
        ip: '203.0.113.7',
        session: view,
      });
    }
  });

  it('refuses a view without a rank with 401, never guessing a kind (fail closed)', async () => {
    const view = viewOf({ subject: { state: 'ok', name: 'Lina S.' } });
    const error = await expectRejection(authenticatorFor(view).authenticator.authenticate('account', request, stages));
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('refuses a session of another subject type than the route reads: a staff session is not an account session', async () => {
    const staffView = viewOf({ subjectType: 'staff', subject: { state: 'ok', roleId: 1 } });
    const error = await expectRejection(
      authenticatorFor(staffView).authenticator.authenticate('account', request, stages),
    );
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    const accountView = viewOf();
    const other = await expectRejection(
      authenticatorFor(accountView).authenticator.authenticate('staff', request, stages),
    );
    expect(other).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses no cookie, no live session, and an ended session with 401', async () => {
    expect(
      await expectRejection(authenticatorFor(viewOf(), null).authenticator.authenticate('account', request, stages)),
    ).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(
      await expectRejection(authenticatorFor(undefined).authenticator.authenticate('account', request, stages)),
    ).toMatchObject({ code: 'UNAUTHORIZED' });
    const ended = viewOf({ expiresAtMs: clock.nowMs() - 1 });
    expect(
      await expectRejection(authenticatorFor(ended).authenticator.authenticate('account', request, stages)),
    ).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('answers 403 ACCOUNT_SUSPENDED for a suspended account and revokes every session of the account', async () => {
    const view = viewOf({ subject: { state: 'suspended', name: 'Lina S.' } });
    const { authenticator, revoked } = authenticatorFor(view);
    const error = await expectRejection(authenticator.authenticate('account', request, stages));
    expect(error).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    expect(revoked).toEqual([['account', 5]]);
  });

  it('refuses a pending step on a route that wants a full session with 401, after the suspension check', async () => {
    const pending = viewOf({ stage: 'pending_totp' });
    const error = await expectRejection(
      authenticatorFor(pending).authenticator.authenticate('account', request, stages),
    );
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    const accepted = await authenticatorFor(pending).authenticator.authenticate('account', request, {
      stages: ['pending_totp'],
    });
    expect(accepted.principal).toMatchObject({ kind: 'account', stage: 'pending_totp' });
  });

  it('builds the staff principal as before, with the permissions of an active session only', async () => {
    const staff = viewOf({ subjectType: 'staff', subjectId: 9, subject: { state: 'ok', roleId: 1, name: 'Rami K.' } });
    const { principal } = await authenticatorFor(staff).authenticator.authenticate('staff', request, stages);
    expect(principal).toMatchObject({ kind: 'staff', staffId: 9, roleId: 1, permissions: ['staff:read'] });
    const pending = viewOf({
      subjectType: 'staff',
      subjectId: 9,
      stage: 'pending_totp',
      subject: { state: 'ok', roleId: 1 },
    });
    const step = await authenticatorFor(pending).authenticator.authenticate('staff', request, {
      stages: ['pending_totp'],
    });
    expect(step.principal).toMatchObject({ kind: 'staff', permissions: [] });
  });
});

describe('authenticateOptional', () => {
  it('answers undefined for a refusal of the session, and lets other errors through', async () => {
    expect(
      await authenticatorFor(undefined).authenticator.authenticateOptional('account', request, stages),
    ).toBeUndefined();
    const suspended = viewOf({ subject: { state: 'suspended' } });
    expect(
      await authenticatorFor(suspended).authenticator.authenticateOptional('account', request, stages),
    ).toBeUndefined();
    const noRank = viewOf({ subject: { state: 'ok' } });
    expect(
      await authenticatorFor(noRank).authenticator.authenticateOptional('account', request, stages),
    ).toBeUndefined();
    const live = await authenticatorFor(viewOf()).authenticator.authenticateOptional('account', request, stages);
    expect(live?.principal).toMatchObject({ kind: 'account', accountId: 5 });
  });
});

describe('the upload pre-check and the rank gate', () => {
  const retail = viewOf({ subject: { state: 'ok', rank: { id: 1, kind: 'retail' } } });
  const merchant = viewOf({ subject: { state: 'ok', rank: { id: 2, kind: 'merchant' } } });

  it('refuses a retail session on a merchant upload route with 403 RANK_NOT_ALLOWED, before any body is read', async () => {
    const error = await expectRejection(
      authenticatorFor(retail).authenticator.precheck('account', request, 'merchant'),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'RANK_NOT_ALLOWED', status: 403 });
  });

  it('refuses a merchant session on the shop upload route, and a session without a rank on both', async () => {
    expect(
      await expectRejection(authenticatorFor(merchant).authenticator.precheck('account', request, 'retail')),
    ).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    const noRank = viewOf({ subject: { state: 'ok' } });
    for (const rank of ['merchant', 'retail'] as const) {
      expect(
        await expectRejection(authenticatorFor(noRank).authenticator.precheck('account', request, rank)),
        rank,
      ).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    }
  });

  it('passes the rank the route serves, a route open to every rank, and a route without a rank', async () => {
    await authenticatorFor(merchant).authenticator.precheck('account', request, 'merchant');
    await authenticatorFor(retail).authenticator.precheck('account', request, 'retail');
    await authenticatorFor(retail).authenticator.precheck('account', request, 'any');
    await authenticatorFor(merchant).authenticator.precheck('account', request);
    await authenticatorFor(merchant).authenticator.precheck('account', request, null);
  });

  it('leaves a suspended account to the guard, which answers ACCOUNT_SUSPENDED', async () => {
    const suspended = viewOf({ subject: { state: 'suspended' } });
    await authenticatorFor(suspended).authenticator.precheck('account', request, 'merchant');
  });

  it('refuses no cookie and a cookie that names no live session with 401, and charges the budget once for the second', async () => {
    expect(
      await expectRejection(authenticatorFor(retail, null).authenticator.precheck('account', request, 'retail')),
    ).toMatchObject({ code: 'UNAUTHORIZED' });
    const { authenticator, consumed } = authenticatorFor(undefined);
    expect(await expectRejection(authenticator.precheck('account', request, 'retail'))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(consumed).toEqual([sessionFailureKey('account', request.ip)]);
  });

  it('does not judge a staff upload by rank', async () => {
    const staff = viewOf({ subjectType: 'staff', subject: { state: 'ok', roleId: 1 } });
    await authenticatorFor(staff).authenticator.precheck('staff', request, null);
  });
});

describe('assertRankAllowed', () => {
  const view = (kind?: 'merchant' | 'retail') => ({
    subject: { state: 'ok', ...(kind ? { rank: { id: 1, kind } } : {}) } as SubjectSnapshot,
  });

  it('passes the rank of the route and every rank for any, and lets a route outside the gate (null) through', () => {
    expect(() => assertRankAllowed(view('merchant'), 'merchant')).not.toThrow();
    expect(() => assertRankAllowed(view('retail'), 'retail')).not.toThrow();
    expect(() => assertRankAllowed(view('retail'), 'any')).not.toThrow();
    expect(() => assertRankAllowed(view(), 'any')).not.toThrow();
    expect(() => assertRankAllowed(view(), null)).not.toThrow();
  });

  it('refuses another rank, and a view without one, in the words the shops show', () => {
    expect(() => assertRankAllowed(view('retail'), 'merchant')).toThrow('This is available to merchant accounts.');
    expect(() => assertRankAllowed(view('merchant'), 'retail')).toThrow('This is available to shop accounts.');
    expect(() => assertRankAllowed(view(), 'merchant')).toThrow(AppError);
    try {
      assertRankAllowed(view(), 'retail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RANK_NOT_ALLOWED', status: 403 });
    }
  });
});

describe('sessionFailureKey', () => {
  it('is one budget per address for every account, whatever URL family or rank, and another for staff', () => {
    expect(sessionFailureKey('account', '203.0.113.7')).toMatch(/^session-failures:account:/);
    expect(sessionFailureKey('staff', '203.0.113.7')).toMatch(/^session-failures:staff:/);
    expect(sessionFailureKey('account', '203.0.113.7')).not.toBe(sessionFailureKey('staff', '203.0.113.7'));
    // The IPv4 address or the IPv6 /64, so one network is one budget.
    expect(sessionFailureKey('account', '2001:db8::1')).toBe(sessionFailureKey('account', '2001:db8::2'));
  });
});
