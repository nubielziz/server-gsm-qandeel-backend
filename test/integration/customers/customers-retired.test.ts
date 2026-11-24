// Integration tests of the retired customer routes (decision 064): the twelve `/admin/customers` addresses stay registered during the
// expand release and answer `410 ROUTE_RETIRED` naming the account route to use; nothing is read or written (no row, no session, no link, no
// audit entry, no blocklist entry), whatever the body says. The access check still comes first: a caller without the permission is 403,
// without a session 401, a mutation without the CSRF token 403, and an export not started by the console 403.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { accountRow, makeAccount } from '../../support/accounts';
import { schema as s } from '@src/infra/db';

let t: TestApp;
let staff: AdminApi;

/** Every permission the twelve old rows name (the customers family stays in the catalog while they answer 410). */
const OLD_PERMISSIONS = [
  'customers:read',
  'customers:create',
  'customers:update',
  'customers:password',
  'customers:suspend',
  'customers:block',
  'customers:privacy',
];

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, OLD_PERMISSIONS);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** One old route: how to call it for an account id, and the account route the answer names. */
interface OldRoute {
  readonly key: string;
  readonly replacement: string;
  readonly call: (id: number) => Promise<{ status: number; body: { code?: string; detail?: string } }>;
}

/** The twelve rows of the map under `/admin/customers`, each with a body the old route would have accepted. */
const routes = (): OldRoute[] => {
  const post = (path: (id: number) => string, body?: unknown) => (id: number) => staff.post(path(id), body);
  return [
    { key: 'GET /admin/customers', replacement: 'GET /admin/clients', call: () => staff.get('/admin/customers') },
    {
      key: 'GET /admin/customers/:id',
      replacement: 'GET /admin/clients/:id',
      call: (id) => staff.get(`/admin/customers/${id}`),
    },
    {
      key: 'POST /admin/customers',
      replacement: 'POST /admin/clients',
      call: () =>
        staff.post('/admin/customers', {
          name: 'New Person',
          email: 'new.person@example.com',
          country: 'GB',
          password: { mode: 'reset_link' },
        }),
    },
    {
      key: 'PATCH /admin/customers/:id',
      replacement: 'PATCH /admin/clients/:id',
      call: (id) => staff.patch(`/admin/customers/${id}`, { name: 'Renamed', internalNotes: 'Changed.' }),
    },
    {
      key: 'POST /admin/customers/:id/account',
      replacement: 'POST /admin/clients/:id/account',
      call: post((id) => `/admin/customers/${id}/account`, { mode: 'reset_link' }),
    },
    {
      key: 'POST /admin/customers/:id/password',
      replacement: 'POST /admin/clients/:id/password',
      call: post((id) => `/admin/customers/${id}/password`, { mode: 'temporary_password', revokeSessions: true }),
    },
    {
      key: 'POST /admin/customers/:id/sessions/revoke',
      replacement: 'POST /admin/clients/:id/sessions/revoke',
      call: post((id) => `/admin/customers/${id}/sessions/revoke`),
    },
    {
      key: 'POST /admin/customers/:id/suspend',
      replacement: 'PATCH /admin/clients/:id',
      call: post((id) => `/admin/customers/${id}/suspend`, { reason: 'Other', note: 'Paused.' }),
    },
    {
      key: 'POST /admin/customers/:id/reactivate',
      replacement: 'PATCH /admin/clients/:id',
      call: post((id) => `/admin/customers/${id}/reactivate`),
    },
    {
      key: 'POST /admin/customers/:id/block',
      replacement: 'POST /admin/clients/:id/block',
      call: post((id) => `/admin/customers/${id}/block`, { blocked: true, reason: 'Other' }),
    },
    {
      key: 'GET /admin/customers/:id/export',
      replacement: 'GET /admin/clients/:id/export',
      call: (id) => staff.get(`/admin/customers/${id}/export`),
    },
    {
      key: 'POST /admin/customers/:id/anonymize',
      replacement: 'POST /admin/clients/:id/anonymize',
      call: post((id) => `/admin/customers/${id}/anonymize`),
    },
  ];
};

/** What a retired route must leave alone: the account rows, the sessions, the links, the audit log, the blocklist and the data requests. */
async function footprint(ids: number[]) {
  const { db } = await testDb();
  return {
    accounts: await Promise.all(ids.map((id) => accountRow(id))),
    count: {
      clients: (await db.select({ id: s.clients.id }).from(s.clients)).length,
      sessions: (await db.select({ id: s.sessions.id }).from(s.sessions)).length,
      tokens: (await db.select({ id: s.authTokens.id }).from(s.authTokens)).length,
      audit: (await db.select({ id: s.auditLogs.id }).from(s.auditLogs)).length,
      blocklist: (await db.select({ id: s.blocklistEntries.id }).from(s.blocklistEntries)).length,
      requests: (await db.select({ id: s.dataRequests.id }).from(s.dataRequests)).length,
      outbox: (await db.select({ id: s.outboxEvents.id }).from(s.outboxEvents)).length,
    },
  };
}

describe('the twelve retired /admin/customers routes', () => {
  it('lists exactly twelve rows', () => {
    expect(routes()).toHaveLength(12);
    expect(new Set(routes().map((route) => route.key)).size).toBe(12);
  });

  it('answer 410 ROUTE_RETIRED, name the account route, and change nothing', async () => {
    const retail = await makeAccount({ rank: 'retail' });
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const merchant = await makeAccount({ rank: 'merchant' });
    const ids = [retail.id, guest.id, merchant.id];
    const before = await footprint(ids);
    for (const route of routes()) {
      for (const id of ids) {
        const res = await route.call(id);
        expect(res.status, `${route.key} ${id}`).toBe(410);
        expect(res.body.code, route.key).toBe('ROUTE_RETIRED');
        expect(res.body.detail, route.key).toContain(route.replacement);
      }
    }
    expect(await footprint(ids)).toEqual(before);
  });

  it('answer 410 for an id that matches nothing, and 422 first for an input their old contract refuses', async () => {
    const { status, body } = await staff.post('/admin/customers/999999/block', { blocked: true, reason: 'Other' });
    expect(status).toBe(410);
    expect(body.code).toBe('ROUTE_RETIRED');
    expect((await staff.get('/admin/customers/999999')).status).toBe(410);
    // The old contract still describes the route, so its validation runs before the handler: nothing is written either way.
    const before = await footprint([]);
    expect((await staff.post('/admin/customers/999999/block', { blocked: 'yes', reason: 7 })).status).toBe(422);
    expect((await staff.post('/admin/customers', {})).status).toBe(422);
    expect(await footprint([])).toEqual(before);
  });

  it('are still behind the access check: no session is 401, no permission 403, a mutation without the CSRF token 403', async () => {
    const account = await makeAccount({ rank: 'retail' });
    const reader = await adminWith(t, ['clients:read']);
    for (const route of routes()) {
      const [method, path] = route.key.split(' ') as ['GET' | 'POST' | 'PATCH', string];
      const url = path.replace(':id', String(account.id));
      expect((await staff.anonymous(method, url)).status, `${route.key} anonymous`).toBe(401);
      const refused = await reader.call(method, url, method === 'GET' ? undefined : {});
      expect(refused.status, `${route.key} without the permission`).toBe(403);
      if (method !== 'GET') {
        expect((await staff.withoutCsrf(method, url, {})).status, `${route.key} without the token`).toBe(403);
      }
    }
  });

  it('still asks the export to be started by the console itself', async () => {
    const account = await makeAccount({ rank: 'retail' });
    const res = await t.app.inject({
      method: 'GET',
      url: `/admin/customers/${account.id}/export`,
      headers: { ...staff.session.headers, 'sec-fetch-site': 'cross-site' },
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CSRF_FAILED');
  });
});
