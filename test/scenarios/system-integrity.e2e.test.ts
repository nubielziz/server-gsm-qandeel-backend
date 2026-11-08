// End-to-end walk of the map scenario `system-integrity` (a difference in the ledger, docs/slices/health.json), step by step on the real application and a real
// ledger. The steps share one story, so the tests of this file run in order. Steps 4 to 6 (maintenance mode while the difference is put right, the staff member
// keeps working in the console) belong to the platform feature. The check only reads: the ledger is the same at the end of every step.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { AlertNotifier, HealthJobsModule, LedgerIntegrityProcessor } from '../../src/modules/health';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { noticeOfCall, pick } from '../support/alerts';
import { ledgerTotals } from '../support/money';
import {
  mailbox,
  notificationRows,
  seedDefaultTemplates,
  sendAllQueued,
  telegramOutbox,
} from '../support/notifications';
import { ordersWorld, type OrdersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-06T02:30:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let fired: ReturnType<typeof spyOn>;
let resolved: ReturnType<typeof spyOn>;
let cleanNight: Date;

/** One run of the job as the worker takes it from the queue: a nightly tick, or the manual run a route inserted. */
const runJob = (data: object = {}) => t.app.get(LedgerIntegrityProcessor, { strict: false }).process({ data } as Job);
/** A session opened now: the story spans a day and a session of the morning would be gone by the evening. */
const console_ = () => adminWith(t, ['system:read', 'system:manage', 'alerts:read'], { name: 'Dana M.' });

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: {
      BULL_PREFIX: prefix,
      ALERTS_EMAIL_TO: 'ops@gsm.example',
      ALERTS_TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token',
    },
    imports: [HealthJobsModule],
  });
  await resetDb();
  await clearIdentityCaches(t);
  await seedDefaultTemplates((await testDb()).db);
  const notifier = t.app.get(AlertNotifier, { strict: false });
  fired = spyOn(notifier, 'fired');
  resolved = spyOn(notifier, 'resolved');
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['system:read', 'system:manage', 'alerts:*'], { name: 'Dana M.' });
  // The rule of the map: any ledger mismatch is critical, on Telegram and email.
  expect(
    (
      await staff.post('/admin/alert-rules', {
        key: 'ledger_mismatch',
        name: 'Ledger mismatch',
        metric: 'ledger.mismatch_count',
        comparator: 'gt',
        threshold: 0,
        windowSeconds: 60,
        severity: 'critical',
        channels: ['telegram', 'email'],
      })
    ).status,
  ).toBe(201);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('scenario system-integrity: a difference in the ledger', () => {
  it('step 1: at night the job ledger_integrity checks the ledger and stores the result in job_runs.result; a clean night raises nothing', async () => {
    const { db } = await testDb();
    const before = await ledgerTotals(db);
    await runJob();
    cleanNight = clock.now();
    const [run] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, 'ledger_integrity'));
    expect(run).toMatchObject({ trigger: 'schedule', status: 'succeeded', triggeredBy: null });
    expect(run!.result).toMatchObject({
      failedChecks: 0,
      mismatchCount: 0,
      entriesChecked: before.entries,
      transactionsChecked: before.transactions,
    });
    expect((run!.result as { checks: unknown[] }).checks).toHaveLength(4);
    expect(await db.$count(s.alertEvents)).toBe(0);
    expect(fired).not.toHaveBeenCalled();
    const report = (await (await console_()).get('/admin/system/integrity')).body;
    expect(report).toMatchObject({ result: 'pass', lastSuccessAt: cleanNight.toISOString() });
  });

  it('step 2: a merchant wallet no longer matches the sum of its lines: the ledger_mismatch rule fires as critical and its channels are told', async () => {
    const { db } = await testDb();
    // A wrong edit of the balance, as a bug or a manual change would leave it.
    await db.execute(
      sql`update ledger_accounts set balance = balance - 37.5 where kind = 'client_wallet' and owner_id = ${world.merchant.id}`,
    );
    clock.advance(DAY);
    await runJob();
    const [alert] = await db.select().from(s.alertEvents);
    expect(alert).toMatchObject({
      ruleName: 'Ledger mismatch',
      status: 'firing',
      severity: 'critical',
      value: '1.0000',
      subjectType: 'system',
      startedAt: clock.now(),
    });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(pick(noticeOfCall(fired), ['channels', 'severity', 'metric'])).toEqual({
      channels: ['telegram', 'email'],
      severity: 'critical',
      metric: 'ledger.mismatch_count',
    });
    // The messages name the account and the difference, and go out to the ops mailbox and chat.
    const rows = await notificationRows(db);
    expect(rows.map((row) => `${row.event}:${row.channel}:${row.status}`).sort()).toEqual([
      'alert.fired:email:queued',
      'alert.fired:telegram:queued',
    ]);
    const detail = 'The limit is above 0. Wallet · Cairo GSM Lab differs by 37.5000.';
    for (const row of rows)
      expect(row.payload).toMatchObject({ variables: { subject: 'Platform', value: '1', detail } });
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({
      to: 'ops@gsm.example',
      subject: 'Alert (critical): Ledger mismatch - Platform',
    });
    expect(mailbox(t).sent[0]!.text).toContain(detail);
    expect(telegramOutbox(t).sent).toEqual([
      {
        chatId: '-1001234567890',
        text: `ALERT critical: Ledger mismatch on Platform. ledger.mismatch_count is 1 (limit 0). ${detail}`,
      },
    ]);
  });

  it('step 3: staff open the details: the account, the difference, the last entry written and the time of the last successful check; nothing is corrected', async () => {
    const { db } = await testDb();
    const before = await ledgerTotals(db);
    const report = (await (await console_()).get('/admin/system/integrity')).body;
    expect(report).toMatchObject({ running: false, result: 'fail', lastSuccessAt: cleanNight.toISOString() });
    const accounts = report.checks.find((check: { key: string }) => check.key === 'accounts_match_lines');
    // Debit positive like POST /admin/ledger/reconcile: the wallet (credit-normal) shows 37.5 less than its lines, so stored minus expected is +37.5.
    expect(accounts).toMatchObject({ status: 'fail', count: 1, difference: '37.5000' });
    expect(accounts.findings).toEqual([
      {
        kind: 'account',
        id: expect.any(Number),
        ref: `client_wallet:${world.merchant.id}`,
        label: 'Wallet · Cairo GSM Lab',
        difference: '37.5000',
        ageSeconds: null,
        lastEntryAt: expect.any(String),
      },
    ]);
    expect(report.checks.filter((check: { status: string }) => check.status === 'pass')).toHaveLength(3);
    expect(await ledgerTotals(db)).toEqual(before);
    // The alert is open and visible to the staff of the alerts page.
    expect((await (await console_()).get('/admin/alerts?open=true')).body).toMatchObject([
      { status: 'firing', rule: { key: 'ledger_mismatch' } },
    ]);
  });

  it('step 7: after the reversing entry in Finance, staff rerun the check now: a background job answers 202, the result shows no difference and the alert closes', async () => {
    const { db } = await testDb();
    // Finance puts the wallet right (here: the balance matches its lines again).
    await db.execute(
      sql`update ledger_accounts set balance = balance + 37.5 where kind = 'client_wallet' and owner_id = ${world.merchant.id}`,
    );
    clock.advance(2 * HOUR);
    const api = await console_();
    const started = await api.post('/admin/system/integrity/run');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ job: 'ledger_integrity', trigger: 'manual', status: 'running' });
    expect((await api.get('/admin/system/integrity')).body).toMatchObject({ running: true });
    clock.advance(4_000);
    await runJob({ runId: started.body.id });

    const report = (await api.get('/admin/system/integrity')).body;
    expect(report).toMatchObject({ running: false, result: 'pass', lastSuccessAt: clock.now().toISOString() });
    expect(report.lastRun).toMatchObject({
      id: started.body.id,
      status: 'succeeded',
      durationMs: 4000,
      triggeredBy: { name: 'Dana M.' },
    });
    expect((await db.select().from(s.alertEvents))[0]).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
    expect(resolved).toHaveBeenCalledTimes(1);
    // The resolved message goes to the same two channels.
    expect(
      (await notificationRows(db))
        .filter((row) => row.event === 'alert.resolved')
        .map((row) => `${row.channel}:${row.status}`)
        .sort(),
    ).toEqual(['email:queued', 'telegram:queued']);
    expect((await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'ran job')))[0]).toMatchObject({
      entityLabel: 'ledger_integrity',
      actorId: expect.any(Number),
    });
  });
});
