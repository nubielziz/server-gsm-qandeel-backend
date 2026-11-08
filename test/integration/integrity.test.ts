// Integration tests of the money integrity check (feature 12b, scenario system-integrity): GET /admin/system/integrity, POST
// /admin/system/integrity/run, the four checks on a real ledger and the worker job that runs them (MISMATCHES B99; resolutions health-commissions-9,
// -16, -17; ANSWERS system-health Q35, Q36). The check only reads: every test asserts that nothing was corrected.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { AlertNotifier, HealthJobsModule, INTEGRITY_JOB, LedgerIntegrityProcessor } from '../../src/modules/health';
import { order, postTransaction } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { insertRule, noticeOfCall, pick } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant, ledgerTotals } from '../support/money';
import { insertOrderRow, ordersWorld, type OrdersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;
let manager: AdminApi;
let reader: AdminApi;
let world: OrdersWorld;
let fired: ReturnType<typeof spyOn>;
let resolved: ReturnType<typeof spyOn>;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [HealthJobsModule] });
  const notifier = t.app.get(AlertNotifier, { strict: false });
  fired = spyOn(notifier, 'fired');
  resolved = spyOn(notifier, 'resolved');
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  fired.mockClear();
  resolved.mockClear();
  manager = await adminWith(t, ['system:read', 'system:manage'], { name: 'Rami K.' });
  reader = await adminWith(t, ['system:read'], { name: 'Omar T.' });
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const processor = () => t.app.get(LedgerIntegrityProcessor, { strict: false });
/** Runs the job like the worker does: a nightly tick, or the manual run the route inserted. */
const runJob = (data: object = {}) => processor().process({ data } as Job);
const runs = async () =>
  (await testDb()).db.select().from(s.jobRuns).where(eq(s.jobRuns.job, INTEGRITY_JOB)).orderBy(s.jobRuns.id);
/** The report, read with a session opened now: tests move the clock far, and a session left from before would have expired. */
const report = async () => (await (await adminWith(t, ['system:read'])).get('/admin/system/integrity')).body;
const checkOf = (body: { checks: Array<{ key: string }> }, key: string) =>
  body.checks.find((check) => check.key === key) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON

describe('GET /admin/system/integrity before any run', () => {
  it('answers four unknown checks in the map order and a null last run, not an error', async () => {
    const res = await reader.get('/admin/system/integrity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      running: false,
      runningSince: null,
      lastRun: null,
      lastSuccessAt: null,
      result: 'unknown',
      checks: [
        {
          key: 'entries_balanced',
          label: 'Every entry sums to zero',
          status: 'unknown',
          count: 0,
          difference: null,
          findings: [],
        },
        {
          key: 'accounts_match_lines',
          label: 'Every account balance equals the sum of its lines',
          status: 'unknown',
          count: 0,
          difference: null,
          findings: [],
        },
        {
          key: 'stuck_holds',
          label: 'No hold is stuck for more than 24 hours',
          status: 'unknown',
          count: 0,
          difference: null,
          findings: [],
        },
        {
          key: 'payments_without_entry',
          label: 'Every confirmed payment has an entry',
          status: 'unknown',
          count: 0,
          difference: null,
          findings: [],
        },
      ],
    });
  });

  it('needs system:read', async () => {
    const nobody = await adminWith(t, ['alerts:read']);
    const res = await nobody.get('/admin/system/integrity');
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('system:read');
  });
});

describe('POST /admin/system/integrity/run', () => {
  it('starts a manual run: 202 with the running JobRun, a job on the maintenance queue, the audit entry (scenario system-integrity step 7)', async () => {
    const res = await manager.post('/admin/system/integrity/run');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      id: expect.any(Number),
      job: 'ledger_integrity',
      startedAt: '2026-11-07T10:00:00.000Z',
      finishedAt: null,
      durationMs: 0,
      processed: 0,
      trigger: 'manual',
      status: 'running',
      error: null,
      result: {},
      triggeredBy: { id: manager.staffId, name: 'Rami K.' },
    });
    const job = await t.app.get(QueuesService, { strict: false }).queue('maintenance').getJob(`manual-${res.body.id}`);
    expect(job?.name).toBe('ledger_integrity');
    expect(job?.data).toMatchObject({ runId: res.body.id });
    const { db } = await testDb();
    expect((await db.select().from(s.auditLogs))[0]).toMatchObject({
      action: 'ran job',
      entityType: 'job',
      entityLabel: 'ledger_integrity',
      actorId: manager.staffId,
      after: { runId: res.body.id },
    });
    // The report says a run is going, and since when; the last run stays empty until one finishes.
    expect(await report()).toMatchObject({
      running: true,
      runningSince: '2026-11-07T10:00:00.000Z',
      lastRun: null,
      result: 'unknown',
    });
  });

  it('answers 409 JOB_ALREADY_RUNNING while a manual or a nightly run is going, and starts again once it ended', async () => {
    const first = await manager.post('/admin/system/integrity/run');
    const refused = await manager.post('/admin/system/integrity/run');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('JOB_ALREADY_RUNNING');
    await runJob({ runId: first.body.id });
    expect((await manager.post('/admin/system/integrity/run')).status).toBe(202);
    // A nightly run in progress refuses too.
    const { db } = await testDb();
    await db
      .update(s.jobRuns)
      .set({ status: 'succeeded', finishedAt: clock.now() })
      .where(sql`status = 'running'`);
    await db
      .insert(s.jobRuns)
      .values({ job: 'ledger_integrity', trigger: 'schedule', status: 'running', startedAt: clock.now() });
    expect((await manager.post('/admin/system/integrity/run')).status).toBe(409);
  });

  it('needs system:manage (403 naming it), a CSRF token and a session', async () => {
    const denied = await reader.post('/admin/system/integrity/run');
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('system:manage');
    expect((await manager.withoutCsrf('POST', '/admin/system/integrity/run')).body.code).toBe('CSRF_FAILED');
    expect((await manager.anonymous('POST', '/admin/system/integrity/run')).status).toBe(401);
    expect(await runs()).toHaveLength(0);
  });
});

describe('the run on a clean ledger', () => {
  it('passes the four checks: counters at the top of the result, the checks under one key, lastSuccessAt set', async () => {
    const before = await ledgerTotals((await testDb()).db);
    const started = await manager.post('/admin/system/integrity/run');
    clock.advance(3_000);
    await runJob({ runId: started.body.id });
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'manual', durationMs: 3000, finishedAt: clock.now() });
    expect(run!.result).toMatchObject({
      failedChecks: 0,
      mismatchCount: 0,
      unbalancedEntries: 0,
      accountDifferences: 0,
      stuckHolds: 0,
      paymentsWithoutEntry: 0,
      entriesChecked: before.entries,
      transactionsChecked: before.transactions,
    });
    expect(run!.processed).toBe((run!.result as { accountsChecked: number }).accountsChecked);
    const body = await report();
    expect(body).toMatchObject({
      running: false,
      runningSince: null,
      result: 'pass',
      lastSuccessAt: clock.now().toISOString(),
    });
    expect(body.lastRun).toMatchObject({
      id: run!.id,
      status: 'succeeded',
      trigger: 'manual',
      triggeredBy: { name: 'Rami K.' },
    });
    expect(
      body.checks.map((check: { key: string; status: string; count: number; difference: string | null }) => [
        check.key,
        check.status,
        check.count,
        check.difference,
      ]),
    ).toEqual([
      ['entries_balanced', 'pass', 0, '0.0000'],
      ['accounts_match_lines', 'pass', 0, '0.0000'],
      ['stuck_holds', 'pass', 0, null],
      ['payments_without_entry', 'pass', 0, '0.0000'],
    ]);
    // Nothing was written to the ledger.
    expect(await ledgerTotals((await testDb()).db)).toEqual(before);
  });

  it('records a scheduled run on a new row, and a retry of a finished manual run changes nothing', async () => {
    await runJob();
    expect(await runs()).toMatchObject([{ trigger: 'schedule', status: 'succeeded' }]);
    const started = await manager.post('/admin/system/integrity/run');
    await runJob({ runId: started.body.id });
    await runJob({ runId: started.body.id });
    expect(await runs()).toHaveLength(2);
  });
});

describe('scenario system-integrity: a merchant wallet that does not match its lines', () => {
  const tamper = async (amount: string) =>
    (await testDb()).db.execute(
      sql`update ledger_accounts set balance = balance + ${amount}::numeric where kind = 'client_wallet' and owner_id = ${world.merchant.id}`,
    );

  it('finds the account with the difference, the owner and the last entry (steps 1 to 3), raises the alert and corrects nothing', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'ledger_mismatch',
      name: 'Ledger mismatch',
      metric: 'ledger.mismatch_count',
      threshold: '0.0000',
      windowSeconds: 60,
      channels: ['telegram', 'email'],
    });
    await tamper('-37.5');
    const lastEntry = (
      await db.execute<{ at: Date }>(
        sql`select max(e.created_at) as at from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.kind = 'client_wallet' and a.owner_id = ${world.merchant.id}`,
      )
    ).rows[0]!.at;
    const before = await ledgerTotals(db);
    clock.advance(HOUR);
    await runJob();

    const body = await report();
    expect(body.result).toBe('fail');
    const accounts = checkOf(body, 'accounts_match_lines');
    expect(accounts).toMatchObject({ status: 'fail', count: 1, difference: '37.5000' });
    expect(accounts.findings).toEqual([
      {
        kind: 'account',
        id: expect.any(Number),
        ref: `client_wallet:${world.merchant.id}`,
        label: 'Wallet · Cairo GSM Lab',
        // The same sign as POST /admin/ledger/reconcile: debit positive, stored minus expected. The wallet owes the merchant 37.5 less.
        difference: '37.5000',
        ageSeconds: null,
        lastEntryAt: expect.any(String),
      },
    ]);
    expect(new Date(accounts.findings[0].lastEntryAt).getTime()).toBe(new Date(lastEntry).getTime());
    expect(
      ['entries_balanced', 'stuck_holds', 'payments_without_entry'].map((key) => checkOf(body, key).status),
    ).toEqual(['pass', 'pass', 'pass']);
    expect(body.lastSuccessAt).toBeNull();

    const [run] = await runs();
    expect(run!.result).toMatchObject({ failedChecks: 1, mismatchCount: 1, accountDifferences: 1 });
    // The ledger_mismatch rule fired for the system at once, with one notice owed to its channels.
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
    expect(pick(noticeOfCall(fired), ['channels', 'metric'])).toEqual({
      channels: ['telegram', 'email'],
      metric: 'ledger.mismatch_count',
    });
    // Read-only: the ledger gained nothing and the wallet still shows the wrong balance.
    expect(await ledgerTotals(db)).toEqual(before);
  });

  it('closes the alert when a rerun finds no difference, and moves lastSuccessAt (step 7)', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'ledger_mismatch',
      metric: 'ledger.mismatch_count',
      threshold: '0.0000',
      windowSeconds: 60,
    });
    await tamper('-37.5');
    await runJob();
    expect((await db.select().from(s.alertEvents))[0]!.status).toBe('firing');
    // Finance puts the wallet right with a reversing entry (here: the balance is made to match its lines again).
    await tamper('37.5');
    clock.advance(5 * MINUTE);
    const started = await manager.post('/admin/system/integrity/run');
    await runJob({ runId: started.body.id });
    const body = await report();
    expect(body).toMatchObject({ result: 'pass', lastSuccessAt: clock.now().toISOString() });
    expect(body.lastRun.id).toBe(started.body.id);
    expect((await db.select().from(s.alertEvents))[0]).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('lists the first 20 findings but counts them all, with the sum of every difference', async () => {
    const { db } = await testDb();
    const merchants: number[] = [];
    for (let i = 0; i < 22; i += 1) merchants.push((await insertWalletMerchant(db, { name: `Bulk merchant ${i}` })).id);
    const ids = sql.join(
      merchants.map((id) => sql`${id}`),
      sql`, `,
    );
    await db.execute(
      sql`update ledger_accounts set balance = balance + 1 where kind = 'client_wallet' and owner_id in (${ids})`,
    );
    await runJob();
    const accounts = checkOf(await report(), 'accounts_match_lines');
    expect(accounts.count).toBe(22);
    expect(accounts.findings).toHaveLength(20);
    // A wallet that shows 1.00 more than its lines is -1.00 in debit-positive terms; 22 of them sum to -22.
    expect(accounts.difference).toBe(Money.of(-22).toWire());
  });
});

describe('the other three checks', () => {
  /** Inserts an unbalanced entry the way a bypassed trigger would leave it: one line, no counterpart. */
  async function insertUnbalancedEntry() {
    const { pool, db } = await testDb();
    const [bank] = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.kind, 'bank')).limit(1);
    const accountId =
      bank?.id ??
      (
        await db
          .insert(s.ledgerAccounts)
          .values({ kind: 'bank', currency: 'USD' })
          .returning({ id: s.ledgerAccounts.id })
      )[0]!.id;
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Replica mode switches the deferred zero-sum trigger off for this transaction only.
      await client.query('set local session_replication_role = replica');
      const header = await client.query(
        `insert into ledger_transactions (kind, ref_type, ref_id, memo, idempotency_key, created_by_type) values ('adjustment', 'system', 0, 'bypassed', 'test:unbalanced', 'system') returning id`,
      );
      await client.query(
        'insert into ledger_entries (transaction_id, account_id, amount, balance_after) values ($1, $2, 7, 7)',
        [header.rows[0].id, accountId],
      );
      // Keep the account balance in step so only the per-entry rule is broken.
      await client.query('update ledger_accounts set balance = balance + 7 where id = $1', [accountId]);
      await client.query('commit');
      return Number(header.rows[0].id);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it('entries_balanced: finds a transaction whose lines do not sum to zero, with its label and the sum of its lines', async () => {
    const id = await insertUnbalancedEntry();
    await runJob();
    const body = await report();
    const entries = checkOf(body, 'entries_balanced');
    expect(entries).toMatchObject({ status: 'fail', count: 1, difference: '7.0000' });
    expect(entries.findings).toEqual([
      {
        kind: 'entry',
        id,
        ref: `#${id}`,
        label: 'adjustment · system',
        difference: '7.0000',
        ageSeconds: null,
        lastEntryAt: null,
      },
    ]);
    expect(checkOf(body, 'accounts_match_lines').status).toBe('pass');
    expect((await runs())[0]!.result).toMatchObject({ unbalancedEntries: 1, mismatchCount: 1, failedChecks: 1 });
  });

  /** Holds the price of an order on the merchant's wallet at a moment, as the order engine does at placement. */
  async function heldOrder(at: Date, status: 'pending' | 'processing' | 'completed' = 'pending') {
    const { db } = await testDb();
    const row = await insertOrderRow(db, {
      serviceId: world.auto.serviceId,
      clientId: world.merchant.id,
      status,
      dispatchState: 'pending',
      totalPrice: '5.0000',
      placedAt: at,
      createdAt: at,
    });
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...order({ clientId: world.merchant.id, amount: Money.of('5') }),
          refId: row.id,
          idempotencyKey: `hold:order:${row.id}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        at,
      ),
    );
    return row.id;
  }

  it('stuck_holds: lists an open merchant order whose hold is over 24 hours old, with its age, and leaves out young holds and finished orders', async () => {
    const stuck = await heldOrder(new Date(clock.nowMs() - 30 * HOUR), 'processing');
    await heldOrder(new Date(clock.nowMs() - 23 * HOUR));
    await heldOrder(new Date(clock.nowMs() - 40 * HOUR), 'completed');
    await runJob();
    const holds = checkOf(await report(), 'stuck_holds');
    expect(holds).toMatchObject({ status: 'fail', count: 1, difference: null });
    expect(holds.findings).toEqual([
      {
        kind: 'hold',
        id: stuck,
        ref: `#${stuck}`,
        label: `Order #${stuck} · Cairo GSM Lab`,
        difference: null,
        ageSeconds: 30 * 3600,
        lastEntryAt: null,
      },
    ]);
    // A stuck hold is a delay, not a disagreement: it does not count as a mismatch.
    expect((await runs())[0]!.result).toMatchObject({ stuckHolds: 1, mismatchCount: 0, failedChecks: 1 });
  });

  it('stuck_holds: an order whose hold was released or settled after it is not stuck, even while it is still open', async () => {
    const { db } = await testDb();
    const id = await heldOrder(new Date(clock.nowMs() - 30 * HOUR));
    await db.execute(
      sql`insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type) values ('order_release', 'order', ${id}, ${`release:order:${id}`}, 'system')`,
    );
    // The release carries no lines here (the test only needs its header); give it the two lines a release has so the books stay balanced.
    const [header] = await db
      .select({ id: s.ledgerTransactions.id })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `release:order:${id}`));
    const [wallet] = await db
      .select()
      .from(s.ledgerAccounts)
      .where(sql`kind = 'client_wallet' and owner_id = ${world.merchant.id}`);
    const [hold] = await db
      .select()
      .from(s.ledgerAccounts)
      .where(sql`kind = 'client_hold' and owner_id = ${world.merchant.id}`);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into ledger_entries (transaction_id, account_id, amount, balance_after) values (${header!.id}, ${hold!.id}, 5, 0), (${header!.id}, ${wallet!.id}, -5, 100)`,
      );
    });
    await runJob();
    expect(checkOf(await report(), 'stuck_holds')).toMatchObject({ status: 'pass', count: 0 });
  });

  it('payments_without_entry: finds a confirmed top-up with no deposit entry, labelled by gateway, and ignores one that has its entry', async () => {
    const { db } = await testDb();
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'card', driver: 'card', name: 'Card gateway' })
      .returning();
    const payment = (overrides: Partial<typeof s.payments.$inferInsert>) =>
      db
        .insert(s.payments)
        .values({
          purpose: 'topup',
          gatewayId: gateway!.id,
          amount: '100.0000',
          currency: 'USD',
          status: 'approved',
          methodType: 'card',
          ...overrides,
        })
        .returning({ id: s.payments.id });
    // The funding of the test merchants posts deposits that point at payment 1: start after it so the payments below are alone with their ids.
    await payment({ gatewayTxnId: 'pi_first', status: 'pending' });
    const [lone] = await payment({ gatewayTxnId: 'pi_lost_1', amount: '250.5000' });
    const [posted] = await payment({ gatewayTxnId: 'pi_ok_1' });
    await payment({ gatewayTxnId: 'pi_pending', status: 'pending' });
    await db.execute(
      sql`insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type) values ('deposit', 'payment', ${posted!.id}, ${`deposit:payment:${posted!.id}`}, 'system')`,
    );
    await runJob();
    const payments = checkOf(await report(), 'payments_without_entry');
    // The posted payment has its deposit header, so only the lone one is listed (the pending one is not confirmed).
    expect(payments).toMatchObject({ status: 'fail', count: 1, difference: '250.5000' });
    expect(payments.findings).toEqual([
      {
        kind: 'payment',
        id: lone!.id,
        ref: 'pi_lost_1',
        label: 'Payment · Card gateway',
        difference: '250.5000',
        ageSeconds: null,
        lastEntryAt: null,
      },
    ]);
    expect((await runs())[0]!.result).toMatchObject({ paymentsWithoutEntry: 1, mismatchCount: 1 });
  });
});

describe('a failed or skipped run', () => {
  it('shows every check unknown after a failed run, and never a stale pass', async () => {
    await runJob();
    expect((await report()).result).toBe('pass');
    clock.advance(HOUR);
    const { db } = await testDb();
    await db.insert(s.jobRuns).values({
      job: 'ledger_integrity',
      trigger: 'schedule',
      status: 'failed',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      error: 'The database restarted.',
    });
    const body = await report();
    expect(body.lastRun).toMatchObject({ status: 'failed', error: 'The database restarted.' });
    expect(body.result).toBe('unknown');
    expect(body.checks.every((check: { status: string }) => check.status === 'unknown')).toBe(true);
    // The last clean run is still remembered.
    expect(body.lastSuccessAt).not.toBeNull();
  });

  it('is not hidden by a skipped run: the last run stays the one that checked something', async () => {
    await runJob();
    const first = (await runs())[0]!;
    clock.advance(DAY);
    const { db } = await testDb();
    await db.insert(s.jobRuns).values({
      job: 'ledger_integrity',
      trigger: 'schedule',
      status: 'skipped',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      result: { reason: 'another run of this job was still going on' },
    });
    const body = await report();
    expect(body.lastRun.id).toBe(first.id);
    expect(body.result).toBe('pass');
  });

  it('reports running while a run goes, with the previous result still shown', async () => {
    await runJob();
    clock.advance(2 * HOUR);
    const { db } = await testDb();
    await db
      .insert(s.jobRuns)
      .values({ job: 'ledger_integrity', trigger: 'schedule', status: 'running', startedAt: clock.now() });
    const body = await report();
    expect(body).toMatchObject({ running: true, runningSince: clock.now().toISOString(), result: 'pass' });
    expect(body.lastRun.status).toBe('succeeded');
  });
});
