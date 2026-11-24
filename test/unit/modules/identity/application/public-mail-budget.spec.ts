// Unit tests of the budget of the mails a visitor can ask for (decision 052, decision 064): one `account-mail` counter per account and kind
// whatever the rank, and the same work for an email that gets no mail.
import { describe, expect, it } from 'bun:test';
import type { RateLimitService } from '@src/infra/rate-limit';
import { takePublicMailPoint } from '@src/modules/identity/application/public-mail-budget';
import { accountMailKey } from '@src/modules/identity/domain/account-mail';
import { NO_ACCOUNT_ID } from '@src/modules/identity/domain/public-links';

/** A limiter that records what is spent and answers the next result in the list. */
function fakeLimits(allowed: boolean[] = []) {
  const spent: Array<{ limiter: string; key: string }> = [];
  const limits = {
    consume: (limiter: string, key: string) => {
      spent.push({ limiter, key });
      return Promise.resolve({ allowed: allowed.shift() ?? true });
    },
  } as unknown as RateLimitService;
  return { limits, spent };
}

describe('takePublicMailPoint', () => {
  it('spends from the account-mail counter of the account and the kind, the same one for every route that asks', async () => {
    const { limits, spent } = fakeLimits();
    expect(await takePublicMailPoint(limits, 'account', 7, 'forgot_password')).toBe(true);
    expect(await takePublicMailPoint(limits, 'account', 7, 'forgot_password')).toBe(true);
    expect(await takePublicMailPoint(limits, 'account', 7, 'sign_in_link')).toBe(true);
    const keys = spent.map((point) => point.key);
    expect(spent.every((point) => point.limiter === 'account-mail')).toBe(true);
    expect(keys[0]).toBe(accountMailKey('account', 7, 'forgot_password'));
    expect(keys[1]).toBe(keys[0]);
    // The sign-in link has a counter of its own, and another account has others.
    expect(keys[2]).toBe(accountMailKey('account', 7, 'sign_in_link'));
    expect(keys[2]).not.toBe(keys[0]);
    expect(accountMailKey('account', 8, 'forgot_password')).not.toBe(keys[0]);
  });

  it('says no when the budget is used up', async () => {
    const { limits } = fakeLimits([true, false]);
    expect(await takePublicMailPoint(limits, 'account', 7, 'sign_in_link')).toBe(true);
    expect(await takePublicMailPoint(limits, 'account', 7, 'sign_in_link')).toBe(false);
  });

  it('does the same work for an email that gets no mail, on the key of no account, and answers no', async () => {
    const { limits, spent } = fakeLimits();
    expect(await takePublicMailPoint(limits, 'account', undefined, 'forgot_password')).toBe(false);
    expect(spent).toEqual([
      { limiter: 'account-mail', key: accountMailKey('account', NO_ACCOUNT_ID, 'forgot_password') },
    ]);
  });
});
