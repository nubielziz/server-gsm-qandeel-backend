// Integration tests of the alert messages (feature 12b, through 12a; scenario system-alert steps 4 and 10, RULES health 6): one platform notification per
// rule channel to the ops mailbox and chat of the configuration, written in the same transaction as the alert change, repeated after the reminder interval
// until the alert is acknowledged, and sent again as "resolved" when the alert closes (also when its rule is switched off or deleted). Time is the TestClock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { AlertEvaluator, AlertNotifier, HealthJobsModule } from '../../src/modules/health';
import { type AddressedNotificationInput, NotificationService } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { addCalls, insertRule, insertSupplier } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  mailbox,
  notificationRows,
  seedDefaultTemplates,
  sendAllQueued,
  telegramOutbox,
} from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T10:00:00.000Z');
const EMAILS = 'ops@gsm.example,oncall@gsm.example';
const CHAT = '-1001234567890';

/** Boots an app that has (or lacks) the ops recipients of the configuration. */
const boot = (env: Record<string, string>) =>
  createTestApp({
    clock,
    env: {
      BULL_PREFIX: prefix,
      TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token',
      TELEGRAM_BOT_USERNAME: 'gsm_test_bot',
      ...env,
    },
    imports: [HealthJobsModule],
  });

const ago = (ms: number) => new Date(clock.nowMs() - ms);
const outbox = async () =>
  (await testDb()).db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'notification.send'));
const alerts = async () => (await testDb()).db.select().from(s.alertEvents).orderBy(s.alertEvents.id);
/** The notifications as `event:channel:status:dedupe suffix`, sorted, so a test reads what was written and nothing else. */
const written = async () =>
  (await notificationRows((await testDb()).db))
    .map((row) => `${row.event}:${row.channel}:${row.status}:${row.dedupeKey?.replace(/^alert-\d+:/, '')}`)
    .sort();

/** A critical rule on supplier timeouts and a supplier whose calls breach it, evaluated once: the alert is firing at the clock's time. */
async function firingAlert(t: TestApp, channels: Array<'telegram' | 'email'> = ['telegram', 'email']) {
  const { db } = await testDb();
  const rule = await insertRule(db, { key: 'supplier_timeout_rate', name: 'Supplier timeouts', channels });
  const supplier = await insertSupplier(db, 'Bosphorus Unlock');
  await addCalls(db, supplier, ['timeout', 'timeout', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'], ago(MINUTE));
  const evaluator = t.app.get(AlertEvaluator, { strict: false });
  await evaluator.evaluateAll();
  const [alert] = await alerts();
  return { rule, supplier, alert: alert!, evaluator };
}

describe('with the ops recipients configured', () => {
  let t: TestApp;
  let evaluator: AlertEvaluator;
  let staff: AdminApi;

  beforeAll(async () => {
    t = await boot({ ALERTS_EMAIL_TO: EMAILS, ALERTS_TELEGRAM_CHAT_ID: CHAT });
    evaluator = t.app.get(AlertEvaluator, { strict: false });
  });
  beforeEach(async () => {
    clock.set('2026-11-07T10:00:00.000Z');
    await resetDb();
    await clearIdentityCaches(t);
    await seedDefaultTemplates((await testDb()).db);
    mailbox(t).reset();
    telegramOutbox(t).reset();
    staff = await adminWith(t, ['alerts:*'], { name: 'Dana M.' });
  });
  afterAll(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
    await t.close();
  });

  describe('when an alert fires', () => {
    it('writes one queued notification per rule channel to the ops address and chat, with the words of the alert (scenario step 4)', async () => {
      const { alert } = await firingAlert(t);
      const rows = await notificationRows((await testDb()).db);
      expect(rows).toHaveLength(2);
      const variables = {
        ruleName: 'Supplier timeouts',
        severity: 'critical',
        metric: 'supplier.timeout_rate',
        value: '25%',
        threshold: '20%',
        subject: 'Supplier Bosphorus Unlock',
        detail: 'The limit is above 20% over 3 min.',
      };
      const email = rows.find((row) => row.channel === 'email')!;
      const telegram = rows.find((row) => row.channel === 'telegram')!;
      expect(email).toMatchObject({
        recipientType: 'staff',
        recipientId: 0,
        event: 'alert.fired',
        status: 'queued',
        error: null,
        dedupeKey: `alert-${alert.id}:fired:email`,
        payload: { to: EMAILS, variables },
        createdAt: clock.now(),
      });
      expect(telegram).toMatchObject({
        recipientType: 'staff',
        recipientId: 0,
        event: 'alert.fired',
        status: 'queued',
        dedupeKey: `alert-${alert.id}:fired:telegram`,
        payload: { chatId: CHAT, variables },
      });
      // Each queued row has its send event, written with it.
      expect((await outbox()).map((event) => event.aggregateId).sort()).toEqual([email.id, telegram.id].sort());
    });

    it('sends the email to every configured address and the Telegram message to the chat, with the wording of the default templates', async () => {
      await firingAlert(t);
      expect((await sendAllQueued(t)).map((outcome) => outcome.outcome)).toEqual(['sent', 'sent']);
      expect(mailbox(t).sent).toHaveLength(1);
      expect(mailbox(t).sent[0]).toMatchObject({
        to: EMAILS,
        subject: 'Alert (critical): Supplier timeouts - Supplier Bosphorus Unlock',
      });
      expect(mailbox(t).sent[0]!.text).toContain('supplier.timeout_rate is 25% (limit 20%).');
      expect(mailbox(t).sent[0]!.text).toContain('The limit is above 20% over 3 min.');
      expect(telegramOutbox(t).sent).toEqual([
        {
          chatId: CHAT,
          text: 'ALERT critical: Supplier timeouts on Supplier Bosphorus Unlock. supplier.timeout_rate is 25% (limit 20%). The limit is above 20% over 3 min.',
        },
      ]);
    });

    it('writes one message for a rule with one channel', async () => {
      await firingAlert(t, ['email']);
      expect(await written()).toEqual(['alert.fired:email:queued:fired:email']);
    });

    it('never writes a second message for an alert that is already open, however often it is evaluated or whether runs overlap', async () => {
      await firingAlert(t);
      await Promise.all([evaluator.evaluateAll(), evaluator.evaluateAll()]);
      clock.advance(MINUTE);
      await evaluator.evaluateAll();
      expect(await written()).toEqual([
        'alert.fired:email:queued:fired:email',
        'alert.fired:telegram:queued:fired:telegram',
      ]);
    });

    it('opens no alert when its message cannot be written: the alert and its notifications commit together or not at all', async () => {
      const { db } = await testDb();
      await insertRule(db, { name: 'Supplier timeouts' });
      const supplier = await insertSupplier(db, 'Bosphorus Unlock');
      await addCalls(db, supplier, ['timeout', 'timeout', 'ok'], ago(MINUTE));
      const notifier = t.app.get(AlertNotifier, { strict: false });
      const original = notifier.fired.bind(notifier);
      const spy = spyOn(notifier, 'fired').mockImplementationOnce(async (work, notice) => {
        await original(work, notice);
        throw new Error('The queue went away after the notifications were written.');
      });
      await expectRejection(evaluator.evaluateAll(), 'The queue went away');
      expect(await alerts()).toEqual([]);
      expect(await notificationRows(db)).toEqual([]);
      expect(await outbox()).toEqual([]);
      // The next run does all of it again.
      expect((await evaluator.evaluateAll()).fired).toBe(1);
      expect(await alerts()).toHaveLength(1);
      expect(await notificationRows(db)).toHaveLength(2);
      spy.mockRestore();
    });
  });

  describe('NotificationService.enqueueToAddress', () => {
    const service = () => t.app.get(NotificationService);
    const enqueue = (input: AddressedNotificationInput) =>
      t.app.get(DbService).runInTransaction((work) => service().enqueueToAddress(work, input));
    const base = {
      event: 'alert.fired',
      channel: 'email' as const,
      to: 'ops@gsm.example',
      noRecipientReason: 'No alert recipient is configured for email.',
      variables: { ruleName: 'Rule' },
      dedupeKey: 'alert-1:fired:email',
    };

    it('writes a row once per dedupe key: the same occurrence again makes no second row and no second event', async () => {
      expect(await enqueue(base)).toMatchObject({ status: 'queued', created: true });
      expect(await enqueue(base)).toMatchObject({ status: 'queued', created: false });
      expect(await notificationRows((await testDb()).db)).toHaveLength(1);
      expect(await outbox()).toHaveLength(1);
    });

    it('refuses an event that is not a staff event and a channel the event does not offer (a programming error)', async () => {
      await expectRejection(
        enqueue({ ...base, event: 'wallet.low_balance' }),
        /not registered for the audience "staff"/,
      );
      await expectRejection(enqueue({ ...base, event: 'nope.nothing' }), RangeError);
      expect(await notificationRows((await testDb()).db)).toEqual([]);
    });

    it('sends nothing, and says so, when the event has no template', async () => {
      const { db } = await testDb();
      await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'alert.fired'));
      expect(await enqueue(base)).toEqual({ status: 'skipped', reason: 'no_template' });
      expect(await notificationRows(db)).toEqual([]);
    });

    it('records a blank recipient as failed, whatever the spaces', async () => {
      expect(await enqueue({ ...base, to: '   ' })).toMatchObject({
        status: 'failed',
        created: true,
        reason: base.noRecipientReason,
      });
      expect(await enqueue({ ...base, to: undefined })).toMatchObject({ status: 'failed', created: false });
    });
  });

  describe('reminders (RULES health 6: repeated only after the reminder interval, until acknowledged)', () => {
    it('repeats the message once per 30 minutes while nobody acknowledges, with the round in the detail', async () => {
      const { alert } = await firingAlert(t);
      clock.advance(29 * MINUTE);
      await evaluator.evaluateAll();
      expect(await notificationRows((await testDb()).db)).toHaveLength(2);
      clock.advance(MINUTE);
      await evaluator.evaluateAll();
      await evaluator.evaluateAll();
      expect(await written()).toEqual([
        'alert.fired:email:queued:fired:email',
        'alert.fired:email:queued:reminder-1:email',
        'alert.fired:telegram:queued:fired:telegram',
        'alert.fired:telegram:queued:reminder-1:telegram',
      ]);
      const reminder = (await notificationRows((await testDb()).db)).find(
        (row) => row.dedupeKey === `alert-${alert.id}:reminder-1:email`,
      )!;
      expect(reminder.payload).toMatchObject({
        to: EMAILS,
        variables: { detail: 'Reminder 1: still firing since 2026-11-07 10:00 UTC and not acknowledged.' },
      });
      clock.advance(30 * MINUTE);
      await evaluator.evaluateAll();
      expect((await written()).filter((entry) => entry.includes('reminder-2'))).toHaveLength(2);
    });

    it('sends one reminder, not one for each interval it missed, when the worker was down for hours', async () => {
      await firingAlert(t);
      clock.advance(2 * HOUR + 10 * MINUTE);
      await evaluator.evaluateAll();
      expect((await written()).filter((entry) => entry.includes('reminder'))).toEqual([
        'alert.fired:email:queued:reminder-4:email',
        'alert.fired:telegram:queued:reminder-4:telegram',
      ]);
    });

    it('stops once a staff member acknowledges the alert, and the alert stays open', async () => {
      const { alert } = await firingAlert(t);
      expect((await staff.post(`/admin/alerts/${alert.id}/ack`, {})).status).toBe(200);
      clock.advance(31 * MINUTE);
      await evaluator.evaluateAll();
      clock.advance(HOUR);
      await evaluator.evaluateAll();
      expect(await written()).toHaveLength(2);
      expect((await alerts())[0]!.status).toBe('acknowledged');
    });

    it('waits while the rule is muted and repeats when the mute ends', async () => {
      const { rule } = await firingAlert(t);
      const { db } = await testDb();
      await db
        .update(s.alertRules)
        .set({ mutedUntil: new Date(clock.nowMs() + 2 * HOUR) })
        .where(eq(s.alertRules.id, rule.id));
      clock.advance(31 * MINUTE);
      await evaluator.evaluateAll();
      expect(await written()).toHaveLength(2);
      await db.update(s.alertRules).set({ mutedUntil: null }).where(eq(s.alertRules.id, rule.id));
      await evaluator.evaluateAll();
      expect((await written()).filter((entry) => entry.includes('reminder-1'))).toHaveLength(2);
    });
  });

  describe('when an alert closes', () => {
    it('sends the resolved message to the same channels when the value has been back in range for three minutes (scenario step 10)', async () => {
      const { alert, supplier } = await firingAlert(t);
      const { db } = await testDb();
      for (let minute = 0; minute < 6; minute += 1) {
        clock.advance(MINUTE);
        await addCalls(db, supplier, ['ok'], ago(10_000));
        await evaluator.evaluateAll();
      }
      expect((await alerts())[0]!.status).toBe('resolved');
      const resolved = (await notificationRows(db)).filter((row) => row.event === 'alert.resolved');
      expect(resolved.map((row) => row.channel).sort()).toEqual(['email', 'telegram']);
      expect(resolved.find((row) => row.channel === 'email')).toMatchObject({
        status: 'queued',
        dedupeKey: `alert-${alert.id}:resolved:email`,
        payload: {
          to: EMAILS,
          variables: {
            ruleName: 'Supplier timeouts',
            value: '0%',
            threshold: '20%',
            detail: 'The value is back in range.',
          },
        },
      });
      await sendAllQueued(t);
      expect(mailbox(t).sent.map((mail) => mail.subject)).toContain(
        'Resolved: Supplier timeouts - Supplier Bosphorus Unlock',
      );
      expect(telegramOutbox(t).sent.map((message) => message.text)).toContain(
        'RESOLVED: Supplier timeouts on Supplier Bosphorus Unlock. supplier.timeout_rate is 0% (limit 20%). The value is back in range.',
      );
    });

    it('sends the resolved message of every open alert when its rule is switched off, in the same transaction as the change', async () => {
      const { rule, alert } = await firingAlert(t);
      const res = await staff.patch(`/admin/alert-rules/${rule.id}`, { isActive: false });
      expect(res.status).toBe(200);
      expect((await alerts())[0]).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
      const resolved = (await notificationRows((await testDb()).db)).filter((row) => row.event === 'alert.resolved');
      expect(resolved.map((row) => row.dedupeKey).sort()).toEqual([
        `alert-${alert.id}:resolved:email`,
        `alert-${alert.id}:resolved:telegram`,
      ]);
      expect(resolved[0]!.payload).toMatchObject({
        variables: { ruleName: 'Supplier timeouts', value: '25%', detail: 'The rule was switched off.' },
      });
      // Nothing more is repeated for it afterwards.
      clock.advance(HOUR);
      await evaluator.evaluateAll();
      expect(await written()).toHaveLength(4);
    });

    it('sends the resolved message when its rule is deleted, and none for a rule with no open alert', async () => {
      const { rule } = await firingAlert(t);
      const quiet = await insertRule((await testDb()).db, {
        key: 'quiet',
        name: 'Quiet rule',
        metric: 'supplier.balance',
      });
      expect((await staff.delete(`/admin/alert-rules/${quiet.id}`)).status).toBe(204);
      expect(await written()).toHaveLength(2);
      expect((await staff.delete(`/admin/alert-rules/${rule.id}`)).status).toBe(204);
      const resolved = (await notificationRows((await testDb()).db)).filter((row) => row.event === 'alert.resolved');
      expect(resolved).toHaveLength(2);
      expect(resolved[0]!.payload).toMatchObject({ variables: { detail: 'The rule was deleted.' } });
    });

    it('sends the resolved message when the rule is changed to watch another metric', async () => {
      const { rule } = await firingAlert(t, ['email']);
      const res = await staff.patch(`/admin/alert-rules/${rule.id}`, { metric: 'api.p95', threshold: 1000 });
      expect(res.status).toBe(200);
      const [resolved] = (await notificationRows((await testDb()).db)).filter((row) => row.event === 'alert.resolved');
      expect(resolved!.payload).toMatchObject({
        variables: { metric: 'supplier.timeout_rate', detail: 'The rule now watches another metric.' },
      });
    });

    it('sends the resolved message of an alert whose subject is gone, saying so', async () => {
      const { supplier } = await firingAlert(t, ['email']);
      const { db } = await testDb();
      await db.update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, supplier));
      await evaluator.evaluateAll();
      const [resolved] = (await notificationRows(db)).filter((row) => row.event === 'alert.resolved');
      expect(resolved!.payload).toMatchObject({
        variables: { detail: 'Its subject no longer exists, so there is nothing left to measure.' },
      });
    });
  });

  describe('the notification log', () => {
    it('shows the messages with the ops address and chat masked, in the list and in the payload of one message', async () => {
      await firingAlert(t);
      const owner = await adminWith(t, ['*']);
      const list = await owner.get('/admin/notifications');
      expect(list.status).toBe(200);
      const byChannel = new Map<string, { id: number; recipient: string; recipientType: string }>(
        list.body.map((row: { channel: string; id: number; recipient: string; recipientType: string }) => [
          row.channel,
          row,
        ]),
      );
      expect(byChannel.get('email')).toMatchObject({
        recipientType: 'staff',
        recipient: 'o***@gsm.example, o***@gsm.example',
      });
      expect(byChannel.get('telegram')).toMatchObject({ recipientType: 'staff', recipient: '@-***' });
      const one = await owner.get(`/admin/notifications/${byChannel.get('email')!.id}`);
      expect(one.body.payload.to).toBe('o***@gsm.example, o***@gsm.example');
      const text = JSON.stringify([list.body, one.body]);
      expect(text).not.toContain('ops@gsm.example');
      expect(text).not.toContain('oncall@gsm.example');
      expect(text).not.toContain('1001234567890');
    });
  });

  describe('templates', () => {
    it('sends nothing for a message whose template is switched off, and still opens the alert', async () => {
      const { db } = await testDb();
      await db
        .update(s.notificationTemplates)
        .set({ isActive: false })
        .where(eq(s.notificationTemplates.event, 'alert.fired'));
      await firingAlert(t);
      expect(await alerts()).toHaveLength(1);
      expect(await notificationRows(db)).toEqual([]);
    });

    it('shows the alert templates among the staff templates, editable by staff', async () => {
      const owner = await adminWith(t, ['*']);
      const res = await owner.get('/admin/notification-templates?audience=staff');
      expect(res.status).toBe(200);
      const keys = res.body.map((row: { event: string; channel: string }) => `${row.event}:${row.channel}`).sort();
      expect(keys).toEqual([
        'alert.fired:email',
        'alert.fired:telegram',
        'alert.resolved:email',
        'alert.resolved:telegram',
      ]);
    });
  });
});

describe('without ops recipients', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await boot({});
  });
  beforeEach(async () => {
    clock.set('2026-11-07T10:00:00.000Z');
    await resetDb();
    await clearIdentityCaches(t);
    await seedDefaultTemplates((await testDb()).db);
    mailbox(t).reset();
    telegramOutbox(t).reset();
  });
  afterAll(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
    await t.close();
    await closeTestDb();
  });

  it('records each message as failed with the reason, sends nothing and still opens the alert', async () => {
    const { alert } = await firingAlert(t);
    expect(alert.status).toBe('firing');
    const rows = await notificationRows((await testDb()).db);
    expect(rows.map((row) => [row.channel, row.status, row.error]).sort()).toEqual([
      ['email', 'failed', 'No alert recipient is configured for email.'],
      ['telegram', 'failed', 'No alert recipient is configured for telegram.'],
    ]);
    expect(rows.every((row) => row.attempts === 0 && row.sentAt === null)).toBe(true);
    expect(await outbox()).toEqual([]);
    expect(await sendAllQueued(t)).toEqual([]);
    expect(mailbox(t).sent).toEqual([]);
    expect(telegramOutbox(t).sent).toEqual([]);
  });

  it('records the failure once per occurrence: a second evaluation, then the reminder round, add no duplicate', async () => {
    await firingAlert(t, ['email']);
    await t.app.get(AlertEvaluator, { strict: false }).evaluateAll();
    expect(await written()).toEqual(['alert.fired:email:failed:fired:email']);
    clock.advance(31 * MINUTE);
    await t.app.get(AlertEvaluator, { strict: false }).evaluateAll();
    expect(await written()).toEqual([
      'alert.fired:email:failed:fired:email',
      'alert.fired:email:failed:reminder-1:email',
    ]);
  });
});

describe('with only the email configured', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await boot({ ALERTS_EMAIL_TO: 'ops@gsm.example' });
  });
  beforeEach(async () => {
    clock.set('2026-11-07T10:00:00.000Z');
    await resetDb();
    await clearIdentityCaches(t);
    await seedDefaultTemplates((await testDb()).db);
    mailbox(t).reset();
    telegramOutbox(t).reset();
  });
  afterAll(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
    await t.close();
    await closeTestDb();
  });

  it('sends the email and records only the Telegram message as failed', async () => {
    await firingAlert(t);
    expect(await written()).toEqual([
      'alert.fired:email:queued:fired:email',
      'alert.fired:telegram:failed:fired:telegram',
    ]);
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => mail.to)).toEqual(['ops@gsm.example']);
    expect(telegramOutbox(t).sent).toEqual([]);
  });
});
