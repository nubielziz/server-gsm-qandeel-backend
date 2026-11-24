// Unit tests of the account-mail rules (feature 20, decision 064): the key of the `account-mail` limiter, which outbox event each mail has
// for each rank kind, and when a mail job sends nothing (a job of the retired customer table, a link of another subject type, an account
// that cannot act or changed rank).
import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_MAIL_EVENTS,
  ACCOUNT_MAIL_EVENT_TYPES,
  ACCOUNT_MAIL_PURPOSES,
  accountIdOfMailJob,
  accountMailAccountSkip,
  accountMailEventInfo,
  accountMailEventOf,
  accountMailKey,
  accountMailLinkUsable,
  formatExpiry,
} from '@src/modules/identity/domain/account-mail';
import { ACCOUNT_TOKEN_PURPOSES } from '@src/modules/identity/ports/account-auth-tokens';
import type { AccountMailKind } from '@src/modules/identity/ports/account-mail-outbox';

describe('accountMailKey', () => {
  it('is stable and a 32-character hex key', () => {
    expect(accountMailKey('account', 7, 'verification')).toMatch(/^[0-9a-f]{32}$/);
    expect(accountMailKey('account', 7, 'verification')).toBe(accountMailKey('account', 7, 'verification'));
  });

  it('tells apart the subject type, the id and the kind', () => {
    const base = accountMailKey('account', 7, 'password_link');
    expect(accountMailKey('staff', 7, 'password_link')).not.toBe(base);
    expect(accountMailKey('account', 8, 'password_link')).not.toBe(base);
    expect(accountMailKey('account', 7, 'verification')).not.toBe(base);
    expect(accountMailKey('account', 7, 'email_change')).not.toBe(base);
  });

  it('keeps the mails a visitor asks for apart from the ones staff send, and one account on one key per kind whatever its rank', () => {
    const keys = new Set([
      accountMailKey('account', 7, 'password_link'),
      accountMailKey('account', 7, 'forgot_password'),
      accountMailKey('account', 7, 'sign_in_link'),
      accountMailKey('account', 7, 'verification'),
      accountMailKey('account', 7, 'email_change'),
    ]);
    expect(keys.size).toBe(5);
    // The key names no rank: a forgot-password request, a sign-in link and a resend of one account spend from that account's counters.
    expect(accountMailKey('account', 7, 'forgot_password')).toBe(accountMailKey('account', 7, 'forgot_password'));
  });
});

describe('the outbox event of a mail', () => {
  it('has the merchant family for a merchant rank and the customer family for a retail rank, with no new event names', () => {
    expect(accountMailEventOf('merchant', 'invited')).toBe('merchant.invited');
    expect(accountMailEventOf('merchant', 'password_reset')).toBe('merchant.password_reset');
    expect(accountMailEventOf('merchant', 'email_verification')).toBe('merchant.email_verification');
    expect(accountMailEventOf('retail', 'invited')).toBe('customer.invited');
    expect(accountMailEventOf('retail', 'password_reset')).toBe('customer.password_reset');
    expect(accountMailEventOf('retail', 'email_verification')).toBe('customer.email_verification');
    expect(accountMailEventOf('retail', 'magic_link')).toBe('customer.magic_link');
    expect([...ACCOUNT_MAIL_EVENT_TYPES].sort()).toEqual([
      'customer.email_verification',
      'customer.invited',
      'customer.magic_link',
      'customer.password_reset',
      'merchant.email_verification',
      'merchant.invited',
      'merchant.password_reset',
    ]);
    expect(ACCOUNT_MAIL_EVENT_TYPES.some((type) => type.startsWith('account.'))).toBe(false);
  });

  it('refuses a sign-in link for a merchant rank: the link is for the retail rank only', () => {
    expect(() => accountMailEventOf('merchant', 'magic_link')).toThrow('not sent to a merchant account');
  });

  it('reads the family and the kind back from the event type, and knows nothing else', () => {
    for (const rankKind of ['merchant', 'retail'] as const) {
      for (const [kind, type] of Object.entries(ACCOUNT_MAIL_EVENTS[rankKind])) {
        expect(accountMailEventInfo(type)).toEqual({ rankKind, kind: kind as AccountMailKind });
      }
    }
    expect(accountMailEventInfo('merchant.suspended')).toBeUndefined();
    expect(accountMailEventInfo('staff.invited')).toBeUndefined();
    expect(accountMailEventInfo('account.invited')).toBeUndefined();
  });

  it('has the purpose of each link: one per mail, all of them the closed list of the seam', () => {
    expect(ACCOUNT_MAIL_PURPOSES).toEqual({
      email_verification: 'verify_email',
      password_reset: 'reset',
      invited: 'invite',
      magic_link: 'magic_link',
    });
    expect([...Object.values(ACCOUNT_MAIL_PURPOSES)].sort()).toEqual([...ACCOUNT_TOKEN_PURPOSES].sort());
  });
});

describe('accountIdOfMailJob', () => {
  const merchant = { rankKind: 'merchant' } as const;
  const retail = { rankKind: 'retail' } as const;

  it('reads payload.accountId of any job', () => {
    expect(accountIdOfMailJob(merchant, { aggregateType: 'clients', aggregateId: 99, payload: { accountId: 7 } })).toBe(
      7,
    );
    expect(accountIdOfMailJob(retail, { aggregateType: 'clients', aggregateId: 99, payload: { accountId: 7 } })).toBe(
      7,
    );
  });

  it('never reads the number of a job of the retired customer table as an account id', () => {
    // The job a customer mail wrote before the cut-over: the customer is the aggregate, the payload has the link only.
    expect(
      accountIdOfMailJob(retail, { aggregateType: 'customers', aggregateId: 7, payload: { tokenId: 5 } }),
    ).toBeUndefined();
    // Even a retail job that names a client aggregate has no account id without payload.accountId.
    expect(
      accountIdOfMailJob(retail, { aggregateType: 'clients', aggregateId: 7, payload: { tokenId: 5 } }),
    ).toBeUndefined();
    expect(
      accountIdOfMailJob(retail, { aggregateType: 'customers', aggregateId: 7, payload: { customerId: 7 } }),
    ).toBeUndefined();
  });

  it('accepts a merchant mail queued before the cut-over: the merchant is the aggregate and its id is the account id', () => {
    expect(accountIdOfMailJob(merchant, { aggregateType: 'clients', aggregateId: 12, payload: { tokenId: 5 } })).toBe(
      12,
    );
    expect(accountIdOfMailJob(merchant, { aggregateType: 'clients', aggregateId: 99, payload: { clientId: 12 } })).toBe(
      12,
    );
    expect(
      accountIdOfMailJob(merchant, { aggregateType: 'customers', aggregateId: 12, payload: { tokenId: 5 } }),
    ).toBeUndefined();
  });
});

describe('accountMailAccountSkip', () => {
  it('goes on for an active account of the rank the mail was written for', () => {
    expect(
      accountMailAccountSkip({ rankKind: 'merchant' }, { status: 'active', rankKind: 'merchant' }),
    ).toBeUndefined();
    expect(accountMailAccountSkip({ rankKind: 'retail' }, { status: 'active', rankKind: 'retail' })).toBeUndefined();
  });

  it('sends nothing to an account that is gone, anonymized, suspended or blocked', () => {
    expect(accountMailAccountSkip({ rankKind: 'retail' }, undefined)).toBe('account_gone');
    expect(accountMailAccountSkip({ rankKind: 'retail' }, { status: 'anonymized', rankKind: 'retail' })).toBe(
      'account_gone',
    );
    expect(accountMailAccountSkip({ rankKind: 'retail' }, { status: 'suspended', rankKind: 'retail' })).toBe(
      'account_not_active',
    );
    expect(accountMailAccountSkip({ rankKind: 'merchant' }, { status: 'blocked', rankKind: 'merchant' })).toBe(
      'account_not_active',
    );
  });

  it('sends nothing to an account whose rank kind changed after the mail was queued', () => {
    expect(accountMailAccountSkip({ rankKind: 'merchant' }, { status: 'active', rankKind: 'retail' })).toBe(
      'rank_changed',
    );
    expect(accountMailAccountSkip({ rankKind: 'retail' }, { status: 'active', rankKind: 'merchant' })).toBe(
      'rank_changed',
    );
  });
});

describe('accountMailLinkUsable', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const link = {
    subjectType: 'account',
    subjectId: 7,
    purpose: 'invite',
    usedAt: null,
    expiresAt: new Date('2026-11-24T11:00:00Z'),
  };

  it('accepts the unused, unexpired link of this account with the purpose of the mail', () => {
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, link, now)).toBe(true);
  });

  it('skips a token of subject customer even when its subject id equals the account id', () => {
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, { ...link, subjectType: 'customer' }, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, { ...link, subjectType: 'client' }, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, { ...link, subjectType: 'staff' }, now)).toBe(false);
  });

  it('skips the link of another account, of another purpose, a used one, an expired one and a missing one', () => {
    expect(accountMailLinkUsable({ kind: 'invited' }, 8, link, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'password_reset' }, 7, link, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, { ...link, usedAt: now }, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, { ...link, expiresAt: now }, now)).toBe(false);
    expect(accountMailLinkUsable({ kind: 'invited' }, 7, undefined, now)).toBe(false);
  });
});

describe('formatExpiry', () => {
  it('tells the minute a link stops working, in UTC', () => {
    expect(formatExpiry(new Date('2026-11-01T11:00:45Z'))).toBe('2026-11-01 11:00 UTC');
  });
});
