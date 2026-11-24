// Unit test of the actor a principal stands for in the request context (the audit log reads it), and of the account decorator aliases.
import { describe, expect, it } from 'bun:test';
import { actorOf, CurrentLink, CurrentMerchant } from '@src/modules/identity/security/access-state';
import { CurrentAccount } from '@src/modules/identity/ports/account-principal';
import type { Principal, SessionPrincipal } from '@src/modules/identity/security/principal';

const session = { subject: { state: 'ok', name: 'Rami K.' } } as SessionPrincipal['session'];
const rank = (kind: 'merchant' | 'retail') => ({ id: 3, kind });

describe('actorOf', () => {
  it('names the staff member or the account behind a session principal', () => {
    expect(
      actorOf({ kind: 'staff', staffId: 4, roleId: 1, permissions: [], stage: 'active', ip: 'x', session }),
    ).toEqual({
      type: 'staff',
      id: 4,
      name: 'Rami K.',
    });
  });

  it('names an account of either rank with the one type word account (decision 064)', () => {
    for (const kind of ['merchant', 'retail'] as const) {
      expect(
        actorOf({ kind: 'account', accountId: 5, clientId: 5, rank: rank(kind), stage: 'active', ip: 'x', session }),
        kind,
      ).toEqual({ type: 'account', id: 5, name: 'Rami K.' });
    }
  });

  it('uses an empty name when the session snapshot has none', () => {
    const nameless = { subject: { state: 'ok' } } as SessionPrincipal['session'];
    expect(
      actorOf({ kind: 'staff', staffId: 4, roleId: 1, permissions: [], stage: 'active', ip: 'x', session: nameless }),
    ).toEqual({ type: 'staff', id: 4, name: '' });
    expect(
      actorOf({
        kind: 'account',
        accountId: 5,
        clientId: 5,
        rank: rank('retail'),
        stage: 'active',
        ip: 'x',
        session: nameless,
      }),
    ).toEqual({ type: 'account', id: 5, name: '' });
  });

  it('names the account behind an API key (a merchant is an account of a merchant rank)', () => {
    const principal: Principal = {
      kind: 'api-key',
      clientId: 8,
      clientName: 'Zain Mobile Hub',
      keyId: 2,
      ip: 'x',
    };
    expect(actorOf(principal)).toEqual({ type: 'account', id: 8, name: 'Zain Mobile Hub' });
  });

  it('names nobody for the holder of a capability token or a gateway webhook: they are not accounts', () => {
    expect(actorOf({ kind: 'capability', access: 'tracking-token', resourceId: 3, ip: 'x' })).toBeUndefined();
    expect(
      actorOf({ kind: 'webhook', gateway: 'stripe', eventId: 'e', timestamp: 1, duplicate: false, ip: 'x' }),
    ).toBeUndefined();
  });
});

describe('CurrentMerchant', () => {
  it('is the same function as CurrentAccount, a plain re-binding (decision 064)', () => {
    expect(CurrentMerchant).toBe(CurrentAccount);
  });

  it('stays the same function whichever of the two files loads first (they import each other)', () => {
    const script = (first: string, second: string) =>
      `const a = await import('./src/modules/identity/${first}.ts'); const b = await import('./src/modules/identity/${second}.ts');
const merchant = (a.CurrentMerchant ?? b.CurrentMerchant); const account = (a.CurrentAccount ?? b.CurrentAccount);
console.log(JSON.stringify({ same: merchant === account, kind: typeof account }));`;
    for (const [first, second] of [
      ['security/access-state', 'ports/account-principal'],
      ['ports/account-principal', 'security/access-state'],
    ] as const) {
      const run = Bun.spawnSync(['bun', '-e', script(first, second)], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(run.stderr.toString(), `${first} first`).toBe('');
      expect(JSON.parse(run.stdout.toString()), `${first} first`).toEqual({ same: true, kind: 'function' });
    }
  });
});

describe('CurrentLink', () => {
  it('is a parameter decorator of the link routes', () => {
    expect(typeof CurrentLink).toBe('function');
    expect(typeof CurrentLink()).toBe('function');
  });
});
