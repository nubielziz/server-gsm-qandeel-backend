// Integration tests of the staff create of an account (POST /admin/clients, decision 064): a retail account by default, a merchant rank for the
// Owner only, the email rule of the two partitions, the two ways of giving a password, the checks other modules registered, the wallet of a
// merchant rank, and the second permissions (decisions 046, 047, 049), through HTTP on the real application.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AppError } from '@src/common/errors';
import { schema as s } from '@src/infra/db';
import { AccountCreateGuards } from '@src/modules/identity';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';

const clock = new TestClock();
let t: TestApp;
const CALLER_IP = '203.0.113.50';
const BLOCKED_EMAIL = 'blocked@example.com';

beforeAll(async () => {
  t = await createTestApp({ clock });
  // The checks of other modules join the create by registering (the blocklist does it at boot); this one stands in for them.
  t.app.get(AccountCreateGuards).register('accounts-create-spec', (_tx, facts) => {
    if (facts.email === BLOCKED_EMAIL) {
      return Promise.reject(
        new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'email', code: 'blocked', message: 'This email is blocked.' }],
        }),
      );
    }
    return Promise.resolve();
  });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
  captureAccountLinks(t);
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const accountRows = async () => (await testDb()).db.select().from(s.clients).orderBy(s.clients.id);
const outboxRows = async () => (await testDb()).db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);
const ledgerRowsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'account'), eq(s.ledgerAccounts.ownerId, accountId)))
    .orderBy(s.ledgerAccounts.kind);
};
const tokensOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, accountId)));
};

/** A standard merchant rank (the default one, no credit), a VIP one (with credit), the retail rank, and the shop's tax windows. */
async function ranks() {
  const { db } = await testDb();
  await insertUsd(db);
  const [standard, vip] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, discountPercent: '0' },
      { name: 'VIP', discountPercent: '8', overdraftAllowed: true },
    ])
    .returning({ id: s.clientGroups.id });
  const retail = await ensureRetailGroup(db);
  await insertTaxRates(db, ['GB', 'DE']);
  return { standard: standard!.id, vip: vip!.id, retail };
}

/** An Owner (holds `*`, so every second permission too) who calls from {@link CALLER_IP}. */
const owner = () => adminWith(t, ['*'], { name: 'Rami K.', ip: CALLER_IP });
/** A staff member who may create accounts and read them, and holds no second permission. */
const creator = () => adminWith(t, ['clients:read', 'clients:create'], { name: 'Lina S.', ip: CALLER_IP });

const create = (api: AdminApi, body: Record<string, unknown> = {}) =>
  api.post('/admin/clients', {
    name: 'Zain Mobile Hub',
    email: 'ops@zainmobilehub.example',
    country: 'DE',
    ...body,
  });

describe('POST /admin/clients: a retail account', () => {
  it('makes a retail account when no rank is sent: active at once, no username, no wallet, the creator on the row', async () => {
    const { retail } = await ranks();
    const lina = await creator();
    const res = await create(lina, { name: '  Mina   Saleh ', email: ' Mina@Example.com ', phone: '+49 30 1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(Number));
    const row = await accountRow(res.body.id);
    expect(row).toMatchObject({
      name: 'Mina Saleh',
      email: 'mina@example.com',
      phone: '+49 30 1',
      country: 'DE',
      groupId: retail,
      status: 'active',
      hasAccount: true,
      username: null,
      createdBy: lina.staffId,
      createdAt: clock.now(),
      passwordHash: null,
      mustChangePassword: false,
      emailVerifiedAt: null,
    });
    // No wallet is opened for a retail account: it is opened when first needed.
    expect(await ledgerRowsOf(row.id)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totp/i);
  });

  it('sends the invitation: a one-hour link (hash only) and a mail event of ids only, written with the account', async () => {
    await ranks();
    const lina = await creator();
    const res = await create(lina);
    const [token, ...others] = await tokensOf(res.body.id);
    expect(others).toHaveLength(0);
    expect(token).toMatchObject({
      purpose: 'invite',
      usedAt: null,
      createdBy: lina.staffId,
      ip: CALLER_IP,
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accountLinks()).toEqual([{ kind: 'invited', accountId: res.body.id, token: expect.any(String) }]);
    const mails = (await outboxRows()).filter((row) => (row.payload as { tokenId?: number }).tokenId === token!.id);
    expect(mails).toHaveLength(1);
    const payload = JSON.stringify(mails[0]!.payload);
    expect(payload).not.toContain(token!.tokenHash);
    expect(payload).not.toContain('ops@zainmobilehub.example');
  });

  it('audits the create under the word account, without any secret', async () => {
    const { retail } = await ranks();
    const rami = await owner();
    const res = await create(rami);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'created account',
      entityType: 'account',
      entityId: res.body.id,
      entityLabel: 'Zain Mobile Hub',
      actorId: rami.staffId,
      actorName: 'Rami K.',
      ip: CALLER_IP,
    });
    expect(audit!.after).toMatchObject({
      email: 'ops@zainmobilehub.example',
      country: 'DE',
      status: 'active',
      rank: { id: retail, kind: 'retail' },
      credential: 'invitation emailed',
    });
    const [token] = await tokensOf(res.body.id);
    expect(JSON.stringify(audit)).not.toContain(token!.tokenHash);
  });

  it('refuses a company and a credit limit on a retail account, on the key itself, and writes nothing', async () => {
    await ranks();
    const lina = await creator();
    for (const key of ['company', 'creditLimit'] as const) {
      const res = await create(lina, { [key]: key === 'company' ? 'Zain' : '10.0000' });
      expect(res.status, key).toBe(422);
      expect(res.body.errors[0].field, key).toBe(key);
    }
    expect(await accountRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a country the shop does not sell to (422 on country, no tax window in force) and accepts one it does', async () => {
    await ranks();
    const lina = await creator();
    const refused = await create(lina, { country: 'JO' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'country', code: 'unsupported' });
    expect(await accountRows()).toHaveLength(0);
    // The currency of a country the shop has no currency for is the base currency.
    const accepted = await create(lina, { country: 'de' });
    expect(accepted.status).toBe(201);
    expect((await accountRow(accepted.body.id)).currency).toBe('USD');
  });

  it('accepts any listed country while no tax window is in force, and still refuses a code of no country (decision 079, B1)', async () => {
    await ranks();
    const lina = await creator();
    const { db } = await testDb();
    await db.delete(s.taxRates);
    for (const country of ['ZZ', 'UK', 'EU']) {
      const refused = await create(lina, { country });
      expect(refused.status, country).toBe(422);
      expect(refused.body.errors[0], country).toMatchObject({ field: 'country', code: 'unsupported' });
    }
    expect(await accountRows()).toHaveLength(0);
    const accepted = await create(lina, { country: 'jo' });
    expect(accepted.status).toBe(201);
    expect((await accountRow(accepted.body.id)).country).toBe('JO');
  });

  it('refuses an email a blocklist check names (422 on email) before anything is written', async () => {
    await ranks();
    const lina = await creator();
    const res = await create(lina, { email: BLOCKED_EMAIL });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'blocked' });
    expect(await accountRows()).toHaveLength(0);
    expect(await (await testDb()).db.select().from(s.authTokens)).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('POST /admin/clients: the email rule of the two partitions', () => {
  it('refuses an email a row with a login holds, in any case, for either rank (409 EMAIL_TAKEN, code taken)', async () => {
    const { vip } = await ranks();
    const rami = await owner();
    const retail = await makeAccount(t, { rank: 'retail', email: 'taken@example.com' });
    const merchant = await makeAccount(t, { rank: 'merchant', email: 'shop@example.com' });
    for (const [email, extra] of [
      ['TAKEN@example.com', {}],
      ['Shop@Example.com', { groupId: vip }],
    ] as const) {
      const res = await create(rami, { email, ...extra });
      expect(res.status, email).toBe(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
      expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'taken' });
    }
    expect((await accountRows()).map((row) => row.id)).toEqual([retail.id, merchant.id]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("refuses a retail create over a guest's email (code guest: use Make an account) and leaves the guest row alone", async () => {
    await ranks();
    const lina = await creator();
    const guest = await makeAccount(t, { rank: 'retail', guest: true, email: 'buyer@example.com' });
    const before = await accountRow(guest.id);
    const res = await create(lina, { email: 'Buyer@Example.com' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
    expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'guest' });
    expect(await accountRow(guest.id)).toEqual(before);
    expect(await accountRows()).toHaveLength(1);
  });

  it("lets a merchant create over a guest's email, leaves the guest row a guest, and voids that guest row's open sign-in link", async () => {
    const { vip } = await ranks();
    const rami = await owner();
    const guest = await makeAccount(t, { rank: 'retail', guest: true, email: 'buyer@example.com' });
    const { db } = await testDb();
    const [link] = await db
      .insert(s.authTokens)
      .values({
        purpose: 'magic_link',
        subjectType: 'account',
        subjectId: guest.id,
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(clock.nowMs() + HOUR),
      })
      .returning();
    const res = await create(rami, { email: 'buyer@example.com', groupId: vip });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(guest.id);
    expect(await accountRow(guest.id)).toMatchObject({
      hasAccount: false,
      email: 'buyer@example.com',
      passwordHash: null,
    });
    expect(await accountRow(res.body.id)).toMatchObject({ hasAccount: true, email: 'buyer@example.com' });
    const stored = (await tokensOf(guest.id)).find((row) => row.id === link!.id)!;
    expect(stored.usedAt).not.toBeNull();
  });

  it('lets only one of two parallel creates of one email win (the unique index decides)', async () => {
    await ranks();
    const lina = await creator();
    const answers = await Promise.all([
      create(lina, { email: 'race@example.com' }),
      create(lina, { email: 'race@example.com' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(await accountRows()).toHaveLength(1);
  });
});

describe('POST /admin/clients: a temporary password', () => {
  it('needs clients:security as well, and a refused call writes nothing (decision 047)', async () => {
    await ranks();
    const lina = await creator();
    const refused = await create(lina, { password: { mode: 'temporary_password' } });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('You need the clients:security permission to do this.');
    expect(await accountRows()).toHaveLength(0);
    // The link mode needs only the route's own permission.
    expect((await create(lina, { password: { mode: 'reset_link' } })).status).toBe(201);
  });

  it('stores the hash only, forces a change at the first sign-in, holds API keys back, answers the password once with no-store, and sends no link', async () => {
    await ranks();
    const security = await adminWith(t, ['clients:read', 'clients:create', 'clients:security'], { ip: CALLER_IP });
    const res = await create(security, { password: { mode: 'temporary_password' } });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toContain('no-store');
    const password = res.body.temporaryPassword as string;
    expect(password).toHaveLength(14);
    const row = await accountRow(res.body.id);
    expect(row).toMatchObject({ mustChangePassword: true, passwordSetByStaff: true, passwordChangedAt: clock.now() });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain(password);
    expect(await tokensOf(row.id)).toHaveLength(0);
    expect(accountLinks()).toEqual([]);
    const [audit] = await auditRows();
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(audit!.after).toMatchObject({ credential: 'temporary password set' });
  });
});

describe('POST /admin/clients: a merchant rank', () => {
  it('opens the wallet and the hold in the same transaction, generates the username, and takes the credit limit as the wallet limit', async () => {
    const { vip } = await ranks();
    const rami = await owner();
    const res = await create(rami, { groupId: vip, creditLimit: '2000.0000', company: 'Zain', country: 'jo' });
    expect(res.status).toBe(201);
    const row = await accountRow(res.body.id);
    expect(row).toMatchObject({
      groupId: vip,
      username: 'zain-mobile-hub',
      company: 'Zain',
      country: 'JO',
      status: 'active',
      hasAccount: true,
    });
    const [hold, wallet] = await ledgerRowsOf(row.id);
    expect(hold).toMatchObject({ kind: 'client_hold', currency: 'USD', balance: '0.0000', overdraftLimit: '0.0000' });
    expect(wallet).toMatchObject({
      kind: 'client_wallet',
      currency: 'USD',
      balance: '0.0000',
      overdraftLimit: '2000.0000',
    });
    const [audit] = await auditRows();
    expect(audit!.after).toMatchObject({ rank: { id: vip, name: 'VIP', kind: 'merchant' }, creditLimit: '2000.0000' });
  });

  it('gives accounts with the same name distinct Dhru usernames, also when they are created at the same moment', async () => {
    const { standard } = await ranks();
    const rami = await owner();
    const first = await create(rami, { groupId: standard, email: 'a@example.com' });
    const second = await create(rami, { groupId: standard, email: 'b@example.com' });
    expect([first.body.id, second.body.id].every(Number.isInteger)).toBe(true);
    const answers = await Promise.all(
      ['c', 'd', 'e'].map((letter) => create(rami, { groupId: standard, email: `${letter}@example.com` })),
    );
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201]);
    const usernames = (await accountRows()).map((row) => row.username);
    expect(usernames.slice(0, 2)).toEqual(['zain-mobile-hub', 'zain-mobile-hub-2']);
    expect(new Set(usernames).size).toBe(5);
  });

  it('refuses credit on a rank that does not allow it (422 on creditLimit, rule 2) and a negative limit, and writes nothing', async () => {
    const { standard } = await ranks();
    const rami = await owner();
    for (const creditLimit of ['100.0000', '-5.0000']) {
      const res = await create(rami, { groupId: standard, creditLimit });
      expect(res.status, creditLimit).toBe(422);
      expect(res.body.errors[0].field).toBe('creditLimit');
    }
    expect(await accountRows()).toHaveLength(0);
    expect(await (await testDb()).db.select().from(s.ledgerAccounts)).toEqual([]);
  });

  it('refuses an unknown rank (422 on groupId)', async () => {
    await ranks();
    const rami = await owner();
    const res = await create(rami, { groupId: 999_999 });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe('groupId');
    expect(await accountRows()).toHaveLength(0);
  });

  it('needs an Owner for a merchant rank, whatever else the role holds, before anything is written', async () => {
    const { vip } = await ranks();
    const admin = await adminWith(t, ['clients:*', 'groups:*', 'wallet:*'], { ip: CALLER_IP });
    const refused = await create(admin, { groupId: vip });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('Only the Owner gives or changes a rank.');
    expect(await accountRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('lets the Owner give a credit limit above the approval limit of adjustments (decisions 046 and 049: the Owner holds every second permission)', async () => {
    const { vip } = await ranks();
    const rami = await owner();
    const res = await create(rami, { groupId: vip, creditLimit: '900000.0000', email: 'lent@example.com' });
    expect(res.status).toBe(201);
    const wallet = (await ledgerRowsOf(res.body.id)).find((row) => row.kind === 'client_wallet');
    expect(wallet?.overdraftLimit).toBe('900000.0000');
    // Zero credit on a rank with credit is allowed too.
    expect((await create(rami, { groupId: vip, creditLimit: '0.0000', email: 'zero@example.com' })).status).toBe(201);
  });
});

describe('POST /admin/clients: input and access', () => {
  it('needs clients:create and a CSRF token', async () => {
    await ranks();
    const reader = await adminWith(t, ['clients:read'], { ip: CALLER_IP });
    const refused = await create(reader);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('clients:create');
    const lina = await creator();
    const noCsrf = await lina.withoutCsrf('POST', '/admin/clients', {
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'DE',
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await accountRows()).toHaveLength(0);
  });

  it('refuses bad input with the field names the console maps (name, email, country, creditLimit)', async () => {
    await ranks();
    const lina = await creator();
    for (const [key, value] of [
      ['name', '   '],
      ['email', 'not-an-email'],
      ['country', 'GBR'],
    ] as const) {
      const res = await create(lina, { [key]: value });
      expect(res.status, key).toBe(422);
      expect(
        res.body.errors.map((error: { field: string }) => error.field),
        key,
      ).toContain(key);
    }
    expect(await accountRows()).toHaveLength(0);
  });
});
