// Unit tests of the session subject resolvers (decisions 018 and 064): what state a session's staff member or account is in, and the
// rank an active account carries.
import { describe, expect, it } from 'bun:test';
import type { DbService } from '@src/infra/db';
import type { ClientStatus } from '@src/modules/identity/db/schema';
import { RankKinds } from '@src/modules/identity/security/rank-kinds';
import { SessionSubjects } from '@src/modules/identity/security/subject-resolvers';

interface AccountRow {
  readonly status: string;
  readonly name: string;
  readonly groupId: number;
  readonly hasAccount: boolean;
}

/** A database whose select chain answers the given rows, whatever the query. */
function dbReturning(rows: readonly object[]): DbService {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { db: chain } as unknown as DbService;
}

/** A resolver directory over one row and a rank lookup (`undefined` installs none). */
function subjectsFor(row: AccountRow | undefined, kinds?: Record<number, 'merchant' | 'retail'>): SessionSubjects {
  const ranks = new RankKinds();
  if (kinds) ranks.install((groupId) => Promise.resolve(kinds[groupId]));
  return new SessionSubjects(dbReturning(row ? [row] : []), ranks);
}

const account = (over: Partial<AccountRow> = {}): AccountRow => ({
  status: 'active' satisfies ClientStatus,
  name: 'Lina S.',
  groupId: 1,
  hasAccount: true,
  ...over,
});
const KINDS = { 1: 'retail', 2: 'merchant' } as const;

describe('the account resolver', () => {
  it('gives an active account in the retail rank the rank kind retail', async () => {
    expect(await subjectsFor(account({ groupId: 1 }), KINDS).resolve('account', 5)).toEqual({
      state: 'ok',
      name: 'Lina S.',
      rank: { id: 1, kind: 'retail' },
    });
  });

  it('gives an active account in a merchant rank the rank kind merchant', async () => {
    expect(await subjectsFor(account({ groupId: 2 }), KINDS).resolve('account', 5)).toEqual({
      state: 'ok',
      name: 'Lina S.',
      rank: { id: 2, kind: 'merchant' },
    });
  });

  it('is gone for no row, for a guest row and for an anonymized account (401)', async () => {
    expect(await subjectsFor(undefined, KINDS).resolve('account', 5)).toEqual({ state: 'gone' });
    expect(await subjectsFor(account({ hasAccount: false }), KINDS).resolve('account', 5)).toEqual({ state: 'gone' });
    expect(await subjectsFor(account({ status: 'anonymized' }), KINDS).resolve('account', 5)).toEqual({
      state: 'gone',
    });
  });

  it('is suspended for a suspended or blocked account, and for a status the code does not know (403, fail closed)', async () => {
    for (const status of ['suspended', 'blocked', 'pending', 'deleted']) {
      expect(await subjectsFor(account({ status }), KINDS).resolve('account', 5), status).toEqual({
        state: 'suspended',
        name: 'Lina S.',
      });
    }
  });

  it('is gone when the rank kind cannot be read: no lookup installed, or no such rank (fail closed)', async () => {
    expect(await subjectsFor(account(), undefined).resolve('account', 5)).toEqual({ state: 'gone' });
    expect(await subjectsFor(account({ groupId: 99 }), KINDS).resolve('account', 5)).toEqual({ state: 'gone' });
  });

  it('does not read the rank of an account that cannot act', async () => {
    let reads = 0;
    const ranks = new RankKinds();
    ranks.install(() => {
      reads += 1;
      return Promise.resolve('retail');
    });
    const subjects = new SessionSubjects(dbReturning([account({ status: 'suspended' })]), ranks);
    await subjects.resolve('account', 5);
    expect(reads).toBe(0);
  });
});

describe('the staff resolver', () => {
  const staff = (status: string) => ({ status, roleId: 4, name: 'Rami K.' });
  const subjectsOf = (rows: readonly object[]) => new SessionSubjects(dbReturning(rows), new RankKinds());

  it('gives a staff member the role id and no rank, and lets an invited member sign in', async () => {
    expect(await subjectsOf([staff('active')]).resolve('staff', 3)).toEqual({
      state: 'ok',
      roleId: 4,
      name: 'Rami K.',
    });
    expect(await subjectsOf([staff('invited')]).resolve('staff', 3)).toMatchObject({ state: 'ok' });
  });

  it('is suspended for a suspended member and gone for no row', async () => {
    expect(await subjectsOf([staff('suspended')]).resolve('staff', 3)).toMatchObject({ state: 'suspended' });
    expect(await subjectsOf([]).resolve('staff', 3)).toEqual({ state: 'gone' });
  });
});

describe('SessionSubjects', () => {
  it('has the two subject types of the model and no other', () => {
    const subjects = subjectsFor(undefined, KINDS);
    expect(subjects.has('staff')).toBe(true);
    expect(subjects.has('account')).toBe(true);
    // There is no resolver for the retired words, so a stray session of one is gone, never read as an account.
    expect(subjects.has('client' as never)).toBe(false);
    expect(subjects.has('customer' as never)).toBe(false);
  });

  it('answers gone for a subject type without a resolver', async () => {
    expect(await subjectsFor(account(), KINDS).resolve('customer' as never, 5)).toEqual({ state: 'gone' });
  });

  it('refuses a second resolver for one subject type (a boot error)', () => {
    const subjects = subjectsFor(undefined, KINDS);
    expect(() =>
      subjects.register({ subjectType: 'account', resolve: () => Promise.resolve({ state: 'ok' }) }),
    ).toThrow(/already registered/);
  });
});
