// Integration tests of what the retirement of the abandoned-checkouts list and the reminder leaves behind (decision 062): the two routes are
// gone, the two permissions are not in the catalog, nothing routes, registers or schedules the reminder (and the worker removes its old
// scheduler), and what the old feature wrote (a marked checkout, a stored delay) does not break a read. The funnel report stays.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { NotificationEventRegistry, OutboxRouteRegistry } from '@src/modules/platform';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertCheckout } from '../../support/growth';
import { freshClientIp } from '../../support/pipeline-routes';
import { storefrontWorld } from '../../support/storefront';
import { WorkerModule } from '@src/worker.module';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('the retired abandoned-checkouts list and reminder', () => {
  it('serves neither route: even the owner finds nothing at them', async () => {
    const owner = await adminWith(t, ['*']);
    expect((await owner.get('/admin/checkouts/abandoned?_start=0&_end=10')).status).toBe(404);
    expect((await owner.post('/admin/checkouts/recover', { ids: [1] })).status).toBe(404);
  });

  it('has no growth permission in the catalog, so a role cannot hold one, while the funnel report keeps its own', async () => {
    const admin = await adminWith(t, ['roles:read', 'roles:create']);
    const keys = (await admin.get('/admin/permissions')).body.map((permission: { key: string }) => permission.key);
    expect(keys.filter((key: string) => key.startsWith('growth:'))).toEqual([]);
    expect(keys).toContain('reports:growth');
    for (const retired of ['growth:read', 'growth:send']) {
      const res = await admin.post('/admin/roles', { name: `Holds ${retired}`, permissions: [retired] });
      expect(res.status, retired).toBe(422);
      expect(res.body.errors[0], retired).toMatchObject({ field: 'permissions' });
    }
  });

  it('has no outbox route, no mail event and no scheduler for the reminder, and lists its old scheduler as retired', () => {
    expect(t.app.get(OutboxRouteRegistry).routesOf('checkout.recovery')).toEqual([]);
    expect(t.app.get(NotificationEventRegistry).has('checkout.abandoned')).toBe(false);
    const schedulers = t.app.get(JobSchedulerRegistry);
    expect(schedulers.list().map((scheduler) => scheduler.id)).not.toContain('checkout-recovery-sweep');
    // The line that retires it is in the worker's root module (its scheduler runner removes the old scheduler from Redis when it starts):
    // run that hook on this app's registry.
    new WorkerModule(schedulers).onModuleInit();
    expect(schedulers.retired()).toContainEqual({ queue: 'maintenance', id: 'checkout-recovery-sweep' });
  });

  it('refuses a template for the retired mail: the event is unknown', async () => {
    const owner = await adminWith(t, ['*']);
    const res = await owner.post('/admin/notification-templates', {
      event: 'checkout.abandoned',
      channel: 'email',
      audience: 'customer',
      subject: 'You left something behind',
      body: 'Hi {{customerName}}, your basket is saved.',
      isActive: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'event' });
  });

  it('still reads a checkout that the old reminder marked: the funnel counts it and its link opens', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const marked = await insertCheckout(t, db, {
      serviceId: world.icloud.serviceId,
      createdAt: new Date(clock.nowMs() - 10 * MINUTE),
    });
    await db
      .update(s.checkoutSessions)
      .set({ recoveryEmailedAt: new Date(clock.nowMs() - 5 * MINUTE) })
      .where(eq(s.checkoutSessions.id, marked.sessionId));
    const reports = await adminWith(t, ['reports:growth']);
    const funnel = await reports.get('/admin/reports/funnel?days=7');
    expect(funnel.status).toBe(200);
    expect(funnel.body.paymentStarted).toBe(1);
    const shown = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${marked.token}`,
      remoteAddress: freshClientIp(),
    });
    expect(shown.statusCode).toBe(200);
  });

  it('ignores a stored delay of the reminder: the policies answer without it', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values({ key: 'abandonedMinutes', value: 90 });
    const staff = await adminWith(t, ['settings:storefront']);
    const res = await staff.patch('/admin/storefront/settings', { guestCheckout: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guestCheckout: false });
  });
});
