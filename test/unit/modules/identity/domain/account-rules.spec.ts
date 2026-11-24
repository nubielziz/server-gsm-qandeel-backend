// Unit tests of the account rules of staff writes (decision 064): who may give a rank, the email rules of the two partitions, what a status write
// may name, which security tool an account allows, and the currency of a country. Pure: no database.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import {
  COUNTRY_CURRENCY,
  EMAIL_CONFLICT_MESSAGES,
  FALLBACK_CURRENCY,
  RANK_OWNER_DETAIL,
  assertMayChangeRank,
  assertMayGiveRank,
  currencyCodeFor,
  emailChangePermission,
  emailRuleForChange,
  emailRuleForCreate,
  emailRuleForMakeAccount,
  passwordModePermission,
  retailCreateProblem,
  securityToolError,
  securityToolRefusal,
  statusWriteProblem,
} from '@src/modules/identity/domain/account-rules';

/** A caller as the Owner helpers read one: only the permissions matter. */
const holder = (...permissions: string[]) => ({ permissions });
const OWNER = holder('*');
const ADMIN = holder('clients:*', 'groups:*', 'wallet:*', 'customers:privacy');

function refusal(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('assertMayGiveRank', () => {
  it('lets only the Owner give a merchant rank, whatever else the role holds', () => {
    const error = refusal(() => assertMayGiveRank(ADMIN, 'merchant'));
    expect(error.status).toBe(403);
    expect(error.detail).toBe(RANK_OWNER_DETAIL);
    expect(() => assertMayGiveRank(OWNER, 'merchant')).not.toThrow();
  });

  it('asks nothing of a caller who creates a retail account', () => {
    expect(() => assertMayGiveRank(ADMIN, 'retail')).not.toThrow();
    expect(() => assertMayGiveRank(holder(), 'retail')).not.toThrow();
  });
});

describe('assertMayChangeRank', () => {
  it('lets only the Owner change a rank, inside one kind or across kinds', () => {
    expect(refusal(() => assertMayChangeRank(ADMIN)).detail).toBe(RANK_OWNER_DETAIL);
    expect(refusal(() => assertMayChangeRank(holder('clients:update', 'groups:update'))).status).toBe(403);
    expect(() => assertMayChangeRank(OWNER)).not.toThrow();
  });
});

describe('passwordModePermission and emailChangePermission', () => {
  it('asks clients:security for a temporary password and nothing more for a link', () => {
    expect(passwordModePermission('temporary_password')).toBe('clients:security');
    expect(passwordModePermission('reset_link')).toBeNull();
  });

  it('asks clients:security to change the email of a login row and nothing more for a guest row (decision 047)', () => {
    expect(emailChangePermission(true)).toBe('clients:security');
    expect(emailChangePermission(false)).toBeNull();
  });
});

describe('emailRuleForCreate', () => {
  it('refuses an email a row with a login holds, for either rank, whoever else holds it', () => {
    for (const rank of ['retail', 'merchant'] as const) {
      expect(emailRuleForCreate({ login: true, guest: false }, rank)).toEqual({ allowed: false, code: 'taken' });
      expect(emailRuleForCreate({ login: true, guest: true }, rank)).toEqual({ allowed: false, code: 'taken' });
    }
  });

  it("refuses a retail create over a guest row's email and leaves a merchant create to void the guest row's links", () => {
    expect(emailRuleForCreate({ login: false, guest: true }, 'retail')).toEqual({ allowed: false, code: 'guest' });
    expect(emailRuleForCreate({ login: false, guest: true }, 'merchant')).toEqual({
      allowed: true,
      voidGuestLinks: true,
    });
  });

  it('allows an email nobody holds and has no guest links to void', () => {
    expect(emailRuleForCreate({ login: false, guest: false }, 'retail')).toEqual({
      allowed: true,
      voidGuestLinks: false,
    });
    expect(emailRuleForCreate({ login: false, guest: false }, 'merchant')).toEqual({
      allowed: true,
      voidGuestLinks: false,
    });
  });
});

describe('emailRuleForMakeAccount', () => {
  it('refuses a guest whose email another login row holds (login_exists) and allows the rest', () => {
    expect(emailRuleForMakeAccount({ login: true })).toEqual({ allowed: false, code: 'login_exists' });
    expect(emailRuleForMakeAccount({ login: false })).toEqual({ allowed: true, voidGuestLinks: false });
  });
});

describe('emailRuleForChange', () => {
  it("lets a login row take the email of a guest row, voids that guest row's links, and refuses another login row's email", () => {
    expect(emailRuleForChange({ login: false, guest: true }, true)).toEqual({ allowed: true, voidGuestLinks: true });
    expect(emailRuleForChange({ login: false, guest: false }, true)).toEqual({ allowed: true, voidGuestLinks: false });
    expect(emailRuleForChange({ login: true, guest: true }, true)).toEqual({ allowed: false, code: 'taken' });
  });

  it("refuses a guest row another guest row's email and a login row's email, the conflict the create answers", () => {
    expect(emailRuleForChange({ login: false, guest: true }, false)).toEqual({ allowed: false, code: 'taken' });
    expect(emailRuleForChange({ login: true, guest: false }, false)).toEqual({ allowed: false, code: 'taken' });
    expect(emailRuleForChange({ login: true, guest: true }, false)).toEqual({ allowed: false, code: 'taken' });
    expect(emailRuleForChange({ login: false, guest: false }, false)).toEqual({ allowed: true, voidGuestLinks: false });
  });

  it('has one sentence for each conflict', () => {
    expect(Object.keys(EMAIL_CONFLICT_MESSAGES).sort()).toEqual(['guest', 'login_exists', 'taken']);
  });
});

describe('retailCreateProblem', () => {
  it('refuses a company and a credit limit on a retail account, on the key itself', () => {
    expect(retailCreateProblem({ company: 'Zain' })).toMatchObject({ field: 'company' });
    expect(retailCreateProblem({ creditLimit: '0.0000' })).toMatchObject({ field: 'creditLimit' });
    expect(retailCreateProblem({ company: 'Zain', creditLimit: '5.0000' })).toMatchObject({ field: 'company' });
  });

  it('accepts a body without them, and an empty company', () => {
    expect(retailCreateProblem({})).toBeUndefined();
    expect(retailCreateProblem({ company: '' })).toBeUndefined();
  });
});

describe('statusWriteProblem', () => {
  it('accepts active and suspended only, and points blocked and anonymized to their own routes', () => {
    expect(statusWriteProblem('active')).toBeUndefined();
    expect(statusWriteProblem('suspended')).toBeUndefined();
    expect(statusWriteProblem('blocked')).toMatchObject({
      field: 'status',
      message: expect.stringContaining('block route'),
    });
    expect(statusWriteProblem('anonymized')).toMatchObject({
      field: 'status',
      message: expect.stringContaining('anonymize route'),
    });
    // pending has no writer any more
    expect(statusWriteProblem('pending')).toMatchObject({ field: 'status' });
  });
});

describe('securityToolRefusal', () => {
  const active = { hasAccount: true, status: 'active' } as const;

  it('allows every tool on an active account with a login', () => {
    for (const tool of ['password', 'reset_2fa', 'revoke_sessions', 'verification'] as const) {
      expect(securityToolRefusal(active, tool)).toBeUndefined();
    }
  });

  it('refuses every tool on a guest (NO_ACCOUNT) and on an anonymized account (ANONYMIZED, first)', () => {
    for (const tool of ['password', 'reset_2fa', 'revoke_sessions', 'verification'] as const) {
      expect(securityToolRefusal({ hasAccount: false, status: 'active' }, tool)).toBe('NO_ACCOUNT');
      expect(securityToolRefusal({ hasAccount: true, status: 'anonymized' }, tool)).toBe('ANONYMIZED');
      expect(securityToolRefusal({ hasAccount: false, status: 'anonymized' }, tool)).toBe('ANONYMIZED');
    }
  });

  it('refuses a password link and a verification link for an account that may not act, and still lets sessions and 2FA be reset', () => {
    for (const status of ['suspended', 'blocked'] as const) {
      expect(securityToolRefusal({ hasAccount: true, status }, 'password')).toBe('NOT_ACTIVE');
      expect(securityToolRefusal({ hasAccount: true, status }, 'verification')).toBe('NOT_ACTIVE');
      expect(securityToolRefusal({ hasAccount: true, status }, 'revoke_sessions')).toBeUndefined();
      expect(securityToolRefusal({ hasAccount: true, status }, 'reset_2fa')).toBeUndefined();
    }
  });

  it('builds the error of each refusal with its catalog status', () => {
    expect(securityToolError('NO_ACCOUNT')).toMatchObject({ status: 409, detail: 'Make an account first.' });
    expect(securityToolError('ANONYMIZED').status).toBe(409);
    expect(securityToolError('NOT_ACTIVE').status).toBe(409);
  });
});

describe('currencyCodeFor', () => {
  it('names the shop currency of a listed country and falls back to USD', () => {
    expect(currencyCodeFor('GB')).toBe('GBP');
    expect(currencyCodeFor('DE')).toBe('EUR');
    expect(currencyCodeFor('JO')).toBe(FALLBACK_CURRENCY);
    expect(currencyCodeFor('')).toBe('USD');
  });

  it('lists only upper-case country codes with an upper-case currency', () => {
    for (const [country, currency] of Object.entries(COUNTRY_CURRENCY)) {
      expect(country).toMatch(/^[A-Z]{2}$/);
      expect(currency).toMatch(/^[A-Z]{3}$/);
    }
  });
});
