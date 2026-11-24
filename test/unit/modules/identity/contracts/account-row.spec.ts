// Unit tests of the wire row of an account (decision 064): one schema for a merchant, a retail account and a guest.
import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_ROW_EXAMPLE,
  AccountRowSchema,
  AccountWalletSchema,
  GUEST_ROW_EXAMPLE,
} from '@src/modules/identity/contracts/account-row';

/** The example with some keys replaced, as a plain object the schema can judge. */
const withChange = (base: object, change: Record<string, unknown>): unknown => ({ ...base, ...change });

describe('AccountRowSchema', () => {
  it('reads the merchant example, with its wallet and its 30-day figures', () => {
    expect(AccountRowSchema.safeParse(ACCOUNT_ROW_EXAMPLE).success).toBe(true);
  });

  it('reads a guest: no login, no username, no security, no wallet', () => {
    const guest = AccountRowSchema.safeParse(GUEST_ROW_EXAMPLE);
    expect(guest.success).toBe(true);
    expect(guest.data).toMatchObject({ hasAccount: false, username: null, security: null });
    expect(guest.data).not.toHaveProperty('wallet');
  });

  it('accepts a null username (a retail account has none until it holds a merchant rank)', () => {
    expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { username: null })).success).toBe(true);
    expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { username: 7 })).success).toBe(false);
  });

  it('names the four statuses of an account and refuses any other word, the retired pending included', () => {
    for (const status of ['active', 'suspended', 'blocked', 'anonymized']) {
      expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { status })).success, status).toBe(true);
    }
    for (const status of ['flagged', 'pending', '']) {
      expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { status })).success, status).toBe(false);
    }
  });

  it('says retail or merchant for the rank kind and never the stored words of the catalog', () => {
    const rank = (kind: string) => ({ ...ACCOUNT_ROW_EXAMPLE.rank, kind });
    expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { rank: rank('retail') })).success).toBe(true);
    for (const kind of ['b2b', 'b2c_retail', 'customer']) {
      expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { rank: rank(kind) })).success, kind).toBe(
        false,
      );
    }
  });

  it('has no group key: the rank is the one place that names the group', () => {
    const keys = Object.keys(AccountRowSchema.shape);
    expect(keys).not.toContain('groupId');
    expect(keys).not.toContain('group');
    expect(keys).toEqual(
      expect.arrayContaining([
        'rank',
        'hasAccount',
        'invitationPending',
        'currencyCode',
        'marketingOptIn',
        'createdBy',
        'anonymizedAt',
        'ordersCount',
        'lastOrderAt',
      ]),
    );
  });

  it('asks for the keys every caller with clients:read gets, and leaves wallet and stats optional', () => {
    for (const key of [
      'rank',
      'hasAccount',
      'invitationPending',
      'ordersCount',
      'lastOrderAt',
      'security',
      'suspension',
    ]) {
      const { [key as keyof typeof GUEST_ROW_EXAMPLE]: _removed, ...without } = GUEST_ROW_EXAMPLE;
      expect(AccountRowSchema.safeParse(without).success, key).toBe(false);
    }
    expect(AccountRowSchema.shape.wallet.safeParse(undefined).success).toBe(true);
    expect(AccountRowSchema.shape.stats.safeParse(undefined).success).toBe(true);
  });

  it('counts orders as a whole number of zero or more', () => {
    for (const ordersCount of [-1, 1.5, '3']) {
      expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { ordersCount })).success).toBe(false);
    }
    expect(AccountRowSchema.safeParse(withChange(ACCOUNT_ROW_EXAMPLE, { ordersCount: 0 })).success).toBe(true);
  });
});

describe('AccountWalletSchema', () => {
  const wallet = ACCOUNT_ROW_EXAMPLE.wallet;

  it('names the kind of wallet and says only whether it is frozen', () => {
    expect(AccountWalletSchema.safeParse(wallet).success).toBe(true);
    expect(AccountWalletSchema.safeParse({ ...wallet, kind: 'store', frozen: true }).success).toBe(true);
    expect(AccountWalletSchema.safeParse({ ...wallet, kind: 'client_wallet' }).success).toBe(false);
    expect(
      AccountWalletSchema.safeParse({ ...wallet, frozen: { at: '2026-11-01T09:30:00.000Z', reason: 'x' } }).success,
    ).toBe(false);
  });

  it('carries money as text with four decimals, a balance and what is available may be negative', () => {
    expect(AccountWalletSchema.safeParse({ ...wallet, balance: '-12.5000', available: '-12.5000' }).success).toBe(true);
    expect(AccountWalletSchema.safeParse({ ...wallet, balance: 12.5 }).success).toBe(false);
    expect(AccountWalletSchema.safeParse({ ...wallet, balance: '12.5' }).success).toBe(false);
    expect(AccountWalletSchema.safeParse({ ...wallet, reserved: '-1.0000' }).success).toBe(false);
  });
});
