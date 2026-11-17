// Integration tests of the recovery email job and the automatic reminder (feature 19): the mail a `checkout.recovery` event becomes (the
// link, the device, the name, and a token that is stored nowhere), the last look before it goes out, retries and repeats, and the
// reminder's tick: who is due, the same claim as the manual send, its run record and its audit entry.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { JobSchedulerRegistry } from '../../src/infra/queues';
import { JobRunsService } from '../../src/modules/health';
import { CHECKOUT_RECOVERY_SCHEDULER } from '../../src/modules/customers';
import { RecoverySweep } from '../../src/modules/customers/application/recovery-sweep';
import { dueRecoveryIds } from '../../src/modules/customers/infra/recovery.repository';
import {
  CHECKOUT_RECOVERY_SWEEP_JOB,
  CheckoutRecoverySweepProcessor,
} from '../../src/modules/customers/jobs/checkout-recovery.processors';
import { DeliveryError, NotificationService, SettingsReader } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertAbandoned, insertRecoveryTemplate, recoveryJobs, runRecoveryMail } from '../support/growth';
import { mailbox, notificationRows } from '../support/notifications';
import { expectRejection } from '../support/rejection';
import {
  APPLE_IMEI,
  UNKNOWN_TAC_IMEI,
  insertStoreOrder,
  storefrontWorld,
  type StorefrontWorld,
} from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;
let world: StorefrontWorld;

const ago = (ms: number) => new Date(clock.nowMs() - ms);
const serviceId = () => world.icloud.serviceId;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(SettingsReader).invalidate();
  mailbox(t).reset();
  const { db } = await testDb();
  world = await storefrontWorld(db);
  await insertRecoveryTemplate(db);
  await db.insert(s.tacCatalog).values({
    tac: '35389011',
    brand: 'Apple',
    model: 'A2633',
    marketingName: 'iPhone 13',
    releaseYear: 2021,
    source: 'demo',
  });
  admin = await adminWith(t, ['growth:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Reads a checkout session row (its `recoveryEmailedAt` is the claim of the recovery mail). */
async function claimOf(db: Awaited<ReturnType<typeof testDb>>['db'], sessionId: number) {
  return (await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, sessionId)))[0];
}

/** Makes a due checkout, queues its recovery through the route, and returns the job the relay would add. */
async function queued(changes: Partial<Parameters<typeof insertAbandoned>[2]> = {}) {
  const { db } = await testDb();
  const checkout = await insertAbandoned(t, db, {
    serviceId: serviceId(),
    createdAt: ago(2 * 60 * MINUTE),
    ...changes,
  });
  const res = await admin.post('/admin/checkouts/recover', { ids: [checkout.sessionId] });
  expect(res.body.sent).toBe(1);
  const job = (await recoveryJobs(db)).find((row) => row.aggregateId === checkout.sessionId)!;
  return { checkout, job, db };
}

describe('the recovery mail job', () => {
  it('sends the mail to the customer with the link back to the basket, the device of the IMEI and the name, and keeps the token out of every row', async () => {
    const { checkout, job, db } = await queued({ name: 'Sam Cole', imei: APPLE_IMEI, email: 'sam@mail.example' });
    expect(await runRecoveryMail(t, job)).toEqual({ sent: true });
    const [mail] = mailbox(t).sent;
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mail?.to).toBe('sam@mail.example');
    expect(mail?.subject).toBe('You left something behind');
    expect(mail?.text).toBe(
      `Hi Sam Cole, you started an unlock for iPhone 13 and did not finish paying. Pick up where you left off: http://localhost:5175/checkout/resume?token=${checkout.token}`,
    );

    const rows = await notificationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: checkout.customerId,
      channel: 'email',
      event: 'checkout.abandoned',
      status: 'sent',
      dedupeKey: `outbox-${job.eventId}:email`,
      payload: { variables: { customerName: 'Sam Cole', device: 'iPhone 13' } },
    });
    // The token is a bearer secret: not in the notification row, the outbox row, or the audit entry.
    const stored = JSON.stringify([rows, await db.select().from(s.outboxEvents), await db.select().from(s.auditLogs)]);
    expect(stored).not.toContain(checkout.token);
    expect(stored).not.toContain('checkout/resume');
  });

  it('greets a guest without a name as "there" and names the device "your phone" when it has no IMEI or the catalogue lacks its TAC', async () => {
    const noImei = await queued({});
    await runRecoveryMail(t, noImei.job);
    const unknown = await queued({ imei: UNKNOWN_TAC_IMEI });
    await runRecoveryMail(t, unknown.job);
    expect(mailbox(t).sent.map((mail) => mail.text.split(' Pick up')[0])).toEqual([
      'Hi there, you started an unlock for your phone and did not finish paying.',
      'Hi there, you started an unlock for your phone and did not finish paying.',
    ]);
  });

  it('sends once when the job runs twice', async () => {
    const { job, db } = await queued({ imei: APPLE_IMEI });
    expect(await runRecoveryMail(t, job)).toEqual({ sent: true });
    expect(await runRecoveryMail(t, job)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect(await notificationRows(db)).toHaveLength(1);
  });

  it('retries a transient failure on the same row and sends on a later attempt; a refusal that cannot change fails the row for good', async () => {
    const first = await queued({ imei: APPLE_IMEI });
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(runRecoveryMail(t, first.job, 0), 'The mail server is busy.');
    expect((await notificationRows(first.db))[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await runRecoveryMail(t, first.job, 1)).toEqual({ sent: true });
    expect((await notificationRows(first.db))[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(mailbox(t).sent).toHaveLength(1);

    const second = await queued({});
    mailbox(t).failNext(new DeliveryError('550 5.1.1 The mailbox does not exist.', { permanent: true }));
    expect(await runRecoveryMail(t, second.job)).toEqual({
      sent: false,
      failed: '550 5.1.1 The mailbox does not exist.',
    });
    expect(await runRecoveryMail(t, second.job)).toEqual({ sent: false, skipped: 'already_failed' });
    expect(mailbox(t).sent).toHaveLength(1);
  });

  it('checks consent again at send time: a consent withdrawn after the claim sends nothing and makes no notification row', async () => {
    const { checkout, job, db } = await queued({});
    await db.insert(s.consentRecords).values({
      subjectType: 'customer',
      subjectId: checkout.customerId!,
      purpose: 'marketing',
      granted: false,
      ip: '203.0.113.7',
      createdAt: ago(0),
    });
    expect(await runRecoveryMail(t, job)).toEqual({ sent: false, skipped: 'no_marketing_consent' });
    expect(mailbox(t).sent).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
    // Nothing was sent, so the checkout must not look emailed: the claim is taken off again.
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).toBeNull();
  });

  it('takes the claim off a checkout whose mail ended skipped, so it shows as recoverable and a later send can try again', async () => {
    const { checkout, job, db } = await queued({});
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).not.toBeNull();
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'checkout.abandoned'));
    expect(await runRecoveryMail(t, job)).toEqual({ sent: false, skipped: 'template_off' });
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).toBeNull();
    const listed = await admin.get('/admin/checkouts/abandoned');
    expect(listed.body.find((row: { id: number }) => row.id === checkout.sessionId)).toMatchObject({
      canRecover: true,
      recoveryEmailedAt: null,
    });

    // Staff switch the template on and send again: a new event, and this time the mail goes out.
    await db.update(s.notificationTemplates).set({ isActive: true });
    expect((await admin.post('/admin/checkouts/recover', { ids: [checkout.sessionId] })).body.sent).toBe(1);
    const again = (await recoveryJobs(db)).at(-1)!;
    expect(again.eventId).not.toBe(job.eventId);
    expect(await runRecoveryMail(t, again)).toEqual({ sent: true });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).not.toBeNull();
  });

  it('takes the claim off for each reason the job ends skipped: a customer who is no longer active, a checkout paid meanwhile', async () => {
    const suspended = await queued({});
    await suspended.db
      .update(s.customers)
      .set({ status: 'suspended' })
      .where(eq(s.customers.id, suspended.checkout.customerId!));
    expect(await runRecoveryMail(t, suspended.job)).toEqual({ sent: false, skipped: 'recipient_suspended' });
    expect((await claimOf(suspended.db, suspended.checkout.sessionId))?.recoveryEmailedAt).toBeNull();

    const paid = await queued({});
    await paid.db
      .update(s.checkoutSessions)
      .set({ orderId: await insertStoreOrder(paid.db, serviceId(), paid.checkout.customerId!), status: 'paid' })
      .where(eq(s.checkoutSessions.id, paid.checkout.sessionId));
    expect(await runRecoveryMail(t, paid.job)).toEqual({ sent: false, skipped: 'already_paid' });
    expect((await claimOf(paid.db, paid.checkout.sessionId))?.recoveryEmailedAt).toBeNull();
  });

  it('keeps the claim when a mail of the event was sent, even if a repeat of the job then finds the checkout paid', async () => {
    const { checkout, job, db } = await queued({});
    expect(await runRecoveryMail(t, job)).toEqual({ sent: true });
    expect(await runRecoveryMail(t, job)).toEqual({ sent: false, skipped: 'already_sent' });
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).not.toBeNull();
    // The customer pays after the mail; the queue runs the job again (an acknowledgement lost). The row is `sent`: the claim stays.
    await db
      .update(s.checkoutSessions)
      .set({ orderId: await insertStoreOrder(db, serviceId(), checkout.customerId!), status: 'paid' })
      .where(eq(s.checkoutSessions.id, checkout.sessionId));
    expect(await runRecoveryMail(t, job)).toEqual({ sent: false, skipped: 'already_paid' });
    expect((await claimOf(db, checkout.sessionId))?.recoveryEmailedAt).not.toBeNull();
    expect(mailbox(t).sent).toHaveLength(1);
  });

  it('writes with the one template of the event as it stands when the mail goes out, for every customer', async () => {
    const { db } = await testDb();
    const mailTo = async (name: string) => {
      mailbox(t).reset();
      const { job } = await queued({ name });
      expect(await runRecoveryMail(t, job)).toEqual({ sent: true });
      return mailbox(t).sent[0];
    };
    expect((await mailTo('Sam Cole'))?.subject).toBe('You left something behind');
    // Staff change the template's text: the next mail is written with it, whoever the customer is (templates have no language).
    await db
      .update(s.notificationTemplates)
      .set({ subject: 'Your unlock is waiting', body: 'Hi {{customerName}}, finish here: {{link}}' })
      .where(eq(s.notificationTemplates.event, 'checkout.abandoned'));
    const changed = await mailTo('Dana Price');
    expect(changed?.subject).toBe('Your unlock is waiting');
    expect(changed?.text).toStartWith('Hi Dana Price, finish here: http://localhost:5175/checkout/resume?token=');
    expect(changed?.html).toBeUndefined();
  });

  it('ends skipped when the template was switched off or deleted after the checkout was queued, and the claim goes back', async () => {
    const { db } = await testDb();
    const off = await queued({});
    await db.update(s.notificationTemplates).set({ isActive: false });
    expect(await runRecoveryMail(t, off.job)).toEqual({ sent: false, skipped: 'template_off' });
    expect((await claimOf(db, off.checkout.sessionId))?.recoveryEmailedAt).toBeNull();

    await db.update(s.notificationTemplates).set({ isActive: true });
    const gone = await queued({});
    await db.delete(s.notificationTemplates);
    expect(await runRecoveryMail(t, gone.job)).toEqual({ sent: false, skipped: 'no_template' });
    expect((await claimOf(db, gone.checkout.sessionId))?.recoveryEmailedAt).toBeNull();
    expect(mailbox(t).sent).toEqual([]);
  });

  it('sends nothing for a checkout that was paid meanwhile, a customer who was suspended meanwhile, or one that is gone', async () => {
    const paid = await queued({});
    await paid.db
      .update(s.checkoutSessions)
      .set({ orderId: await insertStoreOrder(paid.db, serviceId(), paid.checkout.customerId!), status: 'paid' })
      .where(eq(s.checkoutSessions.id, paid.checkout.sessionId));
    expect(await runRecoveryMail(t, paid.job)).toEqual({ sent: false, skipped: 'already_paid' });

    const suspended = await queued({});
    await suspended.db
      .update(s.customers)
      .set({ status: 'suspended' })
      .where(eq(s.customers.id, suspended.checkout.customerId!));
    expect(await runRecoveryMail(t, suspended.job)).toEqual({ sent: false, skipped: 'recipient_suspended' });

    expect(await runRecoveryMail(t, { ...paid.job, aggregateId: 987_654 })).toEqual({
      sent: false,
      skipped: 'session_gone',
    });
    await expectRejection(runRecoveryMail(t, { ...paid.job, aggregateId: 0 }), 'without a checkout session');
    expect(mailbox(t).sent).toEqual([]);
  });

  it('finishes the row of an earlier attempt as failed when a later attempt finds the template switched off', async () => {
    const { job, db } = await queued({});
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(runRecoveryMail(t, job, 0), 'busy');
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'checkout.abandoned'));
    expect(await runRecoveryMail(t, job, 1)).toEqual({ sent: false, skipped: 'template_off' });
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'failed', error: 'template_off' });
    // The row failed without a mail: the checkout is free to be reminded again.
    expect((await claimOf(db, job.aggregateId))?.recoveryEmailedAt).toBeNull();
  });

  it('ends the row and takes the claim off in one transaction: a failure between the two leaves both as they were, and the retry finishes both', async () => {
    const { job, db } = await queued({});
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(runRecoveryMail(t, job, 0), 'busy');
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'checkout.abandoned'));

    // The status read inside the finishing transaction fails once (a lost connection); the read of the job's own decision is untouched.
    const notifications = t.app.get(NotificationService);
    const statusOf = notifications.statusOf.bind(notifications);
    let broken = false;
    const spy = spyOn(notifications, 'statusOf').mockImplementation(async (key, executor) => {
      if (executor !== undefined && !broken) {
        broken = true;
        throw new Error('connection lost');
      }
      return statusOf(key, executor);
    });
    try {
      await expectRejection(runRecoveryMail(t, job, 1), 'connection lost');
    } finally {
      spy.mockRestore();
    }
    // Rolled back together: the row is still queued and the claim still set, so the retry has something to finish.
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'queued' });
    expect((await claimOf(db, job.aggregateId))?.recoveryEmailedAt).not.toBeNull();

    expect(await runRecoveryMail(t, job, 2)).toEqual({ sent: false, skipped: 'template_off' });
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'failed', error: 'template_off' });
    expect((await claimOf(db, job.aggregateId))?.recoveryEmailedAt).toBeNull();
  });
});

describe('the automatic reminder', () => {
  const tick = () => t.app.get(CheckoutRecoverySweepProcessor).process({ data: {} } as never);
  const runsOf = async () => {
    const { db } = await testDb();
    return db.select().from(s.jobRuns).where(eq(s.jobRuns.job, CHECKOUT_RECOVERY_SWEEP_JOB));
  };

  it('is scheduled every five minutes on the maintenance queue', () => {
    const spec = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((entry) => entry.id === CHECKOUT_RECOVERY_SCHEDULER);
    expect(spec).toMatchObject({ queue: 'maintenance', jobName: CHECKOUT_RECOVERY_SWEEP_JOB, pattern: '*/5 * * * *' });
  });

  it('emails the due checkouts of customers who agreed once, and leaves the rest', async () => {
    const { db } = await testDb();
    const due = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    const young = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(10 * MINUTE) });
    const silent = await insertAbandoned(t, db, {
      serviceId: serviceId(),
      createdAt: ago(2 * 60 * MINUTE),
      consent: 'none',
    });
    const old = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(31 * DAY) });

    expect(await tick()).toEqual({ due: 1, queued: 1, skipped: 0 });
    const claimed = async (id: number) =>
      (await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, id)))[0]?.recoveryEmailedAt;
    expect((await claimed(due.sessionId))?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    for (const other of [young, silent, old]) expect(await claimed(other.sessionId)).toBeNull();
    const jobs = await recoveryJobs(db);
    expect(jobs.map((job) => job.aggregateId)).toEqual([due.sessionId]);

    // The tick is recorded, and audited as the system.
    expect(await runsOf()).toHaveLength(1);
    expect((await runsOf())[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    const audit = (await db.select().from(s.auditLogs)).filter(
      (row) => row.action === 'sent automatic recovery emails',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'system',
      entityType: 'checkout',
      entityLabel: '1 abandoned checkouts',
    });

    // The same tick again finds nothing and writes no run; the mail job sends the one email.
    expect(await tick()).toEqual({ due: 0, queued: 0, skipped: 0 });
    expect(await runsOf()).toHaveLength(1);
    expect(await runRecoveryMail(t, jobs[0]!)).toEqual({ sent: true });
    expect(mailbox(t).sent).toHaveLength(1);

    // Once only across both paths: a staff send after the reminder is already_emailed.
    const manual = await admin.post('/admin/checkouts/recover', { ids: [due.sessionId] });
    expect(manual.body).toEqual({ sent: 0, skipped: [{ id: due.sessionId, reason: 'already_emailed' }] });

    // The young checkout becomes due as the clock moves on.
    clock.advance(51 * MINUTE);
    expect(await tick()).toEqual({ due: 1, queued: 1, skipped: 0 });
    expect((await recoveryJobs(db)).map((job) => job.aggregateId)).toEqual([due.sessionId, young.sessionId]);
  });

  it('waits the abandonedMinutes setting', async () => {
    const { db } = await testDb();
    await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(90 * MINUTE) });
    await db.insert(s.settings).values({ key: 'abandonedMinutes', value: 120 });
    await t.app.get(SettingsReader).invalidate();
    expect(await tick()).toEqual({ due: 0, queued: 0, skipped: 0 });
    clock.advance(31 * MINUTE);
    expect(await tick()).toEqual({ due: 1, queued: 1, skipped: 0 });
  });

  it('claims nothing, and does not even select the checkouts, while the email has no active template; it takes them as soon as it has one', async () => {
    const { db } = await testDb();
    const a = await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(2 * 60 * MINUTE) });
    await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(3 * 60 * MINUTE) });
    await db.update(s.notificationTemplates).set({ isActive: false });
    expect(await tick()).toEqual({ due: 0, queued: 0, skipped: 0 });
    expect(await recoveryJobs(db)).toEqual([]);
    await db.update(s.notificationTemplates).set({ isActive: true });
    expect(await tick()).toEqual({ due: 2, queued: 2, skipped: 0 });
    expect((await recoveryJobs(db)).map((job) => job.aggregateId)).toContain(a.sessionId);
  });

  it('selects nothing while the template is off or missing, so checkouts that cannot be mailed never fill the batch', async () => {
    const { db } = await testDb();
    const rows = [];
    for (const hours of [9, 8, 7, 2])
      rows.push(await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(hours * 60 * MINUTE) }));
    const sweep = t.app.get(RecoverySweep);
    // The selection itself has no language: the oldest due checkouts, up to the limit.
    expect(await dueRecoveryIds(db, { now: clock.now(), delayMinutes: 60 }, 3)).toEqual(
      rows.slice(0, 3).map((row) => row.sessionId),
    );
    // The one template of the event decides for every checkout at once.
    await db.update(s.notificationTemplates).set({ isActive: false });
    expect(await sweep.due()).toEqual([]);
    await db.delete(s.notificationTemplates);
    expect(await sweep.due()).toEqual([]);
    // A customer email of another event, or the event for another audience, does not make the reminder writable.
    await insertRecoveryTemplate(db, { event: 'support.reply' });
    await insertRecoveryTemplate(db, { audience: 'merchant' });
    expect(await sweep.due()).toEqual([]);
    expect(await tick()).toEqual({ due: 0, queued: 0, skipped: 0 });
    for (const row of rows) expect((await claimOf(db, row.sessionId))?.recoveryEmailedAt).toBeNull();

    // On again: every due checkout is selectable, oldest first.
    await insertRecoveryTemplate(db);
    expect(await sweep.due()).toEqual(rows.map((row) => row.sessionId));
  });

  it('takes the oldest first and no more than the batch limit', async () => {
    const { db } = await testDb();
    const rows = [];
    for (const hours of [5, 3, 4, 2])
      rows.push(await insertAbandoned(t, db, { serviceId: serviceId(), createdAt: ago(hours * 60 * MINUTE) }));
    const ids = await dueRecoveryIds(db, { now: clock.now(), delayMinutes: 60 }, 3);
    expect(ids).toEqual([rows[0]!.sessionId, rows[2]!.sessionId, rows[1]!.sessionId]);
    expect(await t.app.get(RecoverySweep).due()).toHaveLength(4);
  });

  it('records a manual run even when nothing is due, on the row the console inserted', async () => {
    const { db } = await testDb();
    const run = await t.app.get(JobRunsService).start({ job: CHECKOUT_RECOVERY_SWEEP_JOB, trigger: 'manual' });
    const result = await t.app.get(CheckoutRecoverySweepProcessor).process({ data: { runId: run.id } } as never);
    expect(result).toEqual({ due: 0, queued: 0, skipped: 0 });
    const [row] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.id, run.id));
    expect(row).toMatchObject({ trigger: 'manual', status: 'succeeded', processed: 0 });
  });
});
