// Integration tests of the role routes and the permission catalog (feature 2a): list, show, create, update, delete, the Owner
// rules and the effect of a role change on the next request, through HTTP on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { adminFor, adminWith } from '../support/admin-api';
import { clearIdentityCaches, insertRole, insertStaff } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

describe('GET /admin/permissions', () => {
  it('lists every concrete permission of the registered routes as {key, label, group}, without wildcards', async () => {
    const admin = await adminWith(t, ['roles:read']);
    const res = await admin.get('/admin/permissions');
    expect(res.status).toBe(200);
    expect(res.res.headers['x-total-count']).toBeUndefined();
    const keys = res.body.map((p: { key: string }) => p.key);
    expect(keys).toContain('roles:update');
    expect(keys).toContain('staff:suspend');
    expect(keys.some((key: string) => key.endsWith(':*'))).toBe(false);
    expect(res.body.find((p: { key: string }) => p.key === 'staff:suspend')).toEqual({
      key: 'staff:suspend',
      label: 'Suspend',
      group: 'staff',
    });
  });

  it('needs roles:read', async () => {
    const admin = await adminWith(t, ['staff:read']);
    const res = await admin.get('/admin/permissions');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('listing and showing roles', () => {
  it('lists roles with their staff count, total, search and sort', async () => {
    const admin = await adminWith(t, ['roles:read'], { roleName: 'Zeta admin' });
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read'], 'Support');
    await insertStaff(db, support);
    await insertStaff(db, support, { status: 'suspended' });

    const all = await admin.get('/admin/roles?_start=0&_end=10&_sort=name&_order=asc');
    expect(all.status).toBe(200);
    expect(all.total).toBe(2);
    expect(all.body.map((r: { name: string }) => r.name)).toEqual(['Support', 'Zeta admin']);
    expect(all.body[0]).toEqual({ id: support, name: 'Support', permissions: ['staff:read'], staffCount: 2 });

    const found = await admin.get('/admin/roles?q=supp');
    expect(found.total).toBe(1);
    expect(found.body[0].name).toBe('Support');
    expect((await admin.get('/admin/roles?_sort=permissions')).status).toBe(422);
  });

  it('shows one role and answers 404 for an unknown id', async () => {
    const admin = await adminWith(t, ['roles:read']);
    const shown = await admin.get(`/admin/roles/${admin.roleId}`);
    expect(shown.body).toMatchObject({ id: admin.roleId, permissions: ['roles:read'], staffCount: 1 });
    const missing = await admin.get('/admin/roles/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /admin/roles', () => {
  it('creates a role with catalog entries and area wildcards, cleans the list, and audits it', async () => {
    const admin = await adminWith(t, ['roles:create'], { name: 'Rami K.' });
    const res = await admin.post('/admin/roles', {
      name: '  Finance ',
      permissions: ['staff:read', 'staff:*', 'staff:read', ' roles:read '],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Finance',
      permissions: ['staff:read', 'staff:*', 'roles:read'],
      staffCount: 0,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: admin.staffId,
      actorName: 'Rami K.',
      action: 'created role',
      entityType: 'role',
      entityId: res.body.id,
      entityLabel: 'Finance',
    });
    expect(audit!.after).toEqual({ name: 'Finance', permissions: ['staff:read', 'staff:*', 'roles:read'] });
  });

  it('accepts an empty permission list', async () => {
    const admin = await adminWith(t, ['roles:create']);
    const res = await admin.post('/admin/roles', { name: 'Nobody', permissions: [] });
    expect(res.status).toBe(201);
    expect(res.body.permissions).toEqual([]);
  });

  it('refuses a blank or duplicate name and unknown permissions with the field the console highlights', async () => {
    const admin = await adminWith(t, ['roles:create'], { roleName: 'Existing' });
    const blank = await admin.post('/admin/roles', { name: '   ', permissions: [] });
    expect(blank.status).toBe(422);
    expect(blank.body.errors[0].field).toBe('name');

    const duplicate = await admin.post('/admin/roles', { name: 'existing', permissions: [] });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors).toEqual([expect.objectContaining({ field: 'name' })]);

    const unknown = await admin.post('/admin/roles', {
      name: 'Odd',
      permissions: ['staff:read', 'nothing:read', 'ghost:*', 'Not Valid'],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('permissions');
    expect(unknown.body.errors[0].message).toContain('nothing:read');
    expect(unknown.body.errors[0].message).toContain('ghost:*');
    expect((await auditRows()).length).toBe(0);
  });

  it('lets only an Owner create a role that grants everything', async () => {
    const admin = await adminWith(t, ['roles:create']);
    const refused = await admin.post('/admin/roles', { name: 'Boss', permissions: ['*'] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');

    const owner = await adminWith(t, ['*']);
    const created = await owner.post('/admin/roles', { name: 'Boss', permissions: ['*:*'] });
    expect(created.status).toBe(201);
    expect(created.body.permissions).toEqual(['*']);
  });

  it('needs roles:create and a CSRF token', async () => {
    const admin = await adminWith(t, ['roles:read']);
    expect((await admin.post('/admin/roles', { name: 'X', permissions: [] })).status).toBe(403);
    const withoutCsrf = await t.app.inject({
      method: 'POST',
      url: '/admin/roles',
      headers: admin.session.headers,
      payload: { name: 'X', permissions: [] },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(withoutCsrf.json().code).toBe('CSRF_FAILED');
  });
});

describe('PATCH /admin/roles/:id', () => {
  it("renames a role and changes its permissions; the change applies on the holder's next request", async () => {
    const admin = await adminWith(t, ['roles:update', 'staff:read']);
    const { db } = await testDb();
    const roleId = await insertRole(db, ['staff:read'], 'Support');
    const staffId = await insertStaff(db, roleId);
    const member = await adminFor(t, staffId, roleId);
    expect((await member.get('/admin/staff')).status).toBe(200);

    const res = await admin.patch(`/admin/roles/${roleId}`, { name: 'Desk', permissions: ['roles:read'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: roleId, name: 'Desk', permissions: ['roles:read'], staffCount: 1 });
    // The cached permissions of the role were deleted after the commit: the very next request sees the change.
    expect((await member.get('/admin/staff')).status).toBe(403);
    expect((await member.get('/admin/roles')).status).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'edited role', entityType: 'role', entityId: roleId });
    expect(rows[0]!.before).toEqual({ name: 'Support', permissions: ['staff:read'] });
    expect(rows[0]!.after).toEqual({ name: 'Desk', permissions: ['roles:read'] });
  });

  it('changes only the keys sent and refuses an empty body, a bad name and unknown permissions', async () => {
    const admin = await adminWith(t, ['roles:update']);
    const { db } = await testDb();
    const roleId = await insertRole(db, ['staff:read'], 'Support');
    expect((await admin.patch(`/admin/roles/${roleId}`, { name: 'Help desk' })).body.permissions).toEqual([
      'staff:read',
    ]);
    expect((await admin.patch(`/admin/roles/${roleId}`, {})).status).toBe(422);
    expect((await admin.patch(`/admin/roles/${roleId}`, { name: ' ' })).body.errors[0].field).toBe('name');
    const unknown = await admin.patch(`/admin/roles/${roleId}`, { permissions: ['made:up'] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('permissions');
    expect((await admin.patch('/admin/roles/999999', { name: 'x' })).status).toBe(404);
  });

  it('answers 422 on name when another role has it', async () => {
    const admin = await adminWith(t, ['roles:update']);
    const { db } = await testDb();
    await insertRole(db, [], 'Taken');
    const roleId = await insertRole(db, [], 'Mine');
    const res = await admin.patch(`/admin/roles/${roleId}`, { name: 'TAKEN' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe('name');
  });

  it('refuses removing * from the role of the last active Owner (LAST_OWNER on permissions), but lets the Owner role be renamed', async () => {
    const owner = await adminWith(t, ['*'], { roleName: 'Owner' });
    const refused = await owner.patch(`/admin/roles/${owner.roleId}`, { permissions: ['staff:read'] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('LAST_OWNER');
    expect(refused.body.errors[0].field).toBe('permissions');

    const renamed = await owner.patch(`/admin/roles/${owner.roleId}`, { name: 'Founders' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Founders', permissions: ['*'] });
  });

  it('lets * go once another role keeps an active Owner', async () => {
    const owner = await adminWith(t, ['*'], { roleName: 'Owner' });
    const second = await adminWith(t, ['*'], { roleName: 'Second owners' });
    const res = await owner.patch(`/admin/roles/${owner.roleId}`, { permissions: ['staff:read'] });
    expect(res.status).toBe(200);
    // The other Owner cannot now do the same: they hold the last * role.
    const last = await second.patch(`/admin/roles/${second.roleId}`, { permissions: [] });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_OWNER');
  });

  it('does not count an invited or suspended Owner as an Owner', async () => {
    const { db } = await testDb();
    const ownerRole = await insertRole(db, ['*'], 'Owner');
    const signedIn = await insertStaff(db, ownerRole, { status: 'active' });
    await insertStaff(db, ownerRole, { status: 'suspended' });
    await insertStaff(db, ownerRole, { status: 'invited' });
    const otherOwner = await adminFor(t, signedIn, ownerRole);
    const res = await otherOwner.patch(`/admin/roles/${ownerRole}`, { permissions: ['staff:read'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_OWNER');
  });

  it('keeps two parallel changes from removing both Owner roles', async () => {
    const a = await adminWith(t, ['*'], { roleName: 'Owners A' });
    const b = await adminWith(t, ['*'], { roleName: 'Owners B' });
    const [first, second] = await Promise.all([
      a.patch(`/admin/roles/${a.roleId}`, { permissions: [] }),
      b.patch(`/admin/roles/${b.roleId}`, { permissions: [] }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it('needs an Owner to edit an Owner role or to give a role *', async () => {
    const owner = await adminWith(t, ['*'], { roleName: 'Owner' });
    const admin = await adminWith(t, ['roles:update']);
    const { db } = await testDb();
    const plain = await insertRole(db, ['staff:read'], 'Plain');
    expect((await admin.patch(`/admin/roles/${owner.roleId}`, { name: 'Mine now' })).status).toBe(403);
    expect((await admin.patch(`/admin/roles/${plain}`, { permissions: ['*'] })).status).toBe(403);
    expect((await owner.patch(`/admin/roles/${plain}`, { permissions: ['*'] })).status).toBe(200);
  });
});

describe('DELETE /admin/roles/:id', () => {
  it('deletes an unused role, audits it and answers 204', async () => {
    const admin = await adminWith(t, ['roles:delete']);
    const { db } = await testDb();
    const roleId = await insertRole(db, ['staff:read'], 'Spare');
    const res = await admin.delete(`/admin/roles/${roleId}`);
    expect(res.status).toBe(204);
    expect(await db.select().from(s.roles).where(eq(s.roles.id, roleId))).toHaveLength(0);
    const [row] = await auditRows();
    expect(row).toMatchObject({ action: 'deleted role', entityType: 'role', entityId: roleId, entityLabel: 'Spare' });
    expect((await admin.delete(`/admin/roles/${roleId}`)).status).toBe(404);
  });

  it('refuses a role that any staff member holds, whatever their status (ROLE_IN_USE)', async () => {
    const admin = await adminWith(t, ['roles:delete']);
    const { db } = await testDb();
    const roleId = await insertRole(db, [], 'Busy');
    await insertStaff(db, roleId, { status: 'suspended' });
    const res = await admin.delete(`/admin/roles/${roleId}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_IN_USE');
    expect(await db.select().from(s.roles).where(eq(s.roles.id, roleId))).toHaveLength(1);
  });

  it('needs an Owner to delete an Owner role', async () => {
    const admin = await adminWith(t, ['roles:delete']);
    const { db } = await testDb();
    const ownerRole = await insertRole(db, ['*'], 'Old owners');
    expect((await admin.delete(`/admin/roles/${ownerRole}`)).status).toBe(403);
  });
});
