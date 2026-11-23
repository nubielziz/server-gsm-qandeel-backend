// Integration tests of the staff management routes (feature 2a, scenario admin-team): list and show, add by invitation or
// temporary password, edit, password, end sessions, suspend, reactivate, reset 2FA, and the Owner rules, through HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { PasswordHasher, TokenService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { STAFF_TOKEN_TTL_MS } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { type AdminApi, adminFor, adminWith } from '../../support/admin-api';
import { clearIdentityCaches, insertRole, insertStaff, openSession } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits } from '../../support/identity-mail';

const clock = new TestClock();
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
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
});

const staffRow = async (id: number) => {
  const { db } = await testDb();
  return (await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id)))[0]!;
};
const tokensOf = async (staffId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'staff'), eq(s.authTokens.subjectId, staffId)))
    .orderBy(s.authTokens.id);
};
const sessionsOf = async (staffId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'staff'), eq(s.sessions.subjectId, staffId)))
    .orderBy(s.sessions.id);
};
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

/** An Owner (role with *) and an ordinary role the tests add people to. */
async function owner(): Promise<AdminApi> {
  return adminWith(t, ['*'], { name: 'Rami K.', roleName: 'Owner' });
}
async function roleNamed(name: string, permissions: string[] = ['staff:read']): Promise<number> {
  const { db } = await testDb();
  return insertRole(db, permissions, name);
}

describe('GET /admin/staff and /admin/staff/:id', () => {
  it('lists members with role, creator, suspender, session count and link time; total, filters, search and sort', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const lina = await insertStaff(db, support, {
      name: 'Lina S.',
      email: 'lina@example.com',
      createdBy: rami.staffId,
      lastLoginAt: new Date('2026-10-30T08:00:00.000Z'),
      lastLoginIp: '203.0.113.9',
      twofaEnabled: true,
    });
    const yusuf = await insertStaff(db, support, {
      name: 'Yusuf M.',
      email: 'yusuf@example.com',
      status: 'suspended',
      suspendedAt: new Date('2026-10-31T08:00:00.000Z'),
      suspendedReason: 'On leave: back in December',
      suspendedBy: rami.staffId,
    });
    await openSession(t, { type: 'staff', id: lina });
    await openSession(t, { type: 'staff', id: lina });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_totp' });

    const list = await rami.get('/admin/staff?_start=0&_end=200');
    expect(list.status).toBe(200);
    expect(list.total).toBe(3);
    expect(list.body.map((m: { id: number }) => m.id)).toEqual([rami.staffId, lina, yusuf]);
    const linaRow = list.body.find((m: { id: number }) => m.id === lina);
    expect(linaRow).toMatchObject({
      name: 'Lina S.',
      email: 'lina@example.com',
      role: { id: support, name: 'Support' },
      status: 'active',
      twofaEnabled: true,
      lastLoginIp: '203.0.113.9',
      lastLoginAt: '2026-10-30T08:00:00.000Z',
      // two full sessions; the pre-2FA one does not count
      activeSessions: 2,
      createdBy: { id: rami.staffId, name: 'Rami K.' },
      suspendedBy: null,
      suspendedReason: null,
      resetSentAt: null,
    });
    const yusufRow = list.body.find((m: { id: number }) => m.id === yusuf);
    expect(yusufRow).toMatchObject({
      status: 'suspended',
      suspendedReason: 'On leave: back in December',
      suspendedBy: { id: rami.staffId, name: 'Rami K.' },
      suspendedAt: '2026-10-31T08:00:00.000Z',
      activeSessions: 0,
    });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|totpSecret|password_hash/i);

    expect((await rami.get('/admin/staff?status=suspended')).body.map((m: { id: number }) => m.id)).toEqual([yusuf]);
    expect((await rami.get(`/admin/staff?role.id=${support}`)).total).toBe(2);
    expect((await rami.get(`/admin/staff?id=${lina}&id=${yusuf}`)).total).toBe(2);
    expect((await rami.get('/admin/staff?q=LINA')).body.map((m: { id: number }) => m.id)).toEqual([lina]);
    expect((await rami.get('/admin/staff?q=example.com&_sort=name&_order=desc')).body[0].name).toBe('Yusuf M.');
    expect((await rami.get('/admin/staff?_start=0&_end=1')).body).toHaveLength(1);
    expect((await rami.get('/admin/staff?status=gone')).status).toBe(422);
  });

  it('counts a session only while it is live: revoked, expired and idle-dead ones do not count', async () => {
    const rami = await owner();
    const { db } = await testDb();
    const support = await roleNamed('Support');
    const lina = await insertStaff(db, support);
    const live = await openSession(t, { type: 'staff', id: lina });
    await openSession(t, { type: 'staff', id: lina }, { ttlSeconds: 60 });
    const revoked = await openSession(t, { type: 'staff', id: lina });
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, revoked.sessionId));
    expect((await rami.get(`/admin/staff/${lina}`)).body.activeSessions).toBe(2);
    clock.advance(61_000);
    expect((await rami.get(`/admin/staff/${lina}`)).body.activeSessions).toBe(1);
    // Staff idle limit is 30 minutes: Lina's session sits unused for longer and is idle-dead, and so is Rami's own session
    // (he has been idle as long), so he signs in again before reading.
    clock.advance(31 * 60_000);
    expect((await rami.get(`/admin/staff/${lina}`)).status).toBe(401);
    const ramiAgain = await adminFor(t, rami.staffId, rami.roleId);
    expect(live.sessionId).toBeGreaterThan(0);
    expect((await ramiAgain.get(`/admin/staff/${lina}`)).body.activeSessions).toBe(0);
  });

  it('shows one member and answers 404 for an unknown id', async () => {
    const rami = await owner();
    expect((await rami.get(`/admin/staff/${rami.staffId}`)).body).toMatchObject({ id: rami.staffId, name: 'Rami K.' });
    const missing = await rami.get('/admin/staff/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('needs staff:read', async () => {
    const nobody = await adminWith(t, ['roles:read']);
    const res = await nobody.get('/admin/staff');
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('staff:read');
  });
});

describe('POST /admin/staff', () => {
  it('adds a member by invitation: invited, created_by = the caller, a one-hour hashed link token, an audit row', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const res = await rami.post('/admin/staff', {
      name: '  Nadia   Hamdan ',
      email: ' Nadia@GSM-Supply.example ',
      roleId: role,
      onboarding: 'invite',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Nadia Hamdan',
      email: 'nadia@gsm-supply.example',
      status: 'invited',
      twofaEnabled: false,
      mustChangePassword: false,
      passwordChangedAt: null,
      activeSessions: 0,
      createdBy: { id: rami.staffId, name: 'Rami K.' },
      role: { id: role, name: 'Support' },
      resetSentAt: clock.now().toISOString(),
    });
    expect(res.body.temporaryPassword).toBeUndefined();

    const row = await staffRow(res.body.id);
    expect(row.passwordHash).toBeNull();
    expect(row.createdBy).toBe(rami.staffId);
    const [token, ...others] = await tokensOf(res.body.id);
    expect(others).toHaveLength(0);
    expect(token).toMatchObject({ purpose: 'invite', subjectType: 'staff', usedAt: null, createdBy: rami.staffId });
    expect(token!.expiresAt.getTime() - token!.createdAt.getTime()).toBe(STAFF_TOKEN_TTL_MS);
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'added admin',
      entityType: 'staff',
      entityId: res.body.id,
      entityLabel: 'Nadia Hamdan',
    });
    expect(JSON.stringify(audit)).not.toContain(token!.tokenHash);
  });

  it('adds a member with a temporary password: shown once, only its hash stored, a change forced, never in the audit log', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const res = await rami.post('/admin/staff', {
      name: 'Omar Finance',
      email: 'omar@example.com',
      roleId: role,
      onboarding: 'temporary_password',
    });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const password = res.body.temporaryPassword as string;
    expect(password).toHaveLength(14);
    expect(res.body).toMatchObject({ status: 'invited', mustChangePassword: true, resetSentAt: null });
    expect(res.body.passwordChangedAt).toBe(clock.now().toISOString());

    const row = await staffRow(res.body.id);
    expect(row.passwordHash).toStartWith('$argon2id$');
    expect(await t.app.get(PasswordHasher).verify(row.passwordHash!, password)).toBe(true);
    expect(await tokensOf(res.body.id)).toHaveLength(0);
    expect(JSON.stringify(await auditRows())).not.toContain(password);

    // Reading the member again never shows the password.
    const again = await rami.get(`/admin/staff/${res.body.id}`);
    expect(again.body.temporaryPassword).toBeUndefined();
    expect(JSON.stringify(again.body)).not.toContain(password);
  });

  it('defaults to the invitation when onboarding is omitted', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const res = await rami.post('/admin/staff', { name: 'Dana Admin', email: 'dana@example.com', roleId: role });
    expect(res.status).toBe(201);
    expect(await tokensOf(res.body.id)).toHaveLength(1);
  });

  it('refuses a taken email in any case (EMAIL_TAKEN) and writes nothing', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const { db } = await testDb();
    await insertStaff(db, role, { email: 'taken@example.com' });
    const res = await rami.post('/admin/staff', {
      name: 'Someone',
      email: 'TAKEN@example.com',
      roleId: role,
      onboarding: 'invite',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
    expect(await db.select().from(s.staffUsers)).toHaveLength(2);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets only one of two parallel requests with the same email through', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const body = { name: 'Twin', email: 'twin@example.com', roleId: role, onboarding: 'invite' };
    const answers = await Promise.all([rami.post('/admin/staff', body), rami.post('/admin/staff', body)]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    const { db } = await testDb();
    expect(await db.select().from(s.authTokens)).toHaveLength(1);
  });

  it('refuses bad input with the field names the console maps (name, email, roleId)', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const bad = await rami.post('/admin/staff', {
      name: ' a ',
      email: 'not-an-email',
      roleId: 999_999,
      onboarding: 'invite',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['email', 'name']);
    const unknownRole = await rami.post('/admin/staff', {
      name: 'Fine Name',
      email: 'fine@example.com',
      roleId: 999_999,
    });
    expect(unknownRole.status).toBe(422);
    expect(unknownRole.body.errors[0].field).toBe('roleId');
    expect(
      (await rami.post('/admin/staff', { name: 'Fine', email: 'x@y.example', roleId: role, onboarding: 'carrier' }))
        .status,
    ).toBe(422);
  });

  it('needs staff:create, and only an Owner may give a role that grants everything', async () => {
    const reader = await adminWith(t, ['staff:read']);
    const role = await roleNamed('Support');
    expect((await reader.post('/admin/staff', { name: 'No One', email: 'n@example.com', roleId: role })).status).toBe(
      403,
    );

    const admin = await adminWith(t, ['staff:create']);
    const ownerRole = await roleNamed('Owner role', ['*']);
    const refused = await admin.post('/admin/staff', {
      name: 'Sneaky',
      email: 'sneaky@example.com',
      roleId: ownerRole,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    const rami = await owner();
    expect(
      (await rami.post('/admin/staff', { name: 'Second Owner', email: 'o2@example.com', roleId: ownerRole })).status,
    ).toBe(201);
  });

  it('stops a caller who was suspended a moment ago, even though the cached session still says active', async () => {
    const admin = await adminWith(t, ['staff:create']);
    const role = await roleNamed('Support');
    const { db } = await testDb();
    // Written straight to the table: the cached session view (60 s) still says "ok".
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, admin.staffId));
    const res = await admin.post('/admin/staff', { name: 'Ghost', email: 'ghost@example.com', roleId: role });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('PATCH /admin/staff/:id', () => {
  it('edits name, email and role, audits the changed fields, and applies the new role on the next request', async () => {
    const rami = await owner();
    const support = await roleNamed('Support', ['staff:read']);
    const finance = await roleNamed('Finance', ['roles:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });
    const linaApi = await adminFor(t, lina, support);
    expect((await linaApi.get('/admin/staff')).status).toBe(200);

    const res = await rami.patch(`/admin/staff/${lina}`, {
      name: ' Lina  Saleh ',
      email: 'Lina.Saleh@example.com',
      roleId: finance,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: lina,
      name: 'Lina Saleh',
      email: 'lina.saleh@example.com',
      role: { id: finance, name: 'Finance' },
    });
    // The cached session view (role id, name) was dropped after the commit.
    expect((await linaApi.get('/admin/staff')).status).toBe(403);
    expect((await linaApi.get('/admin/roles')).status).toBe(200);

    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'edited admin',
      entityType: 'staff',
      entityId: lina,
      entityLabel: 'Lina Saleh',
    });
    expect(audit!.before).toEqual({ name: 'Lina S.', email: 'lina@example.com', roleId: support });
    expect(audit!.after).toEqual({ name: 'Lina Saleh', email: 'lina.saleh@example.com', roleId: finance });
  });

  it('writes the new name on later audit rows of that member (the snapshot follows the session cache)', async () => {
    const rami = await owner();
    const support = await roleNamed('Support', ['staff:update']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const linaApi = await adminFor(t, lina, support);
    await linaApi.post(`/admin/staff/${rami.staffId}/sessions/revoke`).catch(() => undefined);
    await rami.patch(`/admin/staff/${lina}`, { name: 'Lina Saleh' });
    const target = await adminWith(t, ['*'], { name: 'Target' });
    // Lina cannot touch an Owner, but the refusal is not audited; use an allowed action to see the snapshot.
    const other = await insertStaff(db, support, { name: 'Other' });
    await linaApi.post(`/admin/staff/${other}/sessions/revoke`);
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ actorId: lina, actorName: 'Lina Saleh' });
    expect(target.staffId).toBeGreaterThan(0);
  });

  it('a new email voids the open links of the member; a name or role change keeps them', async () => {
    const rami = await owner();
    const support = await roleNamed('Support', ['staff:read']);
    const finance = await roleNamed('Finance', ['roles:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });
    await rami.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    expect((await rami.patch(`/admin/staff/${lina}`, { name: 'Lina Saleh', roleId: finance })).status).toBe(200);
    expect((await tokensOf(lina)).map((row) => row.usedAt)).toEqual([null]);

    const moved = await rami.patch(`/admin/staff/${lina}`, { email: 'lina.saleh@example.com' });
    expect(moved.status).toBe(200);
    const [link] = await tokensOf(lina);
    expect(link!.usedAt?.toISOString()).toBe(clock.now().toISOString());
    expect((await staffRow(lina)).email).toBe('lina.saleh@example.com');
  });

  it('refuses an email another member uses (EMAIL_TAKEN) and an unchanged-email edit is fine', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { email: 'lina@example.com' });
    await insertStaff(db, support, { email: 'omar@example.com' });
    const taken = await rami.patch(`/admin/staff/${lina}`, { email: 'OMAR@example.com' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_TAKEN');
    expect((await rami.patch(`/admin/staff/${lina}`, { email: 'LINA@example.com' })).status).toBe(200);
  });

  it('refuses changing your own role (CANNOT_CHANGE_OWN_ROLE on roleId) but lets you edit your own name', async () => {
    const admin = await adminWith(t, ['staff:update'], { name: 'Dana A.' });
    const other = await roleNamed('Other');
    const own = await admin.patch(`/admin/staff/${admin.staffId}`, { roleId: other });
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
    expect(own.body.errors[0].field).toBe('roleId');
    expect((await admin.patch(`/admin/staff/${admin.staffId}`, { roleId: admin.roleId })).status).toBe(200);
    expect((await admin.patch(`/admin/staff/${admin.staffId}`, { name: 'Dana Admin' })).body.name).toBe('Dana Admin');
  });

  it('refuses demoting the last active Owner (LAST_OWNER on roleId) and allows it while another Owner is active', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const second = await insertStaff(db, rami.roleId, { name: 'Second' });
    const secondApi = await adminFor(t, second, rami.roleId);
    const third = await insertStaff(db, rami.roleId, { name: 'Third' });
    // Three active Owners: demoting Third leaves two.
    expect((await rami.patch(`/admin/staff/${third}`, { roleId: support })).status).toBe(200);
    // Second's cached session still says Owner for up to 60 s; the role is taken away straight in the table (no invalidation),
    // so Rami is now the only Owner in the database while Second's request still passes the permission guard.
    expect((await secondApi.get('/admin/staff')).status).toBe(200);
    await db.update(s.staffUsers).set({ roleId: support }).where(eq(s.staffUsers.id, second));
    const last = await secondApi.patch(`/admin/staff/${rami.staffId}`, { roleId: support });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_OWNER');
    expect(last.body.errors[0].field).toBe('roleId');
    expect((await staffRow(rami.staffId)).roleId).toBe(rami.roleId);
  });

  it('lets only one of two parallel demotions of the two Owners through', async () => {
    const a = await owner();
    const { db } = await testDb();
    const bId = await insertStaff(db, a.roleId, { name: 'B' });
    const b = await adminFor(t, bId, a.roleId);
    const support = await roleNamed('Support');
    const answers = await Promise.all([
      a.patch(`/admin/staff/${bId}`, { roleId: support }),
      b.patch(`/admin/staff/${a.staffId}`, { roleId: support }),
    ]);
    expect(answers.map((x) => x.status).sort()).toEqual([200, 409]);
  });

  it('needs an Owner to act on an Owner account or to hand out a role that grants everything', async () => {
    const rami = await owner();
    const admin = await adminWith(t, ['staff:update']);
    const support = await roleNamed('Support');
    expect((await admin.patch(`/admin/staff/${rami.staffId}`, { name: 'Hijack' })).status).toBe(403);
    const { db } = await testDb();
    const lina = await insertStaff(db, support);
    expect((await admin.patch(`/admin/staff/${lina}`, { roleId: rami.roleId })).status).toBe(403);
  });

  it('answers 404, and 422 for an empty body, a short name or an unknown role', async () => {
    const rami = await owner();
    expect((await rami.patch('/admin/staff/999999', { name: 'Fine Name' })).status).toBe(404);
    expect((await rami.patch(`/admin/staff/${rami.staffId}`, {})).status).toBe(422);
    expect((await rami.patch(`/admin/staff/${rami.staffId}`, { name: 'x' })).body.errors[0].field).toBe('name');
    const { db } = await testDb();
    const lina = await insertStaff(db, await roleNamed('Support'));
    expect((await rami.patch(`/admin/staff/${lina}`, { roleId: 999_999 })).body.errors[0].field).toBe('roleId');
  });
});

describe('POST /admin/staff/:id/password', () => {
  it('reset_link: issues a one-hour link (invite while invited, reset otherwise), keeps the password, answers {} with no-store', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const invited = await insertStaff(db, support, { status: 'invited' });
    const active = await insertStaff(db, support, { passwordHash: 'old-hash' });

    const first = await rami.post(`/admin/staff/${invited}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({});
    expect(first.res.headers['cache-control']).toBe('no-store');
    expect((await tokensOf(invited)).map((x) => x.purpose)).toEqual(['invite']);

    await rami.post(`/admin/staff/${active}/password`, { mode: 'reset_link', revokeSessions: false });
    expect((await tokensOf(active)).map((x) => x.purpose)).toEqual(['reset']);
    expect((await staffRow(active)).passwordHash).toBe('old-hash');
    expect((await rami.get(`/admin/staff/${active}`)).body.resetSentAt).toBe(clock.now().toISOString());

    // A newer link voids the older one: only the newest works.
    clock.advance(HOUR / 4);
    await rami.post(`/admin/staff/${active}/password`, { mode: 'reset_link', revokeSessions: false });
    const links = await tokensOf(active);
    expect(links.map((x) => x.usedAt !== null)).toEqual([true, false]);
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'sent a password reset link to admin', entityId: active });
    expect(JSON.stringify(rows)).not.toContain(links[1]!.tokenHash);
  });

  it('temporary_password: stores its hash, forces a change, voids unused links, returns it once, nulls resetSentAt', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { passwordHash: 'old-hash' });
    await rami.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    clock.advance(1_000);

    const res = await rami.post(`/admin/staff/${lina}/password`, { mode: 'temporary_password', revokeSessions: false });
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const password = res.body.temporaryPassword as string;
    expect(password).toHaveLength(14);
    const row = await staffRow(lina);
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordChangedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(await t.app.get(PasswordHasher).verify(row.passwordHash!, password)).toBe(true);
    expect((await tokensOf(lina)).every((x) => x.usedAt !== null)).toBe(true);
    expect((await rami.get(`/admin/staff/${lina}`)).body).toMatchObject({
      resetSentAt: null,
      mustChangePassword: true,
    });
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'set a temporary password for admin' });
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  it("revokeSessions ends every session of the member, including the caller's own when the target is the caller", async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const lina = await insertStaff(db, support);
    await openSession(t, { type: 'staff', id: lina });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_password' });
    await rami.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: true });
    expect((await sessionsOf(lina)).every((x) => x.revokedAt !== null)).toBe(true);

    const own = await rami.post(`/admin/staff/${rami.staffId}/password`, { mode: 'reset_link', revokeSessions: true });
    expect(own.status).toBe(200);
    expect((await rami.get('/admin/staff')).status).toBe(401);
  });

  it("keeps the member's sessions when revokeSessions is false", async () => {
    const rami = await owner();
    const { db } = await testDb();
    const lina = await insertStaff(db, await roleNamed('Support'));
    await openSession(t, { type: 'staff', id: lina });
    await rami.post(`/admin/staff/${lina}/password`, { mode: 'temporary_password', revokeSessions: false });
    expect((await sessionsOf(lina)).every((x) => x.revokedAt === null)).toBe(true);
  });

  it('refuses bad input and unknown members, and needs an Owner for an Owner account', async () => {
    const rami = await owner();
    const admin = await adminWith(t, ['staff:update']);
    expect(
      (await rami.post(`/admin/staff/${admin.staffId}/password`, { mode: 'bogus', revokeSessions: true })).status,
    ).toBe(422);
    expect((await rami.post(`/admin/staff/${admin.staffId}/password`, { mode: 'reset_link' })).status).toBe(422);
    expect((await rami.post('/admin/staff/999999/password', { mode: 'reset_link', revokeSessions: true })).status).toBe(
      404,
    );
    const forbidden = await admin.post(`/admin/staff/${rami.staffId}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    expect(forbidden.status).toBe(403);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('POST /admin/staff/:id/sessions/revoke', () => {
  it('ends every session of the member, pre-2FA ones included, audits the count, and signs the member out', async () => {
    const rami = await owner();
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support);
    const linaApi = await adminFor(t, lina, support);
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_totp' });
    expect((await linaApi.get('/admin/staff')).status).toBe(200);

    const res = await rami.post(`/admin/staff/${lina}/sessions/revoke`);
    expect(res.status).toBe(204);
    expect((await sessionsOf(lina)).every((x) => x.revokedAt !== null)).toBe(true);
    expect((await linaApi.get('/admin/staff')).status).toBe(401);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({ action: 'signed out all devices of admin', entityId: lina });
    expect(audit!.before).toEqual({ sessions: 1 });
    expect(audit!.after).toEqual({ sessions: 0 });
  });

  it('answers 404 for an unknown member and 403 for an Owner target without *', async () => {
    const rami = await owner();
    const admin = await adminWith(t, ['staff:update']);
    expect((await rami.post('/admin/staff/999999/sessions/revoke')).status).toBe(404);
    expect((await admin.post(`/admin/staff/${rami.staffId}/sessions/revoke`)).status).toBe(403);
    expect((await sessionsOf(rami.staffId)).every((x) => x.revokedAt === null)).toBe(true);
  });
});

describe('POST /admin/staff/:id/suspend', () => {
  it('suspends: status, time, reason, suspended_by, every session ended, unused links voided, an audit row', async () => {
    const rami = await owner();
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const linaApi = await adminFor(t, lina, support);
    await rami.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    expect((await linaApi.get('/admin/staff')).status).toBe(200);

    const res = await rami.post(`/admin/staff/${lina}/suspend`, { reason: '  Left the team: moved to sales ' });
    expect(res.status).toBe(204);
    const row = await staffRow(lina);
    expect(row).toMatchObject({
      status: 'suspended',
      suspendedReason: 'Left the team: moved to sales',
      suspendedBy: rami.staffId,
    });
    expect(row.suspendedAt?.toISOString()).toBe(clock.now().toISOString());
    expect((await sessionsOf(lina)).every((x) => x.revokedAt !== null)).toBe(true);
    expect((await tokensOf(lina)).every((x) => x.usedAt !== null)).toBe(true);
    expect((await linaApi.get('/admin/staff')).status).toBe(401);
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'suspended admin', entityId: lina, entityLabel: 'Lina S.' });
    expect(rows.at(-1)!.after).toEqual({ status: 'suspended', reason: 'Left the team: moved to sales' });
  });

  it('refuses yourself, an already suspended member, the last active Owner, and a blank reason', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const yusuf = await insertStaff(db, support, { status: 'suspended' });
    expect((await rami.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' })).body.code).toBe(
      'CANNOT_SUSPEND_SELF',
    );
    expect((await rami.post(`/admin/staff/${yusuf}/suspend`, { reason: 'Test' })).body.code).toBe('ALREADY_SUSPENDED');
    expect((await rami.post(`/admin/staff/${yusuf}/suspend`, { reason: '   ' })).status).toBe(422);
    expect((await rami.post(`/admin/staff/${yusuf}/suspend`, {})).body.errors[0].field).toBe('reason');

    const second = await insertStaff(db, rami.roleId, { name: 'Second' });
    const secondApi = await adminFor(t, second, rami.roleId);
    // Two Owners: either may suspend the other, but not both.
    expect((await rami.post(`/admin/staff/${second}/suspend`, { reason: 'On leave' })).status).toBe(204);
    const last = await secondApi.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' });
    // The suspended second Owner's session is gone; sign a fresh one in the database to prove the rule itself.
    expect(last.status).toBe(401);
    const third = await insertStaff(db, rami.roleId, { name: 'Third' });
    const thirdApi = await adminFor(t, third, rami.roleId);
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, rami.staffId));
    const refused = await thirdApi.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' });
    expect(refused.body.code).toBe('ALREADY_SUSPENDED');
    // Rami is active again and the second Owner is suspended; Third's cached session says Owner, while the table already
    // demoted Third (written straight, so no invalidation): Rami is the only active Owner in the database.
    await db.update(s.staffUsers).set({ status: 'active' }).where(eq(s.staffUsers.id, rami.staffId));
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, second));
    expect((await thirdApi.get('/admin/staff')).status).toBe(200);
    await db.update(s.staffUsers).set({ roleId: support }).where(eq(s.staffUsers.id, third));
    const lastOwner = await thirdApi.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' });
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.body.code).toBe('LAST_OWNER');
    expect((await staffRow(rami.staffId)).status).toBe('active');
  });

  it('lets only one of two parallel suspensions of the two Owners through', async () => {
    const a = await owner();
    const { db } = await testDb();
    const bId = await insertStaff(db, a.roleId, { name: 'B' });
    const b = await adminFor(t, bId, a.roleId);
    const answers = await Promise.all([
      a.post(`/admin/staff/${bId}/suspend`, { reason: 'Test' }),
      b.post(`/admin/staff/${a.staffId}/suspend`, { reason: 'Test' }),
    ]);
    expect(answers.map((x) => x.status).sort()).toEqual([204, 409]);
  });

  it('needs staff:suspend and an Owner for an Owner account; an unknown member is 404', async () => {
    const rami = await owner();
    const reader = await adminWith(t, ['staff:update']);
    expect((await reader.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' })).status).toBe(403);
    const suspender = await adminWith(t, ['staff:suspend']);
    expect((await suspender.post(`/admin/staff/${rami.staffId}/suspend`, { reason: 'Test' })).status).toBe(403);
    expect((await rami.post('/admin/staff/999999/suspend', { reason: 'Test' })).status).toBe(404);
  });
});

describe('POST /admin/staff/:id/reactivate', () => {
  it('lifts a suspension: active when the member ever signed in, invited otherwise; no session comes back', async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const veteran = await insertStaff(db, support, { lastLoginAt: new Date('2026-10-01T00:00:00.000Z') });
    const newcomer = await insertStaff(db, support, { status: 'invited' });
    for (const id of [veteran, newcomer]) await rami.post(`/admin/staff/${id}/suspend`, { reason: 'On leave' });

    expect((await rami.post(`/admin/staff/${veteran}/reactivate`)).status).toBe(204);
    expect((await rami.post(`/admin/staff/${newcomer}/reactivate`)).status).toBe(204);
    expect(await staffRow(veteran)).toMatchObject({
      status: 'active',
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
    });
    expect((await staffRow(newcomer)).status).toBe('invited');
    expect((await sessionsOf(veteran)).every((x) => x.revokedAt !== null)).toBe(true);
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'reactivated admin', entityId: newcomer });
  });

  it('refuses a member who is not suspended (NOT_SUSPENDED) and an unknown member', async () => {
    const rami = await owner();
    expect((await rami.post(`/admin/staff/${rami.staffId}/reactivate`)).body.code).toBe('NOT_SUSPENDED');
    expect((await rami.post('/admin/staff/999999/reactivate')).status).toBe(404);
  });
});

describe('POST /admin/staff/:id/reset-2fa', () => {
  it("turns 2FA off, clears the secret and the replay step, and ends the member's sessions", async () => {
    const rami = await owner();
    const support = await roleNamed('Support');
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { twofaEnabled: true, totpSecretEnc: 'sealed', totpLastStep: 55 });
    await openSession(t, { type: 'staff', id: lina });
    const res = await rami.post(`/admin/staff/${lina}/reset-2fa`);
    expect(res.status).toBe(204);
    expect(await staffRow(lina)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
    expect((await sessionsOf(lina)).every((x) => x.revokedAt !== null)).toBe(true);
    expect((await auditRows()).at(-1)).toMatchObject({ action: 'reset 2FA of admin', entityId: lina });
  });

  it("keeps the caller's own session when the caller resets their own 2FA", async () => {
    const rami = await owner();
    const { db } = await testDb();
    await db
      .update(s.staffUsers)
      .set({ twofaEnabled: true, totpSecretEnc: 'sealed' })
      .where(eq(s.staffUsers.id, rami.staffId));
    expect((await rami.post(`/admin/staff/${rami.staffId}/reset-2fa`)).status).toBe(204);
    expect((await rami.get('/admin/staff')).status).toBe(200);
  });

  it('refuses a member without 2FA (TWOFA_NOT_ENABLED), an unknown member, and an Owner target without *', async () => {
    const rami = await owner();
    const admin = await adminWith(t, ['staff:update']);
    expect((await rami.post(`/admin/staff/${admin.staffId}/reset-2fa`)).body.code).toBe('TWOFA_NOT_ENABLED');
    expect((await rami.post('/admin/staff/999999/reset-2fa')).status).toBe(404);
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ twofaEnabled: true }).where(eq(s.staffUsers.id, rami.staffId));
    expect((await admin.post(`/admin/staff/${rami.staffId}/reset-2fa`)).status).toBe(403);
  });
});

describe('the privilege ceiling (decision 046)', () => {
  const FINANCE = ['staff:read', 'wallet:adjust'];

  it('refuses adding a member with a role that has a permission the caller does not hold, and shows no password', async () => {
    const admin = await adminWith(t, ['staff:create', 'staff:read']);
    const finance = await roleNamed('Finance', FINANCE);
    const { db } = await testDb();
    const before = (await db.select().from(s.staffUsers)).length;
    const refused = await admin.post('/admin/staff', {
      name: 'New Member',
      email: 'new.member@example.com',
      roleId: finance,
      onboarding: 'temporary_password',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toBe('This role has permissions you do not hold yourself.');
    expect(refused.body.temporaryPassword).toBeUndefined();
    expect((await db.select().from(s.staffUsers)).length).toBe(before);
    expect(await auditRows()).toHaveLength(0);

    const plain = await roleNamed('Plain', ['staff:read']);
    const created = await admin.post('/admin/staff', {
      name: 'New Member',
      email: 'new.member@example.com',
      roleId: plain,
      onboarding: 'temporary_password',
    });
    expect(created.status).toBe(201);
  });

  it('refuses moving a member to a role the caller does not hold', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read']);
    const finance = await roleNamed('Finance', FINANCE);
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const refused = await admin.patch(`/admin/staff/${lina}`, { roleId: finance });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('This role has permissions you do not hold yourself.');
    expect((await staffRow(lina)).roleId).toBe(support);
  });

  it('refuses every action on a member whose role has a permission the caller does not hold, and changes nothing', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:suspend', 'staff:read']);
    const finance = await roleNamed('Finance', FINANCE);
    const { db } = await testDb();
    const nadia = await insertStaff(db, finance, { name: 'Nadia H.', twofaEnabled: true, passwordHash: 'old-hash' });
    const session = await openSession(t, { type: 'staff', id: nadia });
    const base = `/admin/staff/${nadia}`;
    const attempts = [
      admin.patch(base, { name: 'X Y' }),
      admin.post(`${base}/password`, { mode: 'temporary_password', revokeSessions: true }),
      admin.post(`${base}/password`, { mode: 'reset_link', revokeSessions: false }),
      admin.post(`${base}/reset-2fa`),
      admin.post(`${base}/sessions/revoke`),
      admin.post(`${base}/suspend`, { reason: 'Test' }),
    ];
    for (const answer of await Promise.all(attempts)) {
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('FORBIDDEN');
      expect(answer.body.detail).toBe('This account has permissions you do not hold yourself.');
    }
    const row = await staffRow(nadia);
    expect(row).toMatchObject({ name: 'Nadia H.', passwordHash: 'old-hash', twofaEnabled: true, status: 'active' });
    expect((await sessionsOf(nadia)).find((entry) => entry.id === session.sessionId)?.revokedAt).toBeNull();
    expect(await tokensOf(nadia)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);

    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, nadia));
    const reactivate = await admin.post(`${base}/reactivate`);
    expect(reactivate.status).toBe(403);
    expect((await staffRow(nadia)).status).toBe('suspended');
  });

  it("does not spend the member's link mails on a refused password link", async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read']);
    const finance = await roleNamed('Finance', FINANCE);
    const { db } = await testDb();
    const nadia = await insertStaff(db, finance, { name: 'Nadia H.' });
    for (let i = 0; i < 7; i++) {
      const refused = await admin.post(`/admin/staff/${nadia}/password`, { mode: 'reset_link', revokeSessions: false });
      expect(refused.status).toBe(403);
    }

    // The refusals spent none of the member's five link mails an hour: a caller who is allowed still has all of them.
    const rami = await owner();
    for (let i = 0; i < 5; i++) {
      const sent = await rami.post(`/admin/staff/${nadia}/password`, { mode: 'reset_link', revokeSessions: false });
      expect(sent.status).toBe(200);
    }
    const sixth = await rami.post(`/admin/staff/${nadia}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(sixth.status).toBe(429);
  });

  it('lets the caller act on members whose role it holds, and on its own account', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read']);
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    expect((await admin.patch(`/admin/staff/${lina}`, { name: 'Nadia H.' })).status).toBe(200);
    expect((await admin.patch(`/admin/staff/${admin.staffId}`, { name: 'Dana Admin' })).status).toBe(200);
    expect(
      (await admin.post(`/admin/staff/${admin.staffId}/password`, { mode: 'reset_link', revokeSessions: false }))
        .status,
    ).toBe(200);
  });
});

describe('roles whose money rules count per staff member (decision 049)', () => {
  // The limits on wallet adjustments, credit limits and payment approvals, and the rule that another staff member approves the
  // payment of a manual invoice, count per account: only an Owner adds such an account or hands out a way to sign in to one.
  const COUNTED = [
    'wallet:adjust',
    'wallet:credit_limit',
    'payments:approve',
    'invoices:create',
    'wallet:*',
    'payments:*',
  ];
  const WHAT = 'whose role can adjust wallets, set credit limits, approve payments or issue invoices.';
  const ADD_DETAIL = `Only an owner can add a member ${WHAT}`;
  const TEMPORARY_DETAIL = `Only an owner can set a temporary password for a member ${WHAT}`;
  const EMAIL_DETAIL = `Only an owner can change the email of a member ${WHAT}`;
  const GIVE_DETAIL =
    'Only an owner can give a member a role that can adjust wallets, set credit limits, approve payments or issue invoices.';

  it('refuses a caller who is not an Owner adding a member with such a role, by link or temporary password', async () => {
    const { db } = await testDb();
    for (const [i, permission] of COUNTED.entries()) {
      const admin = await adminWith(t, ['staff:create', 'staff:read', permission]);
      const before = (await db.select().from(s.staffUsers)).length;
      for (const onboarding of ['invite', 'temporary_password'] as const) {
        const refused = await admin.post('/admin/staff', {
          name: 'Second Member',
          email: `second.${i}.${onboarding}@example.com`,
          roleId: admin.roleId,
          onboarding,
        });
        expect(refused.status, permission).toBe(403);
        expect(refused.body.code).toBe('FORBIDDEN');
        expect(refused.body.detail).toBe(ADD_DETAIL);
        expect(refused.body.temporaryPassword).toBeUndefined();
      }
      expect((await db.select().from(s.staffUsers)).length).toBe(before);
    }
    expect(await db.select().from(s.authTokens)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets an Owner add a member with such a role, and any caller add a member with another role', async () => {
    const rami = await owner();
    const finance = await roleNamed('Finance', ['staff:read', 'wallet:adjust', 'payments:approve']);
    const byOwner = await rami.post('/admin/staff', {
      name: 'Nadia H.',
      email: 'nadia@example.com',
      roleId: finance,
      onboarding: 'temporary_password',
    });
    expect(byOwner.status).toBe(201);
    expect(typeof byOwner.body.temporaryPassword).toBe('string');

    const admin = await adminWith(t, ['staff:create', 'staff:read', 'wallet:adjust']);
    const support = await roleNamed('Support', ['staff:read']);
    const created = await admin.post('/admin/staff', {
      name: 'Lina S.',
      email: 'lina@example.com',
      roleId: support,
      onboarding: 'temporary_password',
    });
    expect(created.status).toBe(201);
    expect(typeof created.body.temporaryPassword).toBe('string');
  });

  it('refuses a temporary password for another member with such a role unless the caller is an Owner; a link is fine', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read', 'wallet:adjust']);
    const { db } = await testDb();
    const nadia = await insertStaff(db, admin.roleId, { name: 'Nadia H.', passwordHash: 'old-hash' });
    const session = await openSession(t, { type: 'staff', id: nadia });
    const refused = await admin.post(`/admin/staff/${nadia}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toBe(TEMPORARY_DETAIL);
    expect(refused.body.temporaryPassword).toBeUndefined();
    expect(await staffRow(nadia)).toMatchObject({ passwordHash: 'old-hash', mustChangePassword: false });
    expect((await sessionsOf(nadia)).find((entry) => entry.id === session.sessionId)?.revokedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);

    // The link goes to the member's own mailbox, so it stays within the ceiling of decision 046.
    const link = await admin.post(`/admin/staff/${nadia}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(link.status).toBe(200);
    const rami = await owner();
    const set = await rami.post(`/admin/staff/${nadia}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(set.status).toBe(200);
    expect(typeof set.body.temporaryPassword).toBe('string');
  });

  it('lets a caller who is not an Owner set a temporary password for a member with another role, and for themselves', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read', 'wallet:adjust']);
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const other = await admin.post(`/admin/staff/${lina}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(other.status).toBe(200);
    const own = await admin.post(`/admin/staff/${admin.staffId}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(own.status).toBe(200);
  });

  it('refuses changing the email of another member with such a role, or of a member given one in the same request', async () => {
    const admin = await adminWith(t, ['staff:update', 'staff:read', 'wallet:adjust']);
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    const nadia = await insertStaff(db, admin.roleId, { name: 'Nadia H.', email: 'nadia@example.com' });
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });

    const refused = await admin.patch(`/admin/staff/${nadia}`, { email: 'nadia.new@example.com' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toBe(EMAIL_DETAIL);
    const moved = await admin.patch(`/admin/staff/${lina}`, { email: 'lina.new@example.com', roleId: admin.roleId });
    expect(moved.status).toBe(403);
    expect(moved.body.detail).toBe(GIVE_DETAIL);
    expect(await staffRow(nadia)).toMatchObject({ email: 'nadia@example.com' });
    expect(await staffRow(lina)).toMatchObject({ email: 'lina@example.com', roleId: support });
    expect(await auditRows()).toHaveLength(0);

    // A name, an unchanged address, another role's address and the caller's own address stay within decision 046.
    expect((await admin.patch(`/admin/staff/${nadia}`, { name: 'Nadia Hamdan' })).status).toBe(200);
    expect((await admin.patch(`/admin/staff/${nadia}`, { email: 'NADIA@example.com' })).status).toBe(200);
    expect((await admin.patch(`/admin/staff/${lina}`, { email: 'lina.new@example.com' })).status).toBe(200);
    expect((await admin.patch(`/admin/staff/${admin.staffId}`, { email: 'admin.new@example.com' })).status).toBe(200);
    const rami = await owner();
    expect((await rami.patch(`/admin/staff/${nadia}`, { email: 'nadia.new@example.com' })).status).toBe(200);
  });

  it('refuses a caller who is not an Owner moving another member into such a role, and changes nothing', async () => {
    const support = await roleNamed('Support', ['staff:read']);
    const { db } = await testDb();
    for (const [i, permission] of COUNTED.entries()) {
      const admin = await adminWith(t, ['staff:update', 'staff:read', permission]);
      const counted = await roleNamed(`Counted ${i}`, ['staff:read', permission]);
      const lina = await insertStaff(db, support, { name: 'Lina S.', email: `lina.${i}@example.com` });
      const refused = await admin.patch(`/admin/staff/${lina}`, { roleId: counted });
      expect(refused.status, permission).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.detail).toBe(GIVE_DETAIL);
      expect((await staffRow(lina)).roleId).toBe(support);
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets an Owner move a member into such a role, and any caller move a member into another role', async () => {
    const support = await roleNamed('Support', ['staff:read']);
    const finance = await roleNamed('Finance', ['staff:read', 'wallet:adjust']);
    const { db } = await testDb();
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });
    const nadia = await insertStaff(db, finance, { name: 'Nadia H.', email: 'nadia@example.com' });
    const rami = await owner();
    expect((await rami.patch(`/admin/staff/${lina}`, { roleId: finance })).status).toBe(200);
    expect((await staffRow(lina)).roleId).toBe(finance);

    const admin = await adminWith(t, ['staff:update', 'staff:read', 'wallet:adjust']);
    expect((await admin.patch(`/admin/staff/${nadia}`, { roleId: support })).status).toBe(200);
    expect((await staffRow(nadia)).roleId).toBe(support);
  });
});

describe('the hash of a link is what is stored', () => {
  it('never keeps the token itself', async () => {
    const rami = await owner();
    const role = await roleNamed('Support');
    const res = await rami.post('/admin/staff', { name: 'Hash Check', email: 'hash@example.com', roleId: role });
    const [token] = await tokensOf(res.body.id);
    expect(token!.tokenHash).toHaveLength(64);
    // The raw token is 43 base64url characters; the stored value is a 64-character hex digest of the keyed hash.
    expect(t.app.get(TokenService).hash('x')).toHaveLength(64);
  });
});
