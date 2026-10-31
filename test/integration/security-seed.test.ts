// The guards against the seed data of scripts/seed (the six demo roles and staff of the frontend mocks): the permission
// grammar, including the required x:* rule, on the lists the console really grants. Needs the frontend checkout, like seed.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { ROLES, permissionsOf } from '../../scripts/seed/identity';
import { runSeed } from '../../scripts/seed/run';
import { assertOwnerTargetAllowed, isOwner } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { SecurityTestController } from '../support/security-routes';

const frontendPresent = existsSync(demoStatePath());
// Seed ids: staff 1 Rami (Owner), 2 Lina (Support), 3 Omar (Finance), 4 Dana (Admin), 5 Nadia (invited, Risk), 6 Yusuf (suspended).
const RAMI = 1;
const LINA = 2;
const OMAR = 3;
const DANA = 4;
const NADIA = 5;
const YUSUF = 6;

let t: TestApp;
beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp({ controllers: [SecurityTestController] });
});
afterAll(async () => {
  if (frontendPresent) await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await runSeed((await testDb()).db, await loadDemoState());
  await clearIdentityCaches(t);
});

const status = async (staffId: number, method: 'GET' | 'POST' | 'PUT', url: string) => {
  const session = await openSession(t, { type: 'staff', id: staffId });
  const res = await t.app.inject({
    method,
    url,
    headers: method === 'GET' ? session.headers : session.mutationHeaders,
  });
  return res.statusCode;
};

describe.skipIf(!frontendPresent)('the guards with the seeded roles and staff', () => {
  it('lets the Owner (*) through every permission route, including the literal risk:*', async () => {
    expect(await status(RAMI, 'GET', '/admin/t/sec/needs-read')).toBe(200);
    expect(await status(RAMI, 'POST', '/admin/t/sec/write')).toBe(201);
    expect(await status(RAMI, 'PUT', '/admin/t/sec/risk-rules')).toBe(200);
  });

  it('gives the Admin staff:read and risk:*, but not staff:update (the console grants it view access on Admins)', async () => {
    expect(await status(DANA, 'GET', '/admin/t/sec/needs-read')).toBe(200);
    expect(await status(DANA, 'PUT', '/admin/t/sec/risk-rules')).toBe(200);
    expect(await status(DANA, 'POST', '/admin/t/sec/write')).toBe(403);
  });

  it('refuses Finance the literal risk:* because it only holds risk:read', async () => {
    expect(await status(OMAR, 'PUT', '/admin/t/sec/risk-rules')).toBe(403);
    expect(await status(OMAR, 'GET', '/admin/t/sec/needs-read')).toBe(403);
  });

  it('refuses Support the staff area altogether', async () => {
    expect(await status(LINA, 'GET', '/admin/t/sec/needs-read')).toBe(403);
    expect(await status(LINA, 'POST', '/admin/t/sec/write')).toBe(403);
  });

  it('refuses the suspended member (403 ACCOUNT_SUSPENDED) and lets the invited one through the first sign-in step', async () => {
    const suspended = await openSession(t, { type: 'staff', id: YUSUF });
    const res = await t.app.inject({ method: 'GET', url: '/admin/t/sec/session', headers: suspended.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ACCOUNT_SUSPENDED');

    const invited = await openSession(t, { type: 'staff', id: NADIA }, { stage: 'pending_totp_setup' });
    const step = await t.app.inject({ method: 'POST', url: '/admin/t/sec/step', headers: invited.mutationHeaders });
    expect(step.statusCode).toBe(200);
  });

  it('knows who is an Owner from the seeded role lists', () => {
    const permissions = Object.fromEntries(ROLES.map((role) => [role.key, permissionsOf(role.key)]));
    expect(isOwner({ permissions: permissions.owner! })).toBe(true);
    for (const key of ['admin', 'finance', 'support', 'risk', 'viewer'] as const) {
      expect(isOwner({ permissions: permissions[key]! }), key).toBe(false);
      expect(() =>
        assertOwnerTargetAllowed({ permissions: permissions[key]! }, { permissions: permissions.owner! }),
      ).toThrow();
      expect(() =>
        assertOwnerTargetAllowed({ permissions: permissions.owner! }, { permissions: permissions[key]! }),
      ).not.toThrow();
    }
  });
});
