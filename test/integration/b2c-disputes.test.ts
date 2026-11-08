// Integration tests of the card disputes (feature 16, scenario b2c-chargeback, RESOLUTIONS money-5, ANSWERS refunds Q5 to Q8, M115): the signed
// dispute webhook (created, lost, won, repeats, refusals), the list and the single read with the evidence pack, evidence before the deadline,
// accepting the loss, and the one chargeback journal whichever of the accept and the webhook comes first.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { signWebhook } from '../../src/infra/crypto';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { WEBHOOK_KEY, GatewayTestModule } from '../support/billing';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../support/b2c';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { auditOf, eventsOf, ledgerOf, orderRow, systemBalance } from '../support/orders';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  staff = await adminWith(t, ['disputes:*', 'orders:*', 'refunds:*'], { name: 'Layla Haddad' });
});

/** A storefront order that was paid (GBP 3.84, USD 4.79) and, when asked, delivered by a staff reply. */
async function order(options: { deliver?: boolean; email?: string } = {}): Promise<PaidOrder> {
  const paid = await paidOrder(t, clock, world, options.email === undefined ? {} : { email: options.email });
  if (options.deliver) {
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
  }
  return paid;
}

const unique = (): string => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const dueIn = (days: number): number => Math.floor(clock.nowMs() / 1000) + days * 86_400;

/** The gateway reports a dispute of the whole payment (GBP 3.84) with a GBP 12.00 fee, due in a week by default. */
async function open(
  paid: PaidOrder,
  options: { dispute?: string; days?: number; amount?: number; fee?: number; reason?: string } = {},
) {
  const dispute = options.dispute ?? `dp_${unique()}`;
  const res = await hook(
    t,
    clock,
    'disputes',
    world.gateway.code,
    disputeEvent(`evt_open_${unique()}`, {
      dispute,
      intent: paid.intent,
      dueBy: dueIn(options.days ?? 7),
      ...(options.amount === undefined ? {} : { amount: options.amount }),
      ...(options.fee === undefined ? {} : { fee: options.fee }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    }),
  );
  expect(res.statusCode).toBe(200);
  return { gatewayId: dispute, row: await rowOf(dispute) };
}

/** The gateway's decision on a dispute. */
function decide(paid: PaidOrder, dispute: string, status: 'won' | 'lost') {
  return hook(
    t,
    clock,
    'disputes',
    world.gateway.code,
    disputeEvent(`evt_close_${unique()}`, { dispute, intent: paid.intent, type: 'charge.dispute.closed', status }),
  );
}

const rowOf = async (gatewayId: string) =>
  (await db.select().from(s.disputes).where(eq(s.disputes.gatewayDisputeId, gatewayId)))[0]!;
const disputeRow = async (id: number) => (await db.select().from(s.disputes).where(eq(s.disputes.id, id)))[0]!;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const chargebacks = () => db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'chargeback'));

describe('POST /webhooks/disputes/:gateway: dispute.created', () => {
  it('opens the dispute once with the gateway deadline, marks the payment disputed and the order timeline', async () => {
    const paid = await order({ deliver: true });
    const { row } = await open(paid, { reason: 'fraudulent' });
    expect(row).toMatchObject({
      status: 'needs_response',
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      reasonCode: 'fraudulent',
      amount: '3.8400',
      currency: 'GBP',
      fee: '12.0000',
    });
    expect(row.evidenceDueAt.toISOString()).toBe('2026-11-14T12:00:00.000Z');
    expect(row.customerId).toBe((await orderRow(db, paid.orderId)).customerId);
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'dispute',
      actorType: 'system',
      data: expect.objectContaining({
        message:
          'Dispute opened for $4.79: The cardholder says they did not make this payment. Evidence due 2026-11-14.',
      }),
    });
    // No money moves until the dispute is lost.
    expect(await chargebacks()).toHaveLength(0);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('gives a dispute without a deadline seven days, and records one per payment and gateway id however often it arrives', async () => {
    const paid = await order();
    const body = JSON.parse(disputeEvent('evt_x', { dispute: 'dp_nodue', intent: paid.intent })) as Record<
      string,
      unknown
    >;
    const res = await hook(
      t,
      clock,
      'disputes',
      world.gateway.code,
      JSON.stringify({ ...body, id: `evt_a_${unique()}` }),
    );
    expect(res.json()).toEqual({ received: true });
    expect((await rowOf('dp_nodue')).evidenceDueAt.toISOString()).toBe('2026-11-14T12:00:00.000Z');
    // The same dispute under a new event id, and a signed delivery sent twice at once: still one row.
    const again = await hook(
      t,
      clock,
      'disputes',
      world.gateway.code,
      JSON.stringify({ ...body, id: `evt_b_${unique()}` }),
    );
    expect(again.json()).toEqual({ received: true, duplicate: true });
    const racing = await Promise.all(
      [1, 2, 3].map(() =>
        hook(t, clock, 'disputes', world.gateway.code, JSON.stringify({ ...body, id: `evt_c_${unique()}` })),
      ),
    );
    expect(racing.every((res) => res.statusCode === 200)).toBe(true);
    expect(await db.select().from(s.disputes)).toHaveLength(1);
    expect((await eventsOf(db, paid.orderId)).filter((event) => event.type === 'dispute')).toHaveLength(1);
  });

  it('the same signed event delivered twice is handled once', async () => {
    const paid = await order();
    const body = disputeEvent(`evt_same_${unique()}`, { dispute: 'dp_same', intent: paid.intent, dueBy: dueIn(7) });
    expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
    const second = await hook(t, clock, 'disputes', world.gateway.code, body);
    expect(second.statusCode).toBe(200);
    expect(await db.select().from(s.disputes)).toHaveLength(1);
  });

  it('refuses a missing, wrong, stale or tampered signature and an unknown gateway', async () => {
    const paid = await order();
    const body = disputeEvent(`evt_sig_${unique()}`, { dispute: 'dp_sig', intent: paid.intent });
    const send = (gateway: string, headers: Record<string, string>, payload = body) =>
      t.app.inject({
        method: 'POST',
        url: `/webhooks/disputes/${gateway}`,
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });
    const stamp = (offset = 0, key = WEBHOOK_KEY, text = body) =>
      signWebhook(key, Math.floor(clock.nowMs() / 1000) + offset, text);
    const refused = [
      await send(world.gateway.code, {}),
      await send(world.gateway.code, { 'stripe-signature': 'garbage' }),
      await send(world.gateway.code, { 'stripe-signature': stamp(0, 'whsec_other_key_0123456789abcdef') }),
      await send(world.gateway.code, { 'stripe-signature': stamp(-301) }),
      await send(world.gateway.code, { 'stripe-signature': stamp(301) }),
      await send(world.gateway.code, { 'stripe-signature': stamp(0, WEBHOOK_KEY, body.replace('384', '9999')) }),
      await send('no-such-gateway', { 'stripe-signature': stamp() }),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    expect(await db.select().from(s.disputes)).toHaveLength(0);
    // A delivery 290 seconds old is inside the window.
    expect((await send(world.gateway.code, { 'stripe-signature': stamp(-290) })).statusCode).toBe(200);
  });

  it('acknowledges and ignores what it cannot use: an unknown payment, other event types, a dispute closed before it was recorded', async () => {
    const paid = await order();
    const ignored = [
      disputeEvent(`evt_i1_${unique()}`, { dispute: 'dp_none', intent: 'pi_unknown' }),
      disputeEvent(`evt_i2_${unique()}`, { dispute: 'dp_upd', intent: paid.intent, type: 'charge.dispute.updated' }),
      disputeEvent(`evt_i3_${unique()}`, {
        dispute: 'dp_pending',
        intent: paid.intent,
        type: 'charge.dispute.closed',
        status: 'warning_closed',
      }),
      disputeEvent(`evt_i4_${unique()}`, {
        dispute: 'dp_early',
        intent: paid.intent,
        type: 'charge.dispute.closed',
        status: 'lost',
      }),
      JSON.stringify({ id: `evt_i5_${unique()}`, type: 'charge.dispute.created', data: {} }),
    ];
    for (const body of ignored) {
      const res = await hook(t, clock, 'disputes', world.gateway.code, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
    }
    expect(await db.select().from(s.disputes)).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    expect(await chargebacks()).toHaveLength(0);
  });

  it('marks a payment that was partly refunded as disputed, and a dispute for a payment that was never captured is ignored', async () => {
    const paid = await order({ deliver: true });
    await db.update(s.payments).set({ status: 'partial_refund' }).where(eq(s.payments.id, paid.paymentId));
    await open(paid);
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    const failed = await order({ email: 'ann@mail.example' });
    await db.update(s.payments).set({ status: 'failed' }).where(eq(s.payments.id, failed.paymentId));
    await open(failed);
    expect((await paymentRow(failed.paymentId)).status).toBe('failed');
  });
});

describe('GET /admin/disputes and /admin/disputes/:id', () => {
  it('lists disputes without the pack and reads one with the six lines and the strength', async () => {
    const paid = await order({ deliver: true });
    const { row } = await open(paid);
    const list = await staff.get('/admin/disputes');
    expect(list.status).toBe(200);
    expect(list.total).toBe(1);
    const fx = list.body[0].fx as string;
    const feeUsd = new Decimal('12').div(fx).toDecimalPlaces(4).toFixed(4);
    expect(list.body[0]).toEqual({
      id: row.id,
      orderId: paid.orderId,
      amount: '4.7900',
      fee: feeUsd,
      reasonCode: 'fraudulent',
      note: 'The cardholder says they did not make this payment.',
      status: 'needs_response',
      currency: 'GBP',
      fx,
      customer: { id: expect.any(Number), name: 'sam@mail.example' },
      evidenceDueAt: '2026-11-14T12:00:00.000Z',
      submittedAt: null,
      resolvedAt: null,
      createdAt: '2026-11-07T12:00:00.000Z',
    });
    const one = await staff.get(`/admin/disputes/${row.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: row.id, status: 'needs_response' });
    expect(one.body.evidence.map((line: { key: string }) => line.key)).toEqual([
      'payment',
      'three_ds',
      'delivery',
      'consents',
      'history',
      'contact',
    ]);
    const lines = Object.fromEntries(
      one.body.evidence.map((line: { key: string; ok: boolean; body: string }) => [line.key, line]),
    );
    expect(lines.payment.body).toBe(`Visa •••• 4242, $4.79 captured 2026-11-07. Gateway ref ${paid.intent}.`);
    expect(lines.three_ds.ok).toBe(true);
    expect(lines.delivery).toMatchObject({ ok: true });
    expect(lines.delivery.body).toContain('Result delivered 2026-11-07 to sam@mail.example');
    expect(lines.consents.ok).toBe(true);
    expect(lines.consents.body).toContain('Terms of service');
    expect(lines.history).toMatchObject({ ok: false, body: 'First order from this customer.' });
    expect(lines.contact).toMatchObject({ ok: true });
    // 1 (payment) + 3 (3DS) + 3 (delivery) + 2 (consents) + 0 (history) + 1 (contact) = 10: strong.
    expect(one.body.strength).toBe('strong');
    expect((await staff.get('/admin/disputes/999999')).status).toBe(404);
  });

  it('weighs the pack: no delivery and no 3-D Secure is weak, a repeat customer and a support ticket change the lines', async () => {
    const paid = await order({ email: 'rep@mail.example' });
    await db.update(s.payments).set({ threeDs: false }).where(eq(s.payments.id, paid.paymentId));
    const { row } = await open(paid);
    const weak = (await staff.get(`/admin/disputes/${row.id}`)).body;
    const byKey = (body: typeof weak) =>
      Object.fromEntries(body.evidence.map((line: { key: string }) => [line.key, line]));
    expect(byKey(weak).three_ds.ok).toBe(false);
    expect(byKey(weak).delivery).toMatchObject({ ok: false, body: 'Not delivered yet.' });
    // payment 1 + consents 2 + contact 1 = 4.
    expect(weak.strength).toBe('weak');

    const customerId = (await orderRow(db, paid.orderId)).customerId!;
    await db.insert(s.supportTickets).values({
      number: 'TCK-9001',
      subject: 'Where is my unlock?',
      requesterType: 'customer',
      requesterId: customerId,
      orderId: paid.orderId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    const ticket = byKey((await staff.get(`/admin/disputes/${row.id}`)).body).contact;
    expect(ticket).toMatchObject({ ok: false });
    expect(ticket.body).toContain('Where is my unlock?');
  });

  it('filters by status, sorts the open ones first by deadline, searches and pages with the exact total', async () => {
    const first = await open(await order({ email: 'a@mail.example' }), { days: 10, reason: 'fraudulent' });
    const second = await open(await order({ email: 'b@mail.example' }), { days: 3, reason: 'product_not_received' });
    const done = await open(await order({ email: 'c@mail.example' }), { days: 1, reason: 'duplicate' });
    await db.update(s.disputes).set({ status: 'won' }).where(eq(s.disputes.id, done.row.id));
    const ids = (path: string) => staff.get(path).then((res) => res.body.map((row: { id: number }) => row.id));
    // Default: the ones that wait for an answer come first, soonest deadline first, then the rest.
    expect(await ids('/admin/disputes')).toEqual([second.row.id, first.row.id, done.row.id]);
    expect(await ids('/admin/disputes?_sort=evidenceDueAt&_order=desc')).toEqual([
      first.row.id,
      second.row.id,
      done.row.id,
    ]);
    expect(await ids('/admin/disputes?status=won')).toEqual([done.row.id]);
    expect(await ids('/admin/disputes?_sort=id&_order=desc')).toEqual([done.row.id, second.row.id, first.row.id]);
    expect(await ids('/admin/disputes?q=product_not')).toEqual([second.row.id]);
    expect(await ids('/admin/disputes?q=b@mail')).toEqual([second.row.id]);
    expect(await ids(`/admin/disputes?q=${first.row.id}`)).toContain(first.row.id);
    const page = await staff.get('/admin/disputes?_start=0&_end=2');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(3);
    expect((await staff.get('/admin/disputes?status=bogus')).status).toBe(422);
    expect((await staff.get('/admin/disputes?_sort=reasonCode')).status).toBe(422);
  });

  it('needs disputes:read, and the writes need disputes:manage', async () => {
    const { row } = await open(await order());
    expect((await (await adminWith(t, ['orders:read'])).get('/admin/disputes')).status).toBe(403);
    const reader = await adminWith(t, ['disputes:read']);
    expect((await reader.get('/admin/disputes')).status).toBe(200);
    expect((await reader.get(`/admin/disputes/${row.id}`)).status).toBe(200);
    expect((await reader.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment'] })).status).toBe(403);
    expect((await reader.post(`/admin/disputes/${row.id}/accept`, {})).status).toBe(403);
    expect((await staff.anonymous('GET', '/admin/disputes')).status).toBe(401);
    expect((await staff.withoutCsrf('POST', `/admin/disputes/${row.id}/accept`, {})).status).toBe(403);
  });
});

describe('POST /admin/disputes/:id/evidence', () => {
  it('sends the chosen lines to the gateway, keeps a PDF, becomes under_review, and writes the timeline and the audit row', async () => {
    const paid = await order({ deliver: true });
    const { row, gatewayId } = await open(paid);
    const res = await staff.post(`/admin/disputes/${row.id}/evidence`, {
      items: ['payment', 'three_ds', 'delivery', 'delivery'],
      note: ' The result was delivered to the cardholder. ',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: row.id, status: 'under_review', submittedAt: '2026-11-07T12:00:00.000Z' });

    const call = fake.calls(`/v1/disputes/${gatewayId}`)[0]!;
    const form = new URLSearchParams(call.body);
    expect(form.get('submit')).toBe('true');
    const text = form.get('evidence[uncategorized_text]')!;
    expect(text).toContain('Payment record: Visa •••• 4242');
    expect(text).toContain('3D Secure authentication:');
    expect(text).toContain('Proof of delivery: Result delivered 2026-11-07');
    expect(text).not.toContain('Terms the customer accepted');
    expect(text.endsWith('Note from the merchant: The result was delivered to the cardholder.')).toBe(true);

    const stored = await disputeRow(row.id);
    expect(stored.status).toBe('under_review');
    expect(stored.evidenceFileIds).toHaveLength(1);
    const [file] = await db.select().from(s.files).where(eq(s.files.id, stored.evidenceFileIds[0]!));
    expect(file).toMatchObject({ mime: 'application/pdf', filename: `DP-${row.id}-evidence.pdf` });
    expect(file!.size).toBeGreaterThan(500);

    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'dispute',
      actorType: 'staff',
      actorId: staff.staffId,
      data: expect.objectContaining({ message: `Evidence pack submitted for DP-${row.id}` }),
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'dispute'));
    expect(audit).toMatchObject({
      action: 'submitted evidence for',
      entityId: row.id,
      entityLabel: `DP-${row.id} on SF-${paid.orderId}`,
      before: { status: 'needs_response' },
      after: { status: 'under_review', items: ['payment', 'three_ds', 'delivery'] },
    });
    expect(await auditOf(db, paid.orderId)).toBeDefined();
    // Evidence moves no money.
    expect(await chargebacks()).toHaveLength(0);
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
  });

  it('refuses no items, a line that is not in the pack, a note over 1000 characters and a missing dispute', async () => {
    const { row } = await open(await order());
    const bad = async (body: unknown) => await staff.post(`/admin/disputes/${row.id}/evidence`, body);
    const none = await bad({ items: [] });
    expect(none.status).toBe(422);
    expect(none.body.errors[0]).toMatchObject({ field: 'items', message: 'Choose at least one line of evidence.' });
    const unknown = await bad({ items: ['payment', 'selfie'] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({
      field: 'items',
      message: 'These lines are not in the pack: selfie.',
    });
    const long = await bad({ items: ['payment'], note: 'x'.repeat(1001) });
    expect(long.status).toBe(422);
    expect(long.body.errors[0]).toMatchObject({ field: 'note' });
    expect((await staff.post('/admin/disputes/999999/evidence', { items: ['payment'] })).status).toBe(404);
    expect((await bad({})).status).toBe(422);
    expect((await disputeRow(row.id)).status).toBe('needs_response');
    expect(fake.requests.filter((request) => request.path.startsWith('/v1/disputes'))).toHaveLength(0);
  });

  it('is DISPUTE_NOT_OPEN once it was answered or decided, and EVIDENCE_DEADLINE_PASSED from the deadline on', async () => {
    const { row } = await open(await order(), { days: 2 });
    clock.advance(2 * DAY - 1000);
    // Staff sessions idle out: sign in again after the long wait.
    staff = await adminWith(t, ['disputes:*', 'orders:*'], { name: 'Layla Haddad' });
    expect((await staff.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment'] })).status).toBe(200);
    const again = await staff.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment'] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'DISPUTE_NOT_OPEN' });

    const late = await open(await order({ email: 'late@mail.example' }), { days: 2 });
    clock.advance(2 * DAY + 1000);
    staff = await adminWith(t, ['disputes:*', 'orders:*'], { name: 'Layla Haddad' });
    const missed = await staff.post(`/admin/disputes/${late.row.id}/evidence`, { items: ['payment'] });
    expect(missed.status).toBe(409);
    expect(missed.body).toMatchObject({ code: 'EVIDENCE_DEADLINE_PASSED' });
    expect((await disputeRow(late.row.id)).status).toBe('needs_response');
    // The deadline is judged on the clock only: at the exact deadline it has passed.
    const exact = await open(await order({ email: 'exact@mail.example' }), { days: 1 });
    clock.advance(DAY);
    staff = await adminWith(t, ['disputes:*', 'orders:*'], { name: 'Layla Haddad' });
    expect((await staff.post(`/admin/disputes/${exact.row.id}/evidence`, { items: ['payment'] })).body).toMatchObject({
      code: 'EVIDENCE_DEADLINE_PASSED',
    });
  });

  it('a gateway that refuses the evidence is a 502 and leaves the dispute as it was', async () => {
    const paid = await order({ deliver: true });
    const { row } = await open(paid);
    fake.failWith = 500;
    const res = await staff.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment'] });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(await disputeRow(row.id)).toMatchObject({ status: 'needs_response', submittedAt: null });
    expect((await disputeRow(row.id)).evidenceFileIds ?? []).toHaveLength(0);
    expect(
      await db
        .select()
        .from(s.files)
        .where(eq(s.files.filename, `DP-${row.id}-evidence.pdf`)),
    ).toHaveLength(0);
    fake.failWith = undefined;
    expect((await staff.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment'] })).status).toBe(200);
  });
});

describe('POST /admin/disputes/:id/accept and the lost event', () => {
  it('accepting posts the one chargeback journal (amount plus fee), marks the payment chargeback and does not block the customer', async () => {
    const paid = await order({ deliver: true });
    const { row } = await open(paid);
    const res = await staff.post(`/admin/disputes/${row.id}/accept`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: row.id, status: 'lost', resolvedAt: '2026-11-07T12:00:00.000Z' });

    const stored = await disputeRow(row.id);
    expect(stored).toMatchObject({ status: 'lost', ledgerTxId: expect.any(Number) });
    const [journal] = await chargebacks();
    expect(journal).toMatchObject({
      id: stored.ledgerTxId,
      refType: 'order',
      refId: paid.orderId,
      idempotencyKey: `dispute:${row.id}:chargeback`,
    });
    const fx = res.body.fx as string;
    const feeUsd = new Decimal('12').div(fx).toDecimalPlaces(4);
    // Dr chargeback_loss 4.79 + fee, Cr gateway_clearing the same.
    expect(await systemBalance(db, 'chargeback_loss')).toBe(new Decimal('4.79').add(feeUsd).toFixed(4));
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(res.body.fee).toBe(feeUsd.toFixed(4));
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await orderRow(db, paid.orderId)).status).toBe('completed');
    const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, stored.customerId!));
    expect(customer!.status).toBe('active');
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'dispute',
      actorType: 'staff',
      data: expect.objectContaining({ message: 'Dispute accepted, $4.79 returned to the cardholder' }),
    });
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'dispute'));
    expect(audit).toMatchObject({
      action: 'accepted dispute',
      before: { status: 'needs_response' },
      after: { status: 'lost' },
    });

    // The gateway's later "lost" decision finds it closed and posts nothing again.
    const later = await decide(paid, (await disputeRow(row.id)).gatewayDisputeId, 'lost');
    expect(later.json()).toEqual({ received: true, duplicate: true });
    expect(await chargebacks()).toHaveLength(1);
    expect((await ledgerOf(db, paid.orderId)).filter((entry) => entry.kind === 'chargeback')).toHaveLength(1);
  });

  it('refuses a second accept, an answered or decided dispute and a missing one', async () => {
    const answered = await open(await order({ deliver: true }));
    expect((await staff.post(`/admin/disputes/${answered.row.id}/evidence`, { items: ['payment'] })).status).toBe(200);
    const notOpen = await staff.post(`/admin/disputes/${answered.row.id}/accept`, {});
    expect(notOpen.status).toBe(409);
    expect(notOpen.body).toMatchObject({ code: 'DISPUTE_NOT_OPEN' });

    const { row } = await open(await order({ email: 'two@mail.example' }));
    expect((await staff.post(`/admin/disputes/${row.id}/accept`, {})).status).toBe(200);
    expect((await staff.post(`/admin/disputes/${row.id}/accept`, {})).body).toMatchObject({ code: 'DISPUTE_NOT_OPEN' });
    expect((await staff.post('/admin/disputes/999999/accept', {})).status).toBe(404);
    expect(await chargebacks()).toHaveLength(1);
  });

  it('a lost event after evidence posts the journal once, marks the payment chargeback and writes the timeline', async () => {
    const paid = await order({ deliver: true });
    const { row, gatewayId } = await open(paid);
    await staff.post(`/admin/disputes/${row.id}/evidence`, { items: ['payment', 'delivery'] });
    const res = await decide(paid, gatewayId, 'lost');
    expect(res.json()).toEqual({ received: true });
    expect(await disputeRow(row.id)).toMatchObject({ status: 'lost', ledgerTxId: expect.any(Number) });
    expect((await disputeRow(row.id)).resolvedAt?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(await chargebacks()).toHaveLength(1);
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'dispute',
      actorType: 'system',
      data: expect.objectContaining({
        message: 'Dispute lost: the amount and the dispute fee were taken by the card network',
      }),
    });
    // A repeat of the decision, as a new event or as the same one, changes nothing.
    expect((await decide(paid, gatewayId, 'lost')).json()).toEqual({ received: true, duplicate: true });
    expect(await chargebacks()).toHaveLength(1);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a won event returns the payment to captured, or to partial_refund or refunded when refunds completed; a decided dispute stays decided', async () => {
    const paid = await order({ deliver: true });
    const { row, gatewayId } = await open(paid);
    expect((await paymentRow(paid.paymentId)).status).toBe('disputed');
    expect((await decide(paid, gatewayId, 'won')).json()).toEqual({ received: true });
    expect(await disputeRow(row.id)).toMatchObject({ status: 'won' });
    expect((await disputeRow(row.id)).resolvedAt).not.toBeNull();
    expect((await paymentRow(paid.paymentId)).status).toBe('captured');
    expect(await chargebacks()).toHaveLength(0);
    expect((await eventsOf(db, paid.orderId)).at(-1)).toMatchObject({
      type: 'dispute',
      data: expect.objectContaining({ message: 'Dispute won' }),
    });
    // A won dispute is final: a later "lost" report moves nothing.
    expect((await decide(paid, gatewayId, 'lost')).json()).toEqual({ received: true, duplicate: true });
    expect((await decide(paid, gatewayId, 'won')).json()).toEqual({ received: true, duplicate: true });
    expect(await disputeRow(row.id)).toMatchObject({ status: 'won' });
    expect(await chargebacks()).toHaveLength(0);

    // Refunds that completed before the dispute decide what the payment becomes again.
    const refunded = await order({ deliver: true, email: 'ref@mail.example' });
    await db.insert(s.refunds).values({
      paymentId: refunded.paymentId,
      orderId: refunded.orderId,
      customerId: (await orderRow(db, refunded.orderId)).customerId!,
      amount: '1.0000',
      currency: 'GBP',
      reason: 'Part refund',
      method: 'original',
      status: 'completed',
      requestedByType: 'customer',
      requestedById: (await orderRow(db, refunded.orderId)).customerId!,
      completedAt: clock.now(),
    });
    const other = await open(refunded);
    expect((await paymentRow(refunded.paymentId)).status).toBe('disputed');
    await decide(refunded, other.gatewayId, 'won');
    expect((await paymentRow(refunded.paymentId)).status).toBe('partial_refund');
  });

  it('the accept and the lost event at the same moment post one journal', async () => {
    const paid = await order({ deliver: true });
    const { row, gatewayId } = await open(paid);
    const answers = await Promise.all([
      staff.post(`/admin/disputes/${row.id}/accept`, {}),
      decide(paid, gatewayId, 'lost'),
      decide(paid, gatewayId, 'lost'),
    ]);
    // The accept answers 200 when it comes first and 409 DISPUTE_NOT_OPEN when the gateway's decision got there first; the journal is one either way.
    expect([200, 409]).toContain(answers[0].status);
    expect(answers[1].statusCode).toBe(200);
    expect(answers[2].statusCode).toBe(200);
    expect(await chargebacks()).toHaveLength(1);
    expect(await disputeRow(row.id)).toMatchObject({ status: 'lost' });
    expect((await paymentRow(paid.paymentId)).status).toBe('chargeback');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a dispute for a part of the payment posts that part, not the whole payment', async () => {
    const paid = await order({ deliver: true });
    const { row } = await open(paid, { amount: 192, fee: 0 });
    const res = await staff.post(`/admin/disputes/${row.id}/accept`, {});
    expect(res.status).toBe(200);
    // GBP 1.92 of 3.84: half of the USD gross, converted at the locked rate.
    const fx = res.body.fx as string;
    const half = new Decimal('1.92').div(fx).toDecimalPlaces(4).toFixed(4);
    expect(res.body.amount).toBe(half);
    expect(await systemBalance(db, 'chargeback_loss')).toBe(half);
  });
});
