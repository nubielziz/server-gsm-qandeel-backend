// Unit tests of the sign-in limiter of every account: which limiter and which key each step uses. The key keeps the prefix of the merchant
// counters of before the accounts merged (so no counter resets at the cut-over), every part of it is normalised (an email in another case
// spends the same budget), and the three sign-in routes, which call the same methods, spend one budget per email and network.
import { describe, expect, it } from 'bun:test';
import type { TokenService } from '@src/infra/crypto';
import type { RateLimitService } from '@src/infra/rate-limit';
import { AccountSignInLimiter } from '@src/modules/identity/application/account-sign-in-limiter';

/** A limiter whose keys are readable: the token service returns the text it is asked to hash, and every call is recorded. */
function recorded(): { limiter: AccountSignInLimiter; calls: Array<{ call: string; limiter: string; key: string }> } {
  const calls: Array<{ call: string; limiter: string; key: string }> = [];
  const limits = {
    enforce: (limiter: string, key: string) => Promise.resolve(void calls.push({ call: 'enforce', limiter, key })),
    reset: (limiter: string, key: string) => Promise.resolve(void calls.push({ call: 'reset', limiter, key })),
  } as unknown as RateLimitService;
  const tokens = { hash: (text: string) => text } as unknown as TokenService;
  return { limiter: new AccountSignInLimiter(limits, tokens), calls };
}

const NUL = '\u0000';
const meta = { limitKey: '203.0.113.0' };

describe('AccountSignInLimiter', () => {
  it('counts a login on the sign-in limiter under the merchant prefix, by email and network, in lower case', async () => {
    const { limiter, calls } = recorded();
    await limiter.enforceLogin('  Ann@Example.COM ', meta);
    await limiter.resetLogin('ann@example.com', meta);
    const key = `merchant-sign-in${NUL}login${NUL}ann@example.com${NUL}203.0.113.0`;
    expect(calls).toEqual([
      { call: 'enforce', limiter: 'sign-in', key },
      { call: 'reset', limiter: 'sign-in', key },
    ]);
  });

  it('keeps one kind apart from the others: login, magic link, forgot password', async () => {
    const { limiter, calls } = recorded();
    await limiter.enforceLogin('a@example.com', meta);
    await limiter.enforceMagicLink('a@example.com', meta);
    await limiter.enforceForgot('a@example.com', meta);
    const kinds = calls.map((entry) => entry.key.split(NUL)[1]);
    expect(kinds).toEqual(['login', 'magic', 'forgot']);
    expect(new Set(calls.map((entry) => entry.key)).size).toBe(3);
  });

  it('counts the code, setup and password steps per account, the code step on its own limiter', async () => {
    const { limiter, calls } = recorded();
    await limiter.enforceCode(7);
    await limiter.resetCode(7);
    await limiter.enforceSetup(7);
    await limiter.enforcePasswordChange(7);
    await limiter.resetPasswordChange(7);
    expect(calls).toEqual([
      { call: 'enforce', limiter: 'sign-in-code', key: `merchant-sign-in${NUL}code${NUL}7` },
      { call: 'reset', limiter: 'sign-in-code', key: `merchant-sign-in${NUL}code${NUL}7` },
      { call: 'enforce', limiter: 'sign-in', key: `merchant-sign-in${NUL}setup${NUL}7` },
      { call: 'enforce', limiter: 'sign-in', key: `merchant-sign-in${NUL}password${NUL}7` },
      { call: 'reset', limiter: 'sign-in', key: `merchant-sign-in${NUL}password${NUL}7` },
    ]);
  });

  it('counts a try of an emailed link on the token limiter by the address key', async () => {
    const { limiter, calls } = recorded();
    await limiter.enforceLink('203.0.113.0');
    expect(calls).toEqual([{ call: 'enforce', limiter: 'token', key: '203.0.113.0' }]);
  });
});
