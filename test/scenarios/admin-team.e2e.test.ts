// End-to-end walk of the map scenario `admin-team` (add a staff member and suspend them, docs/slices/identity.json), step by
// step through HTTP on the real application: the tables and statuses each step names are read back from Postgres.
// The steps share one story, so the tests of this file run in order and keep their state in the variables below.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { PasswordHasher, TokenService } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { IpRuleCache, STAFF_TOKEN_TTL_MS, StaffAuthTokens } from '../../src/modules/identity';
import { type AdminApi, adminFor, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, clearRateLimits, insertRole, insertStaff } from '../support/auth';
import { SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { CONSOLE_ORIGIN, StaffConsole, codeFor } from '../support/staff-console';

const clock = new TestClock();
let t: TestApp;

const NADIA_EMAIL = 'nadia@gsm-supply.example';
const NADIA_IP = '198.51.100.20';
const NADIA_PASSWORD = 'a-brand-new-passphrase';

let owner: AdminApi;
let supportRole: number;
let financeRole: number;
let nadiaId = 0;
let omarId = 0;
let inviteToken = '';
let nadiaSecret = '';
/** Nadia's browser after the first full sign-in (step 5). */
let nadiaConsole: StaffConsole;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: CONSOLE_ORIGIN }, clock });
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits(t);
  await t.app.get(IpRuleCache).invalidate();
  const { db } = await testDb();
  supportRole = await insertRole(db, ['staff:read'], 'Support');
  financeRole = await insertRole(db, ['staff:read', 'staff:update', 'roles:read'], 'Finance');
  owner = await adminWith(t, ['*'], { name: 'Rami K.', roleName: 'Owner' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.close();
  await closeTestDb();
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
    .orderBy(asc(s.authTokens.id));
};
const sessionsOf = async (staffId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'staff'), eq(s.sessions.subjectId, staffId)))
    .orderBy(asc(s.sessions.id));
};
const auditFor = async (entityId: number, entityType = 'staff') => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, entityType), eq(s.auditLogs.entityId, entityId)))
    .orderBy(asc(s.auditLogs.id));
};
/** The code an authenticator shows now. One time step later each time: a code is never accepted twice. */
const codeNow = async (secret: string) => {
  clock.advance(30 * SECOND);
  return codeFor(secret, clock.nowMs());
};
const problem = (res: { json: () => unknown }) => res.json() as { code: string };

describe('scenario admin-team: add a staff member and suspend them', () => {
  it('step 1: the Owner adds a member by link; a duplicate email and a caller without staff:create are refused', async () => {
    // A regular admin sees the page but cannot add.
    const regular = await adminWith(t, ['staff:read'], { name: 'Dana Admin' });
    expect((await regular.get('/admin/staff')).status).toBe(200);
    const refused = await regular.post('/admin/staff', {
      name: 'Sneaky',
      email: 'sneaky@example.com',
      roleId: supportRole,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('staff:create');

    const res = await owner.post('/admin/staff', {
      name: 'Nadia Hamdan',
      email: NADIA_EMAIL,
      roleId: supportRole,
      onboarding: 'invite',
    });
    expect(res.status).toBe(201);
    nadiaId = res.body.id;
    expect(res.body).toMatchObject({
      name: 'Nadia Hamdan',
      email: NADIA_EMAIL,
      status: 'invited',
      role: { id: supportRole, name: 'Support' },
    });

    const duplicate = await owner.post('/admin/staff', {
      name: 'Nadia Again',
      email: NADIA_EMAIL.toUpperCase(),
      roleId: supportRole,
      onboarding: 'invite',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_TAKEN');

    // staff_users and roles: the new account points at its role.
    const { db } = await testDb();
    const [joined] = await db
      .select({ email: s.staffUsers.email, roleName: s.roles.name })
      .from(s.staffUsers)
      .innerJoin(s.roles, eq(s.roles.id, s.staffUsers.roleId))
      .where(eq(s.staffUsers.id, nadiaId));
    expect(joined).toEqual({ email: NADIA_EMAIL, roleName: 'Support' });
    expect(await db.select().from(s.staffUsers).where(eq(s.staffUsers.email, NADIA_EMAIL))).toHaveLength(1);
  });

  it('step 2: the account is invited, created by the Owner, with a one-hour hashed single-use token and an audit row', async () => {
    expect(await staffRow(nadiaId)).toMatchObject({
      status: 'invited',
      createdBy: owner.staffId,
      passwordHash: null,
      mustChangePassword: false,
      twofaEnabled: false,
      lastLoginAt: null,
    });
    const [token, ...others] = await tokensOf(nadiaId);
    expect(others).toHaveLength(0);
    expect(token).toMatchObject({ purpose: 'invite', subjectType: 'staff', usedAt: null, createdBy: owner.staffId });
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token!.expiresAt.getTime() - token!.createdAt.getTime()).toBe(STAFF_TOKEN_TTL_MS);
    const [audit, ...moreAudit] = await auditFor(nadiaId);
    expect(moreAudit).toHaveLength(0);
    expect(audit).toMatchObject({
      action: 'added admin',
      actorId: owner.staffId,
      actorName: 'Rami K.',
      entityLabel: 'Nadia Hamdan',
    });
    // No password anywhere: not in the account, not in the audit row, not in the token row.
    expect(JSON.stringify([audit, token])).not.toMatch(/password"?:\s*"[^"]/i);
  });

  it('step 3: the invitation is the token row (the mail is feature 12a); the temporary-password choice stores a hash and forces a change', async () => {
    const { db } = await testDb();
    // Until the notifications feature sends the mail, nothing is written to `notifications`.
    expect(await db.select().from(s.notifications)).toHaveLength(0);

    // The Owner may choose a temporary password instead of the link for another member.
    const omar = await owner.post('/admin/staff', {
      name: 'Omar Finance',
      email: 'omar@gsm-supply.example',
      roleId: financeRole,
      onboarding: 'temporary_password',
    });
    expect(omar.status).toBe(201);
    omarId = omar.body.id;
    const temporary = omar.body.temporaryPassword as string;
    expect(temporary).toHaveLength(14);
    const stored = await staffRow(omarId);
    expect(stored.mustChangePassword).toBe(true);
    expect(await t.app.get(PasswordHasher).verify(stored.passwordHash!, temporary)).toBe(true);
    expect(await tokensOf(omarId)).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(s.auditLogs))).not.toContain(temporary);

    // The sender of the mail holds the raw token of the newest link (only its hash is stored): a new link voids the old one.
    const [first] = await tokensOf(nadiaId);
    clock.advance(SECOND);
    const issued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(StaffAuthTokens).issue(work, { staffId: nadiaId, purpose: 'invite', createdBy: owner.staffId }),
      );
    inviteToken = issued.token;
    const [old, newest] = await tokensOf(nadiaId);
    expect(old!.id).toBe(first!.id);
    expect(old!.usedAt).not.toBeNull();
    expect(newest).toMatchObject({ usedAt: null, tokenHash: t.app.get(TokenService).hash(inviteToken) });
  });

  it('step 4: the member opens the link and chooses a password (the token is used once), then sets up 2FA', async () => {
    const console = new StaffConsole(t, NADIA_IP);
    const res = await console.setPassword({ token: inviteToken, password: NADIA_PASSWORD }, { csrf: false });
    expect(res.statusCode).toBe(204);
    const row = await staffRow(nadiaId);
    expect(row.passwordHash).toStartWith('$argon2id$');
    expect(row.status).toBe('invited');
    const tokens = await tokensOf(nadiaId);
    expect(tokens.every((token) => token.usedAt !== null)).toBe(true);
    expect(tokens.at(-1)!.usedAt).toEqual(clock.now());

    const again = await console.setPassword(
      { token: inviteToken, password: 'another-long-passphrase' },
      { csrf: false },
    );
    expect(again.statusCode).toBe(410);
    expect(problem(again).code).toBe('TOKEN_INVALID');

    // The first sign-in asks for the authenticator: the QR (secret) is scanned, the first code turns 2FA on.
    const login = new StaffConsole(t, NADIA_IP);
    expect((await login.login(NADIA_EMAIL, NADIA_PASSWORD)).json()).toEqual({ next: 'totp_setup' });
    nadiaSecret = (await login.setup()).json<{ secret: string }>().secret;
    expect((await login.code(await codeNow(nadiaSecret))).statusCode).toBe(204);
    expect(await staffRow(nadiaId)).toMatchObject({ twofaEnabled: true, status: 'active' });
  });

  it('step 5: sign-in checks the IP rules before the password, then the password and code open a session and stamp the login', async () => {
    const { db } = await testDb();
    const blocked = await owner.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'admin',
      cidr: NADIA_IP,
      reason: 'Test block',
    });
    expect(blocked.status).toBe(201);
    const afterFirstLogin = await staffRow(nadiaId);

    // An active block matching the address: refused with the right password, nothing stamped.
    const viaBlock = await new StaffConsole(t, NADIA_IP).login(NADIA_EMAIL, NADIA_PASSWORD);
    expect(viaBlock.statusCode).toBe(403);
    expect(problem(viaBlock).code).toBe('IP_NOT_ALLOWED');
    await owner.delete(`/admin/ip-rules/${blocked.body.id}`);

    // The restriction is on and the address is not in the allow list: refused. Once it is listed, the sign-in goes on.
    const own = await owner.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: owner.ip });
    expect((await owner.put('/admin/access/restriction', { enabled: true })).status).toBe(200);
    expect(problem(await new StaffConsole(t, NADIA_IP).login(NADIA_EMAIL, NADIA_PASSWORD)).code).toBe('IP_NOT_ALLOWED');
    const hers = await owner.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: NADIA_IP });
    expect(hers.status).toBe(201);

    const signedIn = new StaffConsole(t, NADIA_IP);
    expect((await signedIn.login(NADIA_EMAIL, NADIA_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await signedIn.code(await codeNow(nadiaSecret))).statusCode).toBe(204);
    expect((await signedIn.me()).statusCode).toBe(200);
    nadiaConsole = signedIn;

    const row = await staffRow(nadiaId);
    expect(row.lastLoginAt).toEqual(clock.now());
    expect(row.lastLoginIp).toBe(NADIA_IP);
    expect(row.lastLoginAt!.getTime()).toBeGreaterThan(afterFirstLogin.lastLoginAt!.getTime());
    const live = (await sessionsOf(nadiaId)).filter(
      (session) => session.revokedAt === null && session.stage === 'active',
    );
    expect(live).toHaveLength(2);

    // Back to the open console for the rest of the story.
    await owner.put('/admin/access/restriction', { enabled: false });
    await owner.delete(`/admin/ip-rules/${own.body.id}`);
    await owner.delete(`/admin/ip-rules/${hers.body.id}`);
    expect(await db.select().from(s.ipRules)).toHaveLength(0);
  });

  it('step 6: the Owner changes the role from Support to Finance; nobody changes their own role or touches an Owner without *', async () => {
    const nadiaApi = await adminFor(t, nadiaId, supportRole, NADIA_IP);
    expect((await nadiaApi.get('/admin/roles')).status).toBe(403);

    const res = await owner.patch(`/admin/staff/${nadiaId}`, { roleId: financeRole });
    expect(res.status).toBe(200);
    expect(res.body.role).toEqual({ id: financeRole, name: 'Finance' });
    expect((await staffRow(nadiaId)).roleId).toBe(financeRole);
    const audit = (await auditFor(nadiaId)).at(-1)!;
    expect(audit).toMatchObject({ action: 'edited admin', actorId: owner.staffId });
    expect(audit.before).toEqual({ roleId: supportRole });
    expect(audit.after).toEqual({ roleId: financeRole });
    // The new role applies on her next request (the cached session view was dropped).
    expect((await nadiaApi.get('/admin/roles')).status).toBe(200);

    const own = await owner.patch(`/admin/staff/${owner.staffId}`, { roleId: financeRole });
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
    expect(own.body.errors[0].field).toBe('roleId');
    // Finance holds staff:update, but an Owner account needs `*`: the only Owner stays one.
    const demote = await nadiaApi.patch(`/admin/staff/${owner.staffId}`, { roleId: supportRole });
    expect(demote.status).toBe(403);
    expect((await staffRow(owner.staffId)).roleId).toBe(owner.roleId);
  });

  it('step 7: the Owner suspends the member; every session ends, the name stays on the old actions; nobody suspends themselves or the last Owner', async () => {
    const { db } = await testDb();
    // Nadia acts as Finance once, so there is an old action with her name on it.
    const nadiaApi = await adminFor(t, nadiaId, financeRole, NADIA_IP);
    expect((await nadiaApi.patch(`/admin/staff/${omarId}`, { name: 'Omar F.' })).status).toBe(200);
    expect((await sessionsOf(nadiaId)).filter((session) => session.revokedAt === null).length).toBeGreaterThanOrEqual(
      3,
    );
    clock.advance(10 * SECOND);

    const res = await owner.post(`/admin/staff/${nadiaId}/suspend`, { reason: ' Left the team: moved to sales ' });
    expect(res.status).toBe(204);
    expect(await staffRow(nadiaId)).toMatchObject({
      status: 'suspended',
      suspendedAt: clock.now(),
      suspendedBy: owner.staffId,
      suspendedReason: 'Left the team: moved to sales',
    });
    const sessions = await sessionsOf(nadiaId);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    expect((await auditFor(nadiaId)).at(-1)).toMatchObject({ action: 'suspended admin', entityLabel: 'Nadia Hamdan' });

    // Her name stays on what she did, also after a rename.
    await owner.patch(`/admin/staff/${nadiaId}`, { name: 'Nadia H.' });
    const history = await owner.get(`/admin/audit-logs?actorId=${nadiaId}&actorType=staff`);
    expect(history.body.length).toBeGreaterThan(1);
    expect(history.body.every((row: { actorName: string }) => row.actorName === 'Nadia Hamdan')).toBe(true);
    expect(history.body.find((row: { action: string }) => row.action === 'edited admin')).toMatchObject({
      entityLabel: 'Omar F.',
    });

    // Nobody suspends themselves.
    const self = await owner.post(`/admin/staff/${owner.staffId}/suspend`, { reason: 'Test' });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('CANNOT_SUSPEND_SELF');
    // The last Owner is never suspended: a second Owner whose role was just taken away (her cached session still says Owner)
    // is the only other holder of `*`, so the Owner is the last one in the database.
    const layla = await insertStaff(db, owner.roleId, { name: 'Layla' });
    const laylaApi = await adminFor(t, layla, owner.roleId);
    expect((await laylaApi.get('/admin/staff')).status).toBe(200);
    await db.update(s.staffUsers).set({ roleId: supportRole }).where(eq(s.staffUsers.id, layla));
    const last = await laylaApi.post(`/admin/staff/${owner.staffId}/suspend`, { reason: 'Test' });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_OWNER');
    expect((await staffRow(owner.staffId)).status).toBe('active');
  });

  it('step 8: a suspended member is refused with ACCOUNT_SUSPENDED even with the right password, and the old session is dead', async () => {
    const before = (await sessionsOf(nadiaId)).length;
    const login = await new StaffConsole(t, NADIA_IP).login(NADIA_EMAIL, NADIA_PASSWORD);
    expect(login.statusCode).toBe(403);
    expect(problem(login).code).toBe('ACCOUNT_SUSPENDED');
    expect((await sessionsOf(nadiaId)).length).toBe(before);
    expect((await nadiaConsole.me()).statusCode).toBe(401);
    expect((await staffRow(nadiaId)).status).toBe('suspended');
  });

  it('step 9: the Owner reactivates the member (the reason is cleared); she signs in with the same password and code; a lost phone is reset', async () => {
    const res = await owner.post(`/admin/staff/${nadiaId}/reactivate`);
    expect(res.status).toBe(204);
    expect(await staffRow(nadiaId)).toMatchObject({
      status: 'active',
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      twofaEnabled: true,
    });
    expect((await auditFor(nadiaId)).at(-1)).toMatchObject({ action: 'reactivated admin' });
    // No session comes back.
    expect((await nadiaConsole.me()).statusCode).toBe(401);

    const back = new StaffConsole(t, NADIA_IP);
    expect((await back.login(NADIA_EMAIL, NADIA_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await back.code(await codeNow(nadiaSecret))).statusCode).toBe(204);
    expect((await back.me()).statusCode).toBe(200);

    // She lost her phone: the Owner resets 2FA, her sessions end, and the next sign-in sets up a new authenticator.
    const reset = await owner.post(`/admin/staff/${nadiaId}/reset-2fa`);
    expect(reset.status).toBe(204);
    expect(await staffRow(nadiaId)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
    expect((await back.me()).statusCode).toBe(401);
    expect((await auditFor(nadiaId)).at(-1)).toMatchObject({ action: 'reset 2FA of admin' });
    const fresh = new StaffConsole(t, NADIA_IP);
    expect((await fresh.login(NADIA_EMAIL, NADIA_PASSWORD)).json()).toEqual({ next: 'totp_setup' });
    const newSecret = (await fresh.setup()).json<{ secret: string }>().secret;
    expect(newSecret).not.toBe(nadiaSecret);
    expect((await fresh.code(await codeNow(newSecret))).statusCode).toBe(204);
    expect(await staffRow(nadiaId)).toMatchObject({ twofaEnabled: true, status: 'active' });
  });
});
