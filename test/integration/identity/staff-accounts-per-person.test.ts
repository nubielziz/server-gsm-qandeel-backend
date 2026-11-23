// Integration tests of the money rules of decision 049 that count per staff member (the daily limit of manual credits, and the
// payment of a manual invoice approved by someone other than its issuer), through the real console sign-in: a staff member who
// is not an Owner cannot add, take over the sign-in of, or move into such a role, an account, nor give such a permission to a role
// somebody holds; an Owner can, and that account then counts as a person of its own.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, clearRateLimits, insertRole, insertStaff } from '../../support/auth';
import { insertGateway, insertPendingPayment, insertProofFile } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN, StaffConsole, codeFor } from '../../support/staff-console';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: CONSOLE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits(t);
});

const staffCount = async () => (await (await testDb()).db.select().from(s.staffUsers)).length;

/** Asks for a new member with the caller's own role, both ways a first password can be given. */
async function addWithOwnRole(api: AdminApi): Promise<number[]> {
  const statuses: number[] = [];
  for (const onboarding of ['temporary_password', 'invite'] as const) {
    const res = await api.post('/admin/staff', {
      name: 'Second Member',
      email: `second.${onboarding}@example.com`,
      roleId: api.roleId,
      onboarding,
    });
    expect(res.body.temporaryPassword).toBeUndefined();
    statuses.push(res.status);
  }
  return statuses;
}

/** A member signs in through the console with a temporary password: a password of their own, their own authenticator. */
async function signedIn(email: string, temporaryPassword: string): Promise<StaffConsole> {
  const first = new StaffConsole(t, freshClientIp());
  expect((await first.login(email, temporaryPassword)).json()).toEqual({ next: 'password' });
  expect((await first.setPassword({ password: 'violet-harbor-lantern-73' })).statusCode).toBe(204);
  const c = new StaffConsole(t, freshClientIp());
  expect((await c.login(email, 'violet-harbor-lantern-73')).json()).toEqual({ next: 'totp_setup' });
  const setup = await c.setup();
  expect(setup.statusCode).toBe(200);
  expect((await c.code(await codeFor(setup.json().secret as string, clock.nowMs()))).statusCode).toBe(204);
  return c;
}

/** A caller adds a member with a role by temporary password, and the member signs in. */
async function addedBy(
  caller: AdminApi,
  roleId: number,
  email: string,
): Promise<{ console: StaffConsole; id: number }> {
  const created = await caller.post('/admin/staff', {
    name: 'Colleague',
    email,
    roleId,
    onboarding: 'temporary_password',
  });
  expect(created.status).toBe(201);
  return { console: await signedIn(email, created.body.temporaryPassword as string), id: created.body.id as number };
}

/** An Owner adds a member with a role and the member signs in through the console (password, own authenticator). */
async function addedByOwner(owner: AdminApi, roleId: number): Promise<{ console: StaffConsole; id: number }> {
  return addedBy(owner, roleId, 'colleague@example.com');
}

const GIVE_ROLE_DETAIL =
  'Only an owner can give a member a role that can adjust wallets, set credit limits, approve payments or issue invoices.';
const HELD_ROLE_DETAIL =
  'Only an owner can give a role that staff members hold the right to adjust wallets, set credit limits, approve payments or ' +
  'issue invoices.';
const credit = (amount: string) => ({ amount, direction: 'credit', reason: 'Goodwill' });

/** Credits the merchant up to the caller's daily limit, then shows that the next credit needs an Owner. */
async function creditToLimit(api: AdminApi, url: string): Promise<void> {
  expect((await api.post(url, credit('10000.0000'))).status).toBe(200);
  const capped = await api.post(url, credit('10000.0000'));
  expect(capped.status).toBe(409);
  expect(capped.body.code).toBe('APPROVAL_REQUIRED');
}

const roleOf = async (staffId: number) =>
  (await (await testDb()).db.select().from(s.staffUsers).where(eq(s.staffUsers.id, staffId)))[0]!.roleId;
const balanceOf = async (api: AdminApi, merchantId: number) =>
  (await api.get(`/admin/clients/${merchantId}/wallet`)).body.balance as string;

describe('the daily limit of manual credits counts per person', () => {
  it('a member at the limit cannot add an account with their role; an account an Owner added credits on its own limit', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    const member = await adminWith(t, ['wallet:adjust', 'wallet:read', 'staff:create', 'staff:read']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    const body = (amount: string) => ({ amount, direction: 'credit', reason: 'Goodwill' });

    expect((await member.post(url, body('10000.0000'))).status).toBe(200);
    const capped = await member.post(url, body('10000.0000'));
    expect(capped.status).toBe(409);
    expect(capped.body.code).toBe('APPROVAL_REQUIRED');

    const before = await staffCount();
    expect(await addWithOwnRole(member)).toEqual([403, 403]);
    expect(await staffCount()).toBe(before);

    const owner = await adminWith(t, ['*'], { name: 'Owner' });
    const colleague = await addedByOwner(owner, member.roleId);
    const credited = await colleague.console.call('POST', url, body('10000.0000'));
    expect(credited.statusCode).toBe(200);
    expect(credited.json().wallet.balance).toBe('20000.0000');
  });

  it('a member cannot set a temporary password for, or change the email of, a colleague with their role', async () => {
    const { db } = await testDb();
    const member = await adminWith(t, ['wallet:adjust', 'wallet:read', 'staff:update', 'staff:read']);
    const colleague = await insertStaff(db, member.roleId, {
      email: 'colleague@example.com',
      passwordHash: 'old-hash',
    });

    const temporary = await member.post(`/admin/staff/${colleague}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(temporary.status).toBe(403);
    expect(temporary.body.temporaryPassword).toBeUndefined();
    const moved = await member.patch(`/admin/staff/${colleague}`, { email: 'second@example.com' });
    expect(moved.status).toBe(403);
    const [row] = await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, colleague));
    expect(row).toMatchObject({ email: 'colleague@example.com', passwordHash: 'old-hash' });
  });

  it('a member at the limit cannot move an account they added with another role into their role', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    const member = await adminWith(t, ['wallet:adjust', 'wallet:read', 'staff:create', 'staff:update', 'staff:read']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    await creditToLimit(member, url);

    const readers = await insertRole(db, ['wallet:read'], 'Readers');
    const second = await addedBy(member, readers, 'second@example.com');
    const moved = await member.patch(`/admin/staff/${second.id}`, { roleId: member.roleId });
    expect(moved.status).toBe(403);
    expect(moved.body.code).toBe('FORBIDDEN');
    expect(moved.body.detail).toBe(GIVE_ROLE_DETAIL);
    expect(await roleOf(second.id)).toBe(readers);
    expect((await second.console.call('POST', url, credit('10000.0000'))).statusCode).toBe(403);
    expect(await balanceOf(member, merchant.id)).toBe('10000.0000');
  });

  it('a member at the limit cannot move a colleague they set a temporary password for into their role', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    const member = await adminWith(t, ['wallet:adjust', 'wallet:read', 'staff:update', 'staff:read']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    await creditToLimit(member, url);

    const readers = await insertRole(db, ['wallet:read'], 'Readers');
    const colleague = await insertStaff(db, readers, { email: 'colleague@example.com', passwordHash: 'old-hash' });
    const temporary = await member.post(`/admin/staff/${colleague}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    expect(temporary.status).toBe(200);
    const moved = await member.patch(`/admin/staff/${colleague}`, { roleId: member.roleId });
    expect(moved.status).toBe(403);
    expect(moved.body.detail).toBe(GIVE_ROLE_DETAIL);
    expect(await roleOf(colleague)).toBe(readers);
    const signed = await signedIn('colleague@example.com', temporary.body.temporaryPassword as string);
    expect((await signed.call('POST', url, credit('10000.0000'))).statusCode).toBe(403);
    expect(await balanceOf(member, merchant.id)).toBe('10000.0000');
  });

  it('a member at the limit cannot give the credit permission to a role held by an account they added', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    const member = await adminWith(t, [
      'wallet:adjust',
      'wallet:read',
      'staff:create',
      'staff:read',
      'roles:create',
      'roles:update',
      'roles:read',
    ]);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    await creditToLimit(member, url);

    const role = await member.post('/admin/roles', { name: 'Readers', permissions: ['wallet:read'] });
    expect(role.status).toBe(201);
    const second = await addedBy(member, role.body.id as number, 'second@example.com');
    const edited = await member.patch(`/admin/roles/${role.body.id}`, {
      permissions: ['wallet:read', 'wallet:adjust'],
    });
    expect(edited.status).toBe(403);
    expect(edited.body.code).toBe('FORBIDDEN');
    expect(edited.body.detail).toBe(HELD_ROLE_DETAIL);
    const [row] = await db
      .select()
      .from(s.roles)
      .where(eq(s.roles.id, role.body.id as number));
    expect(row!.permissions).toEqual(['wallet:read']);
    expect((await second.console.call('POST', url, credit('10000.0000'))).statusCode).toBe(403);
    expect(await balanceOf(member, merchant.id)).toBe('10000.0000');
  });
});

describe('the payment of a manual invoice is approved by another person', () => {
  it('the issuer cannot add an account with their role to approve it; a member an Owner added can', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, merchant.id));
    const bank = await insertGateway(t, db, { name: 'Bank transfer', isManual: true });
    const issuer = await adminWith(t, [
      'invoices:create',
      'payments:approve',
      'payments:read',
      'staff:create',
      'staff:read',
    ]);
    const issued = await issuer.post('/admin/invoices', {
      clientId: merchant.id,
      amount: '5000',
      description: 'Support',
    });
    expect(issued.status).toBe(201);
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, issued.body.id));
    const payment = await insertPendingPayment(db, invoice!, bank, {
      receiptFileId: await insertProofFile(db, merchant.id),
    });
    expect((await issuer.post(`/admin/payments/${payment.id}/approve`)).status).toBe(403);

    const before = await staffCount();
    expect(await addWithOwnRole(issuer)).toEqual([403, 403]);
    expect(await staffCount()).toBe(before);
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]!.status).toBe('pending');

    const owner = await adminWith(t, ['*'], { name: 'Owner' });
    const colleague = await addedByOwner(owner, issuer.roleId);
    const approved = await colleague.console.call('POST', `/admin/payments/${payment.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]!.status).toBe('approved');
  });

  it('the issuer cannot move an account they added with another role into their role to approve it', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Harbor Ltd' });
    await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, merchant.id));
    const bank = await insertGateway(t, db, { name: 'Bank transfer', isManual: true });
    const issuer = await adminWith(t, [
      'invoices:create',
      'payments:approve',
      'payments:read',
      'staff:create',
      'staff:update',
      'staff:read',
    ]);
    const issued = await issuer.post('/admin/invoices', {
      clientId: merchant.id,
      amount: '5000',
      description: 'Support',
    });
    expect(issued.status).toBe(201);
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, issued.body.id));
    const payment = await insertPendingPayment(db, invoice!, bank, {
      receiptFileId: await insertProofFile(db, merchant.id),
    });

    const readers = await insertRole(db, ['payments:read'], 'Readers');
    const second = await addedBy(issuer, readers, 'second@example.com');
    const moved = await issuer.patch(`/admin/staff/${second.id}`, { roleId: issuer.roleId });
    expect(moved.status).toBe(403);
    expect(moved.body.detail).toBe(GIVE_ROLE_DETAIL);
    expect((await second.console.call('POST', `/admin/payments/${payment.id}/approve`)).statusCode).toBe(403);
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]!.status).toBe('pending');
  });
});
