// Unit tests of the account mail job (decision 064), on fakes of the account directory, the link service and the notification path: what it
// refuses (a job of the retired customer table, a link of another subject type, an account that cannot act or changed rank), where each
// link points and which variables each rank's text gets. The database part is test/integration/identity/account-mail.test.ts.
import { beforeEach, describe, expect, it } from 'bun:test';
import type { AppConfig } from '@src/config';
import type { DbService } from '@src/infra/db';
import { UnrecoverableError } from '@src/infra/queues';
import {
  AccountMailJobs,
  type AccountMailJob,
  type AccountMailJobResult,
} from '@src/modules/identity/application/mail/account-mail-jobs';
import type { AccountAuthTokenService } from '@src/modules/identity/application/account-auth-tokens';
import type { AccountDirectory, AccountRecord } from '@src/modules/identity';
import type { NotificationService } from '@src/modules/platform';
import { expectRejection } from '../../../../../support/rejection';

const NOW = new Date('2026-11-24T10:00:00Z');

const account = (patch: Partial<AccountRecord> = {}): AccountRecord => ({
  id: 7,
  email: 'someone@example.com',
  name: 'Sam',
  status: 'active',
  groupId: 1,
  rankKind: 'retail',
  hasAccount: true,
  hasPassword: false,
  emailVerifiedAt: null,
  country: '',
  currency: null,
  ...patch,
});

const link = (patch: Record<string, unknown> = {}) => ({
  id: 5,
  subjectType: 'account',
  subjectId: 7,
  purpose: 'invite',
  usedAt: null,
  expiresAt: new Date('2026-11-24T11:00:00Z'),
  ...patch,
});

const jobOf = (type: string, data: Record<string, unknown> = {}): AccountMailJob =>
  ({
    data: {
      eventId: 41,
      type,
      aggregateType: 'clients',
      aggregateId: 7,
      payload: { accountId: 7, tokenId: 5 },
      requestId: 'test',
      ...data,
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
  }) as AccountMailJob;

interface Fixture {
  readonly jobs: AccountMailJobs;
  readonly sent: Array<{ event: string; variables: Record<string, string>; link: string }>;
  readonly abandoned: string[];
  readonly reads: { accounts: number; rotations: number };
  state: { account: AccountRecord | undefined; link: ReturnType<typeof link> | undefined; earlier: string | undefined };
}

function build(): Fixture {
  const state: Fixture['state'] = { account: account(), link: link(), earlier: undefined };
  const sent: Fixture['sent'] = [];
  const abandoned: string[] = [];
  const reads = { accounts: 0, rotations: 0 };
  const accounts = {
    findById: () => {
      reads.accounts += 1;
      return Promise.resolve(state.account);
    },
  } as unknown as AccountDirectory;
  const tokens = {
    findById: () => Promise.resolve(state.link),
    rotate: () => {
      reads.rotations += 1;
      return Promise.resolve('clear-token');
    },
  } as unknown as AccountAuthTokenService;
  const notifications = {
    statusOf: () => Promise.resolve(state.earlier),
    check: () => Promise.resolve({ recipient: {}, definition: {} }),
    abandon: (_key: string, reason: string) => {
      abandoned.push(reason);
      return Promise.resolve();
    },
    sendNow: (input: { event: string; variables: Record<string, string> }, secrets: { link: string }) => {
      sent.push({ event: input.event, variables: input.variables, link: secrets.link });
      return Promise.resolve({ status: 'sent' as const });
    },
  } as unknown as NotificationService;
  const config = { http: { storeBaseUrl: 'https://shop.example.com' } } as unknown as AppConfig;
  const jobs = new AccountMailJobs({ db: {} } as unknown as DbService, accounts, tokens, notifications, config, {
    now: () => NOW,
  } as never);
  return { jobs, sent, abandoned, reads, state };
}

describe('AccountMailJobs', () => {
  let f: Fixture;
  beforeEach(() => {
    f = build();
  });

  it('discards a job with only the number of a retired customer, and reads nothing', async () => {
    const old = jobOf('customer.invited', { aggregateType: 'customers', payload: { tokenId: 5 } });
    await expectRejection(f.jobs.handle('customer.invited', old), UnrecoverableError);
    const onlyCustomerId = jobOf('customer.magic_link', {
      aggregateType: 'customers',
      payload: { customerId: 7, tokenId: 5 },
    });
    await expectRejection(f.jobs.handle('customer.magic_link', onlyCustomerId), UnrecoverableError);
    expect(f.reads.accounts).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it('discards a job without a link row and a type that is not an account mail', async () => {
    await expectRejection(
      f.jobs.handle('customer.invited', jobOf('customer.invited', { payload: { accountId: 7 } })),
      UnrecoverableError,
    );
    await expectRejection(f.jobs.handle('staff.invited', jobOf('staff.invited')), UnrecoverableError);
  });

  it('skips a link of subject customer even when its subject id equals the account id', async () => {
    f.state.link = link({ subjectType: 'customer' });
    expect(await f.jobs.handle('customer.invited', jobOf('customer.invited'))).toEqual({
      sent: false,
      skipped: 'link_not_usable',
    });
    expect(f.reads.rotations).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.abandoned).toEqual(['link_not_usable']);
  });

  it('skips a missing, used, expired or other-purpose link and rotates none of them', async () => {
    f.state.account = account({ rankKind: 'merchant' });
    for (const patch of [{ usedAt: NOW }, { expiresAt: NOW }, { purpose: 'reset' }, { subjectId: 8 }]) {
      f.state.link = link(patch);
      expect(await f.jobs.handle('merchant.invited', jobOf('merchant.invited'))).toMatchObject({
        skipped: 'link_not_usable',
      });
    }
    f.state.link = undefined;
    expect(await f.jobs.handle('merchant.invited', jobOf('merchant.invited'))).toMatchObject({
      skipped: 'link_not_usable',
    });
    expect(f.reads.rotations).toBe(0);
  });

  it('sends the link of every kind to the shop, for a merchant rank and for a retail rank', async () => {
    const cases: Array<[string, 'merchant' | 'retail', string, string]> = [
      ['merchant.invited', 'merchant', 'invite', '/set-password'],
      ['merchant.password_reset', 'merchant', 'reset', '/set-password'],
      ['merchant.email_verification', 'merchant', 'verify_email', '/verify-email'],
      ['customer.invited', 'retail', 'invite', '/set-password'],
      ['customer.password_reset', 'retail', 'reset', '/set-password'],
      ['customer.email_verification', 'retail', 'verify_email', '/verify-email'],
      ['customer.magic_link', 'retail', 'magic_link', '/sign-in'],
    ];
    for (const [type, rankKind, purpose, path] of cases) {
      f.state.account = account({ rankKind });
      f.state.link = link({ purpose });
      expect(await f.jobs.handle(type, jobOf(type))).toEqual({ sent: true });
      expect(f.sent.at(-1)?.link, type).toBe(`https://shop.example.com${path}?token=clear-token`);
      expect(f.sent.at(-1)?.event).toBe(type);
    }
    expect(f.sent).toHaveLength(cases.length);
  });

  it('greets a merchant rank by merchantName and a retail rank by customerName, and tells when the link ends', async () => {
    f.state.account = account({ rankKind: 'merchant', name: 'Zain' });
    await f.jobs.handle('merchant.invited', jobOf('merchant.invited'));
    expect(f.sent.at(-1)?.variables).toEqual({ merchantName: 'Zain', expiresAt: '2026-11-24 11:00 UTC' });
    f.state.account = account({ rankKind: 'retail', name: 'Sam' });
    await f.jobs.handle('customer.invited', jobOf('customer.invited'));
    expect(f.sent.at(-1)?.variables).toEqual({ customerName: 'Sam', expiresAt: '2026-11-24 11:00 UTC' });
  });

  it('sends nothing to an account that is gone, suspended, blocked or anonymized', async () => {
    const wanted: Array<[string | undefined, AccountMailJobResult['skipped']]> = [
      [undefined, 'account_gone'],
      ['anonymized', 'account_gone'],
      ['suspended', 'account_not_active'],
      ['blocked', 'account_not_active'],
    ];
    for (const [status, skipped] of wanted) {
      f.state.account = status === undefined ? undefined : account({ status: status as AccountRecord['status'] });
      expect(await f.jobs.handle('customer.invited', jobOf('customer.invited'))).toEqual({ sent: false, skipped });
    }
    expect(f.reads.rotations).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it('sends nothing when the rank kind changed after the mail was queued', async () => {
    f.state.account = account({ rankKind: 'merchant' });
    expect(await f.jobs.handle('customer.invited', jobOf('customer.invited'))).toEqual({
      sent: false,
      skipped: 'rank_changed',
    });
    f.state.account = account({ rankKind: 'retail' });
    expect(await f.jobs.handle('merchant.invited', jobOf('merchant.invited'))).toEqual({
      sent: false,
      skipped: 'rank_changed',
    });
    expect(f.sent).toEqual([]);
  });

  it('sends a merchant mail queued before the cut-over: the merchant is the aggregate and the payload names the link only', async () => {
    f.state.account = account({ rankKind: 'merchant' });
    const old = jobOf('merchant.invited', { aggregateType: 'clients', aggregateId: 7, payload: { tokenId: 5 } });
    expect(await f.jobs.handle('merchant.invited', old)).toEqual({ sent: true });
    expect(f.sent).toHaveLength(1);
  });

  it('does not spoil a link that arrived: a repeat after a sent or failed mail rotates nothing', async () => {
    f.state.earlier = 'sent';
    expect(await f.jobs.handle('customer.invited', jobOf('customer.invited'))).toEqual({
      sent: false,
      skipped: 'already_sent',
    });
    f.state.earlier = 'failed';
    expect(await f.jobs.handle('customer.invited', jobOf('customer.invited'))).toEqual({
      sent: false,
      skipped: 'already_failed',
    });
    expect(f.reads.rotations).toBe(0);
    expect(f.abandoned).toEqual([]);
  });
});
