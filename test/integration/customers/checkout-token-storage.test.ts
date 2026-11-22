// The checkout token at rest (decision 054): a new session keeps it only as a keyed hash and an encrypted copy, a session stored as issued
// before still opens, the one-off seal pass converts the old rows once, and the recovery mail of a sealed session carries its link.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { CheckoutTokenSeal, CheckoutTokenSealModule } from '@src/modules/customers';
import { SettingsReader } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { revealedToken, tokenHashOf } from '../../support/capability-tokens';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertAbandoned, insertRecoveryTemplate, recoveryJobs, runRecoveryMail } from '../../support/growth';
import { mailbox } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS, type StorefrontWorld, storefrontWorld } from '../../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let db: Database;
let world: StorefrontWorld;
let admin: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [CheckoutTokenSealModule] });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(SettingsReader).invalidate();
  mailbox(t).reset();
  world = await storefrontWorld(db);
  admin = await adminWith(t, ['growth:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const show = (token: string) =>
  t.app.inject({ method: 'GET', url: `/store/v1/checkout-sessions/${token}`, remoteAddress: freshClientIp() });
const sessionRow = async (id: number) =>
  (await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, id)))[0]!;

describe('the checkout token at rest', () => {
  it('stores a new checkout token only as a keyed hash and an encrypted copy', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/store/v1/checkout-sessions',
      headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
      remoteAddress: freshClientIp(),
      payload: { serviceId: world.icloud.serviceId, email: 'sam@mail.example', country: 'GB', imei: APPLE_IMEI },
    });
    expect(res.statusCode).toBe(201);
    const token = res.json<{ token: string }>().token;
    const [row] = await db.select().from(s.checkoutSessions);
    expect(row!.token).toBeNull();
    expect(row!.tokenHash).toBe(tokenHashOf(t, 'checkout', token));
    expect(row!.tokenEnc).not.toContain(token);
    expect(revealedToken(t, 'checkout', { enc: row!.tokenEnc, plain: row!.token })).toBe(token);
    const shown = await show(token);
    expect(shown.statusCode).toBe(200);
    expect(shown.json<{ token: string }>().token).toBe(token);
  });

  it('still opens a session stored as issued', async () => {
    const old = await insertAbandoned(t, db, { serviceId: world.icloud.serviceId, createdAt: clock.now() });
    const res = await show(old.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ token: string }>().token).toBe(old.token);
  });

  it('the seal pass converts the old rows once', async () => {
    const first = await insertAbandoned(t, db, { serviceId: world.icloud.serviceId, createdAt: clock.now() });
    const second = await insertAbandoned(t, db, { serviceId: world.icloud.serviceId, createdAt: clock.now() });
    const before = await sessionRow(first.sessionId);
    const sealed = await t.app.inject({
      method: 'POST',
      url: '/store/v1/checkout-sessions',
      headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
      remoteAddress: freshClientIp(),
      payload: { serviceId: world.icloud.serviceId, email: 'new@mail.example', country: 'GB', imei: APPLE_IMEI },
    });
    expect(sealed.statusCode).toBe(201);

    expect(await t.app.get(CheckoutTokenSeal).run()).toEqual({ sealed: 2, unchanged: 0 });
    for (const old of [first, second]) {
      const row = await sessionRow(old.sessionId);
      expect(row.token).toBeNull();
      expect(row.tokenHash).toBe(tokenHashOf(t, 'checkout', old.token));
      expect((await show(old.token)).statusCode).toBe(200);
    }
    expect((await sessionRow(first.sessionId)).updatedAt).toEqual(before.updatedAt);
    expect(await t.app.get(CheckoutTokenSeal).run()).toEqual({ sealed: 0, unchanged: 0 });
  });

  it('the recovery mail carries the link of a sealed session', async () => {
    await insertRecoveryTemplate(db);
    const checkout = await insertAbandoned(t, db, {
      serviceId: world.icloud.serviceId,
      createdAt: new Date(clock.nowMs() - 120 * MINUTE),
      email: 'sam@mail.example',
    });
    await t.app.get(CheckoutTokenSeal).run();
    expect((await sessionRow(checkout.sessionId)).token).toBeNull();
    const res = await admin.post('/admin/checkouts/recover', { ids: [checkout.sessionId] });
    expect(res.body.sent).toBe(1);
    const job = (await recoveryJobs(db)).find((row) => row.aggregateId === checkout.sessionId)!;
    expect(await runRecoveryMail(t, job)).toEqual({ sent: true });
    expect(mailbox(t).sent[0]!.text).toContain(`/checkout/resume?token=${checkout.token}`);
  });
});
