// Integration tests of the admin customer actions (feature 14b, POST /admin/customers/:id/account, /password, /sessions/revoke,
// /suspend and /reactivate; scenario b2c-account steps 6, 7 and 9): the states each action needs, the refusals, the sessions it ends,
// and the audit row each one writes without any password.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { PasswordHasher } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import { auditOfCustomer } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import {
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
  makeCustomer,
} from '../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
});
afterEach(() => mock.restore());

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const post = (staff: Staff, url: string, payload?: unknown) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: staff.session.mutationHeaders,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const staffWith = (...permissions: string[]) => signInStaff(t, permissions);
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
const store = (ip = '127.0.0.1') => new StoreClient(t, ip);
const liveSessions = async (customerId: number) => {
  const { db } = await testDb();
  const sessions = await db.select().from(s.sessions).where(eq(s.sessions.subjectId, customerId));
  return sessions.filter((session) => session.subjectType === 'customer' && session.revokedAt === null);
};

describe('POST /admin/customers/:id/account', () => {
  it('turns a guest into an account with an invitation link, keeping the earlier orders, and audits it', async () => {
    const guest = await makeCustomer(t, { guest: true, name: 'Sofia Alvarez' });
    const staff = await staffWith('customers:update');
    const res = await post(staff, `/admin/customers/${guest.id}/account`, { mode: 'reset_link' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({});
    expect(await customerRow(guest.id)).toMatchObject({ hasAccount: true });
    const { db } = await testDb();
    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({ customerId: guest.id, passwordHash: null, mustChangePassword: false });
    expect(customerLinks()).toMatchObject([{ kind: 'invited', customerId: guest.id }]);
    const [audit] = await auditOfCustomer(db, guest.id);
    expect(audit).toMatchObject({
      action: 'created account for',
      entityLabel: 'Sofia Alvarez',
      before: { account: 'guest' },
      after: { account: 'account', credential: 'invite link emailed' },
    });
  });

  it('answers a temporary password once for the temporary mode, and the customer must change it at the first sign-in', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const staff = await staffWith('customers:update');
    const res = await post(staff, `/admin/customers/${guest.id}/account`, { mode: 'temporary_password' });
    const { temporaryPassword } = res.json<{ temporaryPassword: string }>();
    expect(temporaryPassword).toHaveLength(14);
    expect(customerLinks()).toEqual([]);
    const { db } = await testDb();
    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({ mustChangePassword: true });
    expect(await t.app.get(PasswordHasher).verify(credentials!.passwordHash!, temporaryPassword)).toBe(true);
    expect((await store().login(guest.email, temporaryPassword)).json()).toEqual({ next: 'password' });
    const [audit] = await auditOfCustomer(db, guest.id);
    expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
  });

  it('refuses a customer who has an account (409), an anonymized or unknown one, and a missing or unknown mode (422)', async () => {
    const account = await makeCustomer(t);
    const anonymized = await makeCustomer(t, { guest: true, status: 'anonymized' });
    const guest = await makeCustomer(t, { guest: true });
    const staff = await staffWith('customers:update');
    const exists = await post(staff, `/admin/customers/${account.id}/account`, { mode: 'reset_link' });
    expect(exists.statusCode).toBe(409);
    expect(problem(exists).code).toBe('ACCOUNT_EXISTS');
    expect(problem(await post(staff, `/admin/customers/${anonymized.id}/account`, { mode: 'reset_link' })).code).toBe(
      'ANONYMIZED',
    );
    expect((await post(staff, '/admin/customers/999999/account', { mode: 'reset_link' })).statusCode).toBe(404);
    for (const body of [{}, { mode: 'sms' }]) {
      const res = await post(staff, `/admin/customers/${guest.id}/account`, body);
      expect(res.statusCode).toBe(422);
      expect(problem(res).errors?.map((e) => e.field)).toEqual(['mode']);
    }
    expect((await customerRow(guest.id)).hasAccount).toBe(false);
    const reader = await staffWith('customers:read');
    expect((await post(reader, `/admin/customers/${guest.id}/account`, { mode: 'reset_link' })).statusCode).toBe(403);
  });
});

describe('POST /admin/customers/:id/password', () => {
  it('sends a new reset link, replacing the older one, and ends the sessions when asked (scenario step 6)', async () => {
    const customer = await makeCustomer(t, { name: 'Forgetful' });
    const phone = store();
    await phone.login(customer.email);
    const staff = await staffWith('customers:password');
    const first = await post(staff, `/admin/customers/${customer.id}/password`, {
      mode: 'reset_link',
      revokeSessions: false,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({});
    expect((await phone.me()).statusCode).toBe(200);

    const second = await post(staff, `/admin/customers/${customer.id}/password`, {
      mode: 'reset_link',
      revokeSessions: true,
    });
    expect(second.statusCode).toBe(200);
    expect((await phone.me()).statusCode).toBe(401);
    expect(await liveSessions(customer.id)).toHaveLength(0);

    const [older, newer] = customerLinks();
    expect(older).toMatchObject({ kind: 'password_reset' });
    expect((await store().setPassword(older!.token, 'a-much-longer-passphrase')).statusCode).toBe(410);
    expect((await store().setPassword(newer!.token, 'a-much-longer-passphrase')).statusCode).toBe(204);

    const { db } = await testDb();
    const audits = await auditOfCustomer(db, customer.id);
    expect(audits.at(-1)).toMatchObject({
      action: 'sent a password reset link to',
      entityLabel: 'Forgetful',
      after: { credential: 'reset link emailed, valid for 1 hour' },
    });
    expect(JSON.stringify(audits)).not.toContain(newer!.token);
  });

  it('sets a temporary password that voids outstanding links and must be changed, and never writes it to the audit log', async () => {
    const customer = await makeCustomer(t);
    const staff = await staffWith('customers:password');
    await post(staff, `/admin/customers/${customer.id}/password`, { mode: 'reset_link', revokeSessions: false });
    const [link] = customerLinks();
    const res = await post(staff, `/admin/customers/${customer.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const { temporaryPassword } = res.json<{ temporaryPassword: string }>();
    // The older link must not undo the temporary password.
    expect((await store().setPassword(link!.token, 'a-much-longer-passphrase')).statusCode).toBe(410);
    expect((await store().login(customer.email, temporaryPassword)).json()).toEqual({ next: 'password' });
    expect((await store().login(customer.email)).statusCode).toBe(401);
    const { db } = await testDb();
    const audits = await auditOfCustomer(db, customer.id);
    expect(audits.at(-1)).toMatchObject({
      action: 'set a temporary password for',
      after: { credential: 'temporary password set, change required at next sign-in' },
    });
    expect(JSON.stringify(audits)).not.toContain(temporaryPassword);
  });

  it('clears the lock of an account whose customer asked staff for help', async () => {
    const customer = await makeCustomer(t);
    // Every try comes from a new address, so the lock of the email (not the per-address limit) is what refuses.
    for (let i = 0; i < 10; i++) await store(freshClientIp()).login(customer.email, 'wrong-password');
    expect((await store(freshClientIp()).login(customer.email)).statusCode).toBe(429);
    const staff = await staffWith('customers:password');
    const res = await post(staff, `/admin/customers/${customer.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    const { temporaryPassword } = res.json<{ temporaryPassword: string }>();
    expect((await store(freshClientIp()).login(customer.email, temporaryPassword)).statusCode).toBe(200);
  });

  it('refuses a guest (NO_ACCOUNT), an anonymized and an unknown customer, a bad mode, and a caller without customers:password', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const anonymized = await makeCustomer(t, { status: 'anonymized', hasAccount: false });
    const account = await makeCustomer(t);
    const staff = await staffWith('customers:password');
    const noAccount = await post(staff, `/admin/customers/${guest.id}/password`, {
      mode: 'reset_link',
      revokeSessions: false,
    });
    expect(noAccount.statusCode).toBe(409);
    expect(problem(noAccount).code).toBe('NO_ACCOUNT');
    expect(problem(await post(staff, `/admin/customers/${anonymized.id}/password`, { mode: 'reset_link' })).code).toBe(
      'ANONYMIZED',
    );
    expect((await post(staff, '/admin/customers/999999/password', { mode: 'reset_link' })).statusCode).toBe(404);
    const bad = await post(staff, `/admin/customers/${account.id}/password`, { mode: 'carrier-pigeon' });
    expect(bad.statusCode).toBe(422);
    expect(problem(bad).errors?.map((e) => e.field)).toEqual(['mode']);
    const other = await staffWith('customers:update');
    expect((await post(other, `/admin/customers/${account.id}/password`, { mode: 'reset_link' })).statusCode).toBe(403);
  });
});

describe('POST /admin/customers/:id/sessions/revoke', () => {
  it('signs the customer out of every device and audits how many sessions ended', async () => {
    const customer = await makeCustomer(t, { name: 'Two Devices' });
    const phone = store();
    const laptop = store();
    await phone.login(customer.email);
    await laptop.login(customer.email);
    const staff = await staffWith('customers:password');
    const res = await post(staff, `/admin/customers/${customer.id}/sessions/revoke`);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await phone.me()).statusCode).toBe(401);
    expect((await laptop.me()).statusCode).toBe(401);
    const { db } = await testDb();
    expect((await auditOfCustomer(db, customer.id))[0]).toMatchObject({
      action: 'signed out all devices of',
      entityLabel: 'Two Devices',
      before: { sessions: 2 },
      after: { sessions: 0 },
    });
    // Nothing to end is still a valid, audited action.
    expect((await post(staff, `/admin/customers/${customer.id}/sessions/revoke`)).statusCode).toBe(204);
  });

  it('refuses an unknown or anonymized customer and a caller without customers:password', async () => {
    const anonymized = await makeCustomer(t, { status: 'anonymized', hasAccount: false });
    const staff = await staffWith('customers:password');
    expect((await post(staff, '/admin/customers/999999/sessions/revoke')).statusCode).toBe(404);
    expect(problem(await post(staff, `/admin/customers/${anonymized.id}/sessions/revoke`)).code).toBe('ANONYMIZED');
    const other = await staffWith('customers:update');
    expect((await post(other, `/admin/customers/${anonymized.id}/sessions/revoke`)).statusCode).toBe(403);
  });
});

describe('POST /admin/customers/:id/suspend and /reactivate', () => {
  it('suspends: status, who and when, the reason with its note, every session ended, and nothing added to the blocklist (step 7)', async () => {
    const customer = await makeCustomer(t, { name: 'Compromised' });
    const phone = store();
    await phone.login(customer.email);
    const staff = await staffWith('customers:suspend');
    const res = await post(staff, `/admin/customers/${customer.id}/suspend`, {
      reason: 'Account may be compromised',
      note: ' Customer called support. ',
    });
    expect(res.statusCode).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'suspended',
      suspendedAt: new Date('2026-11-07T10:00:00.000Z'),
      suspendedBy: staff.staffId,
      suspendedReason: 'Account may be compromised: Customer called support.',
    });
    expect(await liveSessions(customer.id)).toHaveLength(0);
    expect((await phone.me()).statusCode).toBe(401);
    const { db } = await testDb();
    expect(await db.select().from(s.blocklistEntries)).toHaveLength(0);
    expect((await auditOfCustomer(db, customer.id))[0]).toMatchObject({
      action: 'suspended account of',
      entityLabel: 'Compromised',
      before: { status: 'active', sessions: 1 },
      after: { status: 'suspended', reason: 'Account may be compromised: Customer called support.', sessions: 0 },
    });
  });

  it('keeps the suspended customer out (ACCOUNT_SUSPENDED) until reactivation, which clears the reason and lets them in again (steps 8, 9)', async () => {
    const customer = await makeCustomer(t);
    const staff = await staffWith('customers:suspend');
    await post(staff, `/admin/customers/${customer.id}/suspend`, { reason: 'Other' });
    expect(await customerRow(customer.id)).toMatchObject({ suspendedReason: 'Other' });
    const blockedLogin = await store().login(customer.email);
    expect(blockedLogin.statusCode).toBe(403);
    expect(problem(blockedLogin).code).toBe('ACCOUNT_SUSPENDED');
    const link = await store().magicLink(customer.email);
    expect(link.statusCode).toBe(204);
    expect(customerLinks()).toEqual([]);

    const res = await post(staff, `/admin/customers/${customer.id}/reactivate`);
    expect(res.statusCode).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'active',
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
    });
    expect((await store().login(customer.email)).statusCode).toBe(200);
    const { db } = await testDb();
    expect((await auditOfCustomer(db, customer.id)).at(-1)).toMatchObject({
      action: 'reactivated account of',
      before: { status: 'suspended' },
      after: { status: 'active' },
    });
  });

  it('refuses suspending a customer who is not active (409 NOT_ACTIVE) and reactivating one who is not suspended (409 NOT_SUSPENDED)', async () => {
    const active = await makeCustomer(t);
    const suspended = await makeCustomer(t, { status: 'suspended' });
    const blocked = await makeCustomer(t, { status: 'blocked' });
    const staff = await staffWith('customers:suspend');
    for (const customer of [suspended, blocked]) {
      const res = await post(staff, `/admin/customers/${customer.id}/suspend`, { reason: 'Other' });
      expect(res.statusCode).toBe(409);
      expect(problem(res).code).toBe('NOT_ACTIVE');
    }
    for (const customer of [active, blocked]) {
      const res = await post(staff, `/admin/customers/${customer.id}/reactivate`);
      expect(res.statusCode).toBe(409);
      expect(problem(res).code).toBe('NOT_SUSPENDED');
    }
    expect((await customerRow(blocked.id)).status).toBe('blocked');
  });

  it('refuses a missing or unknown reason (422 on reason), an anonymized or unknown customer, and a caller without customers:suspend', async () => {
    const customer = await makeCustomer(t);
    const anonymized = await makeCustomer(t, { status: 'anonymized', hasAccount: false });
    const staff = await staffWith('customers:suspend');
    for (const body of [{}, { reason: 'Because I said so' }, { reason: 'Other', note: 'n'.repeat(201) }]) {
      const res = await post(staff, `/admin/customers/${customer.id}/suspend`, body);
      expect(res.statusCode).toBe(422);
      expect(problem(res).errors?.[0]?.field).toBe(body.note ? 'note' : 'reason');
    }
    expect(problem(await post(staff, `/admin/customers/${anonymized.id}/suspend`, { reason: 'Other' })).code).toBe(
      'ANONYMIZED',
    );
    expect(problem(await post(staff, `/admin/customers/${anonymized.id}/reactivate`)).code).toBe('ANONYMIZED');
    expect((await post(staff, '/admin/customers/999999/suspend', { reason: 'Other' })).statusCode).toBe(404);
    expect((await customerRow(customer.id)).status).toBe('active');
    const other = await staffWith('customers:update');
    expect((await post(other, `/admin/customers/${customer.id}/suspend`, { reason: 'Other' })).statusCode).toBe(403);
    expect((await post(other, `/admin/customers/${customer.id}/reactivate`)).statusCode).toBe(403);
  });

  it('lets only one of two parallel suspensions through', async () => {
    const customer = await makeCustomer(t);
    const staff = await staffWith('customers:suspend');
    const results = await Promise.all([
      post(staff, `/admin/customers/${customer.id}/suspend`, { reason: 'Other' }),
      post(staff, `/admin/customers/${customer.id}/suspend`, { reason: 'Other' }),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 409]);
    const { db } = await testDb();
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(1);
  });
});
