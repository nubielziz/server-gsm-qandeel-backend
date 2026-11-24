// Unit tests of the link-token resolver of accounts (decisions 010, 018, 064): a usable link of the four purposes opens its row id, and
// every other token opens nothing. The resolver only looks: it never spends the token.
import { describe, expect, it } from 'bun:test';
import { AccountIdentityRegistrar, isUsableLink } from '@src/modules/identity/application/account-identity-registrar';
import { CapabilityTokenResolvers } from '@src/modules/identity/security/machine/capability-tokens';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const later = new Date(NOW + 60_000);
const earlier = new Date(NOW - 60_000);

describe('isUsableLink', () => {
  it('is true only for a link that is unused and not expired', () => {
    expect(isUsableLink({ usedAt: null, expiresAt: later }, NOW)).toBe(true);
    expect(isUsableLink({ usedAt: new Date(NOW), expiresAt: later }, NOW)).toBe(false);
    expect(isUsableLink({ usedAt: null, expiresAt: earlier }, NOW)).toBe(false);
    // the end of the last second is the end
    expect(isUsableLink({ usedAt: null, expiresAt: new Date(NOW) }, NOW)).toBe(false);
  });
});

describe('AccountIdentityRegistrar', () => {
  /** Boots the registrar over a token store that answers one stored row (or none). */
  function resolverOver(row: Record<string, unknown> | undefined) {
    const registry = new CapabilityTokenResolvers();
    const looked: string[] = [];
    const tokens = {
      findByHash: (token: string) => {
        looked.push(token);
        return Promise.resolve(row);
      },
    };
    new AccountIdentityRegistrar(registry, tokens as never, { nowMs: () => NOW } as never).onModuleInit();
    return { registry, looked };
  }

  it('registers the link-token resolver once (a second registration is a boot error)', () => {
    const { registry } = resolverOver(undefined);
    expect(registry.has('link-token')).toBe(true);
    expect(() =>
      new AccountIdentityRegistrar(registry, {} as never, { nowMs: () => NOW } as never).onModuleInit(),
    ).toThrow('already registered');
  });

  it.each(['magic_link', 'verify_email', 'invite', 'reset'])('opens the id of a usable %s link', async (purpose) => {
    const { registry, looked } = resolverOver({ id: 31, purpose, usedAt: null, expiresAt: later });
    expect(await registry.resolve('link-token', 'a-token-of-the-right-shape')).toEqual({ id: 31 });
    expect(looked).toEqual(['a-token-of-the-right-shape']);
  });

  it('opens nothing for an unknown, used, expired or foreign-purpose token', async () => {
    for (const row of [
      undefined,
      { id: 1, purpose: 'magic_link', usedAt: new Date(NOW - 1), expiresAt: later },
      { id: 2, purpose: 'magic_link', usedAt: null, expiresAt: earlier },
      { id: 3, purpose: 'staff_invite', usedAt: null, expiresAt: later },
    ]) {
      const { registry } = resolverOver(row);
      expect(await registry.resolve('link-token', 'a-token-of-the-right-shape')).toBeNull();
    }
  });
});
