// Integration tests of the abandoned checkouts and the recovery send (feature 19): GET /admin/checkouts/abandoned and
// POST /admin/checkouts/recover against the real API: the list scope and rows, the filters and sorts, the one rule behind the row
// flag, the filter and the send, the claim that makes a recovery email once-only, and the audit entry.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { SettingsReader } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertAbandoned, insertRecoveryTemplate, recoveryEventCount } from '../support/growth';
import { insertStoreOrder, storefrontWorld, type StorefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;
let world: StorefrontWorld;

const ago = (ms: number) => new Date(clock.nowMs() - ms);

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(SettingsReader).invalidate();
  const { db } = await testDb();
  world = await storefrontWorld(db);
  await insertRecoveryTemplate(db);
  admin = await adminWith(t, ['growth:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const serviceId = () => world.icloud.serviceId;

/** The rows of the list, by id. */
async function listAll(query = '') {
  const res = await admin.get(`/admin/checkouts/abandoned?_start=0&_end=200${query}`);
  expect(res.status).toBe(200);
  return res;
}
const flagOf = (rows: Array<{ id: number; canRecover: boolean }>, id: number) =>
  rows.find((row) => row.id === id)?.canRecover;

describe('GET /admin/checkouts/abandoned', () => {
  it('lists a row the way the console reads it: masked email, USD basket with the locked rate, service, status judged on the clock, consent and verdict', async () => {
    const { db } = await testDb();
    const a = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(2 * 60 * MINUTE),
      email: 'alex.stone@mail.example',
      gross: '4.7900',
      currency: 'GBP',
      fxRate: '0.80185000',
      utm: { source: 'Blog' },
    });
    const res = await listAll();
    expect(res.total).toBe(1);
    expect(res.body[0]).toEqual({
      id: a.sessionId,
      email: 'al•••@mail.example',
      grossAmount: '4.7900',
      fxRate: '0.80185000',
      currencyCode: 'GBP',
      serviceName: 'iCloud Clean / Lost Check',
      // Stored open, but its 30 minutes ran out: every reader sees it expired, with no job having flipped the column.
      status: 'expired',
      utm: { source: 'Blog' },
      createdAt: '2026-11-07T10:00:00.000Z',
      recoveryEmailedAt: null,
      orderId: null,
      marketingConsent: true,
      canRecover: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('alex.stone');
  });

  it('judges the status on the injected clock: open inside the 30 minutes, expired after', async () => {
    const { db } = await testDb();
    await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(10 * MINUTE) });
    expect((await listAll()).body[0]).toMatchObject({ status: 'open', canRecover: false });
    clock.advance(21 * MINUTE);
    expect((await listAll()).body[0]).toMatchObject({ status: 'expired' });
  });

  it('lists the unpaid checkouts of the last 30 days and the paid ones that were emailed, newest first, and leaves the rest out', async () => {
    const { db } = await testDb();
    const order = async (customerId: number) => insertStoreOrder(db, serviceId(), customerId);
    const recent = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(3 * 60 * MINUTE) });
    const older = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(5 * DAY) });
    const edge = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(30 * DAY) });
    await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(30 * DAY + MINUTE) });
    const paidQuietly = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * DAY) });
    await db
      .update(s.checkoutSessions)
      .set({ orderId: await order(paidQuietly.customerId!), status: 'paid' })
      .where(eq(s.checkoutSessions.id, paidQuietly.sessionId));
    const recovered = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(4 * DAY) });
    await db
      .update(s.checkoutSessions)
      .set({
        orderId: await order(recovered.customerId!),
        status: 'paid',
        recoveryEmailedAt: ago(4 * DAY - 60 * MINUTE),
      })
      .where(eq(s.checkoutSessions.id, recovered.sessionId));
    const paidByStatus = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(DAY), status: 'paid' });

    const res = await listAll();
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([
      recent.sessionId,
      recovered.sessionId,
      older.sessionId,
      edge.sessionId,
    ]);
    expect(res.total).toBe(4);
    expect(res.body[1]).toMatchObject({ status: 'paid', orderId: expect.any(Number), canRecover: false });
    expect(res.body.map((row: { id: number }) => row.id)).not.toContain(paidByStatus.sessionId);
  });

  it('pages with _start/_end and reports the exact total', async () => {
    const { db } = await testDb();
    for (let i = 0; i < 5; i += 1)
      await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago((i + 2) * 60 * MINUTE) });
    const page = await admin.get('/admin/checkouts/abandoned?_start=1&_end=3');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('sorts by createdAt, grossAmount and recoveryEmailedAt (nulls last either way)', async () => {
    const { db } = await testDb();
    const cheap = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(5 * 60 * MINUTE),
      gross: '1.5000',
    });
    const dear = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(4 * 60 * MINUTE),
      gross: '9.0000',
      recoveryEmailedAt: ago(3 * 60 * MINUTE),
    });
    const mid = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(3 * 60 * MINUTE),
      gross: '4.0000',
      recoveryEmailedAt: ago(2 * 60 * MINUTE),
    });
    const ids = async (query: string) => (await listAll(query)).body.map((row: { id: number }) => row.id);
    expect(await ids('&_sort=createdAt&_order=asc')).toEqual([cheap.sessionId, dear.sessionId, mid.sessionId]);
    expect(await ids('&_sort=grossAmount&_order=desc')).toEqual([dear.sessionId, mid.sessionId, cheap.sessionId]);
    expect(await ids('&_sort=recoveryEmailedAt&_order=asc')).toEqual([dear.sessionId, mid.sessionId, cheap.sessionId]);
    expect(await ids('&_sort=recoveryEmailedAt&_order=desc')).toEqual([mid.sessionId, dear.sessionId, cheap.sessionId]);
    expect((await admin.get('/admin/checkouts/abandoned?_sort=email')).status).toBe(422);
  });

  it('searches the FULL email, ignoring case, while the rows carry it masked', async () => {
    const { db } = await testDb();
    const target = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(2 * 60 * MINUTE),
      email: 'Tom.Hidden37@inbox.example',
    });
    await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(2 * 60 * MINUTE),
      email: 'other@mail.example',
    });
    const res = await listAll('&q=hidden37');
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([target.sessionId]);
    expect(res.total).toBe(1);
    expect(res.body[0].email).toBe('To•••@inbox.example');
    // `%` and `_` in the text match themselves.
    expect((await listAll('&q=%25')).body).toEqual([]);
  });

  it('takes the delay from the abandonedMinutes setting (default 60) and falls back when the value is not a whole number from 5 to 1440', async () => {
    const { db } = await testDb();
    const session = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(90 * MINUTE) });
    expect(flagOf((await listAll()).body, session.sessionId)).toBe(true);
    await db.insert(s.settings).values({ key: 'abandonedMinutes', value: 120 });
    await t.app.get(SettingsReader).invalidate();
    expect(flagOf((await listAll()).body, session.sessionId)).toBe(false);
    expect((await listAll('&canRecover=true')).total).toBe(0);
    await db.update(s.settings).set({ value: 3 }).where(eq(s.settings.key, 'abandonedMinutes'));
    await t.app.get(SettingsReader).invalidate();
    expect(flagOf((await listAll()).body, session.sessionId)).toBe(true);
  });

  it('needs growth:read, and a signed-out caller is 401', async () => {
    const { db } = await testDb();
    await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    const outsider = await adminWith(t, ['growth:send']);
    const refused = await outsider.get('/admin/checkouts/abandoned');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect((await outsider.anonymous('GET', '/admin/checkouts/abandoned')).status).toBe(401);
    expect((await (await adminWith(t, ['growth:read'])).get('/admin/checkouts/abandoned')).status).toBe(200);
  });
});

describe('the one rule behind canRecover, the filter and the send', () => {
  /** Makes one checkout per state of the rule and says what the rule must answer for each. */
  async function states() {
    const { db } = await testDb();
    const make = (changes: Partial<Parameters<typeof insertAbandoned>[2]>) =>
      insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE), ...changes });
    const paid = async (changes: Partial<Parameters<typeof insertAbandoned>[2]>) => {
      const row = await make(changes);
      await db
        .update(s.checkoutSessions)
        .set({ orderId: await insertStoreOrder(db, serviceId(), row.customerId!), status: 'paid' })
        .where(eq(s.checkoutSessions.id, row.sessionId));
      return row;
    };
    const due = await make({});
    const dueStoredExpired = await make({ status: 'expired' });
    const oldestInside = await make({ createdAt: ago(30 * DAY) });
    const tooRecent = await make({ createdAt: ago(10 * MINUTE) });
    const noRecord = await make({ consent: 'none' });
    const withdrawn = await make({ consent: 'withdrawn' });
    const switchedOff = await make({ optIn: false });
    const emailed = await make({ recoveryEmailedAt: ago(60 * MINUTE) });
    const paidAndEmailed = await paid({ recoveryEmailedAt: ago(60 * MINUTE) });
    const paidWithOrder = await paid({});
    const paidByStatus = await make({ status: 'paid' });
    const suspended = await make({ customerStatus: 'suspended' });
    const blocked = await make({ customerStatus: 'blocked' });
    const noCustomer = await make({ noCustomer: true });
    const tooOld = await make({ createdAt: ago(30 * DAY + MINUTE) });
    return {
      expected: new Map<number, string | null>([
        [due.sessionId, null],
        [dueStoredExpired.sessionId, null],
        [oldestInside.sessionId, null],
        [tooRecent.sessionId, 'too_recent'],
        [noRecord.sessionId, 'no_marketing_consent'],
        [withdrawn.sessionId, 'no_marketing_consent'],
        [switchedOff.sessionId, 'no_marketing_consent'],
        [emailed.sessionId, 'already_emailed'],
        [paidAndEmailed.sessionId, 'already_emailed'],
        [paidWithOrder.sessionId, 'already_paid'],
        [paidByStatus.sessionId, 'already_paid'],
        [suspended.sessionId, 'recipient_suspended'],
        [blocked.sessionId, 'recipient_suspended'],
        [noCustomer.sessionId, 'no_marketing_consent'],
        [tooOld.sessionId, 'expired'],
      ]),
      listed: [
        due,
        dueStoredExpired,
        oldestInside,
        tooRecent,
        noRecord,
        withdrawn,
        switchedOff,
        emailed,
        paidAndEmailed,
        suspended,
        blocked,
        noCustomer,
      ].map((row) => row.sessionId),
    };
  }

  it('gives the same answer in the row flag, the canRecover filter and the send, for every state of the rule', async () => {
    const { expected, listed } = await states();
    const all = await listAll();
    // Only the unpaid checkouts of the last 30 days, and the paid one that was emailed, are listed.
    expect(all.body.map((row: { id: number }) => row.id).sort()).toEqual([...listed].sort());
    const flagged = all.body
      .filter((row: { canRecover: boolean }) => row.canRecover)
      .map((row: { id: number }) => row.id);
    expect(flagged.sort()).toEqual(
      [...expected]
        .filter(([, reason]) => reason === null)
        .map(([id]) => id)
        .sort(),
    );

    const yes = await listAll('&canRecover=true');
    expect(yes.body.map((row: { id: number }) => row.id).sort()).toEqual([...flagged].sort());
    expect(yes.total).toBe(flagged.length);
    const no = await listAll('&canRecover=false');
    expect(no.total).toBe(listed.length - flagged.length);

    const ids = [...expected.keys()];
    const sent = await admin.post('/admin/checkouts/recover', { ids });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(flagged.length);
    expect(sent.body.skipped).toHaveLength(ids.length - flagged.length);
    for (const row of sent.body.skipped as Array<{ id: number; reason: string }>) {
      expect(row.reason, `checkout ${row.id}`).toBe(expected.get(row.id) ?? 'wrong');
    }
    // The list agrees afterwards: nothing is left to recover.
    expect((await listAll('&canRecover=true')).total).toBe(0);
  });
});

describe('POST /admin/checkouts/recover', () => {
  it('claims each eligible checkout once, queues one event for it, answers in the order asked, and audits the call', async () => {
    const { db } = await testDb();
    const first = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(3 * 60 * MINUTE) });
    const second = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    const gone = 999_999;
    const res = await admin.post('/admin/checkouts/recover', { ids: [second.sessionId, gone, first.sessionId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, skipped: [{ id: gone, reason: 'not_found' }] });

    const rows = await db.select().from(s.checkoutSessions).orderBy(s.checkoutSessions.id);
    for (const row of rows) expect(row.recoveryEmailedAt?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(await recoveryEventCount(db, first.sessionId)).toBe(1);
    expect(await recoveryEventCount(db, second.sessionId)).toBe(1);
    // The event carries ids only: the checkout token, which is a secret, is nowhere in it.
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'checkout.recovery'));
    expect(JSON.stringify(events)).not.toContain(first.token);
    expect(events.map((event) => event.aggregateType)).toEqual(['checkout_sessions', 'checkout_sessions']);

    const audit = (await db.select().from(s.auditLogs)).filter((row) => row.action === 'sent recovery emails');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: 'checkout',
      entityLabel: '2 abandoned checkouts',
      actorType: 'staff',
      actorId: admin.staffId,
      before: { emails: 0 },
      after: { emails: 2, checkoutIds: [second.sessionId, first.sessionId], skipped: 1 },
    });
    expect(JSON.stringify(audit[0])).not.toContain('@mail.example');
  });

  it('mails a checkout once: a second call, or a repeated id, is already_emailed and writes no second event', async () => {
    const { db } = await testDb();
    const a = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    const twice = await admin.post('/admin/checkouts/recover', { ids: [a.sessionId, a.sessionId, a.sessionId] });
    expect(twice.body).toEqual({ sent: 1, skipped: [] });
    const again = await admin.post('/admin/checkouts/recover', { ids: [a.sessionId] });
    expect(again.body).toEqual({ sent: 0, skipped: [{ id: a.sessionId, reason: 'already_emailed' }] });
    expect(await recoveryEventCount(db, a.sessionId)).toBe(1);
    // A call that sent nothing is still 200 and still audited.
    const audits = (await db.select().from(s.auditLogs)).filter((row) => row.action === 'sent recovery emails');
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      entityLabel: '0 abandoned checkouts',
      after: { emails: 0, checkoutIds: [], skipped: 1 },
    });
  });

  it('two sends over the same checkouts at once mail each checkout once and never deadlock', async () => {
    const { db } = await testDb();
    const rows = [];
    for (let i = 0; i < 6; i += 1)
      rows.push(await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago((i + 2) * 60 * MINUTE) }));
    const ids = rows.map((row) => row.sessionId);
    const other = await adminWith(t, ['growth:send']);
    const results = await Promise.all([
      admin.post('/admin/checkouts/recover', { ids }),
      other.post('/admin/checkouts/recover', { ids: [...ids].reverse() }),
      admin.post('/admin/checkouts/recover', { ids: ids.slice(0, 3) }),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    expect(results.reduce((sum, res) => sum + res.body.sent, 0)).toBe(6);
    for (const id of ids) expect(await recoveryEventCount(db, id)).toBe(1);
  });

  it('leaves a checkout unclaimed and says why when its email has no template, or the template is off', async () => {
    const { db } = await testDb();
    const a = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    const b = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(3 * 60 * MINUTE) });
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'checkout.abandoned'));
    const off = await admin.post('/admin/checkouts/recover', { ids: [a.sessionId, b.sessionId] });
    expect(off.body).toEqual({
      sent: 0,
      skipped: [
        { id: a.sessionId, reason: 'template_off' },
        { id: b.sessionId, reason: 'template_off' },
      ],
    });
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'checkout.abandoned'));
    const missing = await admin.post('/admin/checkouts/recover', { ids: [a.sessionId] });
    expect(missing.body.skipped).toEqual([{ id: a.sessionId, reason: 'no_template' }]);
    const [row] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, a.sessionId));
    expect(row?.recoveryEmailedAt).toBeNull();
    expect(await recoveryEventCount(db, a.sessionId)).toBe(0);
    // Once staff add the template, the same checkout can still be reminded.
    await insertRecoveryTemplate(db);
    expect((await admin.post('/admin/checkouts/recover', { ids: [a.sessionId] })).body.sent).toBe(1);
  });

  it("writes to a customer in the English template when the customer's own language has none, or has it switched off", async () => {
    const { db } = await testDb();
    const none = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(2 * 60 * MINUTE),
      locale: 'ar',
    });
    expect((await admin.post('/admin/checkouts/recover', { ids: [none.sessionId] })).body).toEqual({
      sent: 1,
      skipped: [],
    });
    await insertRecoveryTemplate(db, { locale: 'ar', isActive: false });
    const off = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(3 * 60 * MINUTE), locale: 'ar' });
    expect((await admin.post('/admin/checkouts/recover', { ids: [off.sessionId] })).body).toEqual({
      sent: 1,
      skipped: [],
    });
  });

  it("skips a checkout only when its language's template and the English one are both missing or switched off", async () => {
    const { db } = await testDb();
    const ar = () => insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE), locale: 'ar' });
    const english = eq(s.notificationTemplates.locale, 'en');
    await insertRecoveryTemplate(db, { locale: 'ar', isActive: false });

    // The language's template is off and so is the English one.
    await db.update(s.notificationTemplates).set({ isActive: false }).where(english);
    const bothOff = await ar();
    expect((await admin.post('/admin/checkouts/recover', { ids: [bothOff.sessionId] })).body.skipped).toEqual([
      { id: bothOff.sessionId, reason: 'template_off' },
    ]);

    // The language's template is off and the English one is gone.
    await db.delete(s.notificationTemplates).where(english);
    const englishGone = await ar();
    expect((await admin.post('/admin/checkouts/recover', { ids: [englishGone.sessionId] })).body.skipped).toEqual([
      { id: englishGone.sessionId, reason: 'template_off' },
    ]);

    // Neither exists.
    await db.delete(s.notificationTemplates);
    const neither = await ar();
    expect((await admin.post('/admin/checkouts/recover', { ids: [neither.sessionId] })).body.skipped).toEqual([
      { id: neither.sessionId, reason: 'no_template' },
    ]);
  });

  it('refuses a body with no ids, too many, or ids that are not ids, with a 422 on `ids`', async () => {
    const empty = await admin.post('/admin/checkouts/recover', { ids: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0]).toMatchObject({ field: 'ids', message: 'Choose at least one checkout.' });
    const tooMany = await admin.post('/admin/checkouts/recover', { ids: Array.from({ length: 101 }, (_, i) => i + 1) });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors[0].field).toBe('ids');
    for (const bad of [[0], [-3], [1.5], ['7'], [null]]) {
      const res = await admin.post('/admin/checkouts/recover', { ids: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.errors[0].field).toMatch(/^ids/);
    }
    expect((await admin.post('/admin/checkouts/recover', {})).status).toBe(422);
    const hundred = await admin.post('/admin/checkouts/recover', { ids: Array.from({ length: 100 }, (_, i) => i + 1) });
    expect(hundred.status).toBe(200);
    expect(hundred.body.skipped).toHaveLength(100);
  });

  it('needs growth:send and a CSRF token', async () => {
    const reader = await adminWith(t, ['growth:read']);
    const refused = await reader.post('/admin/checkouts/recover', { ids: [1] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    const sender = await adminWith(t, ['growth:send']);
    expect((await sender.withoutCsrf('POST', '/admin/checkouts/recover', { ids: [1] })).status).toBe(403);
    expect((await sender.post('/admin/checkouts/recover', { ids: [1] })).status).toBe(200);
  });
});
