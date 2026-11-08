// Integration tests of the payment screening (feature 18, RiskScreening, RESOLUTIONS orders-suppliers-11 and money-3): the signals read
// from the database (earlier orders, the blocklist, earlier IMEI checks), the rules that decide, the assessment row, the link to the
// order and the top-up question billing asks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { placementDispatchState } from '../../src/modules/orders';
import { RiskRules, RiskScreening, type ScreeningInput } from '../../src/modules/risk';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow, type OrdersWorld, ordersWorld } from '../support/orders';
import { assessmentOf, insertBlock, insertHeldOrder, insertImeiCheck } from '../support/risk';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let screening: RiskScreening;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
  screening = t.app.get(RiskScreening);
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  owner = await adminWith(t, ['risk:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A payment that trips nothing: a known customer with earlier business, a small amount, matching countries. */
const CALM: ScreeningInput = {
  customerId: null,
  email: 'calm@example.com',
  amountUsd: '15.0000',
  paymentMethod: 'card',
  ip: '203.0.113.7',
  ipCountry: 'GB',
  cardCountry: 'GB',
};
const assess = (input: Partial<ScreeningInput>) =>
  world.db.transaction((tx) => screening.assess(tx, { ...CALM, ...input }));

/** Gives an email `count` paid orders at `at` (one customer, one checkout session per order). */
async function earlierOrders(
  email: string,
  count: number,
  at: Date,
  values: Partial<typeof s.orders.$inferInsert> = {},
) {
  const { db } = world;
  const [customer] = await db.insert(s.customers).values({ email, name: 'Repeat Buyer', country: 'GB' }).returning();
  for (let i = 0; i < count; i += 1) {
    const [session] = await db
      .insert(s.checkoutSessions)
      .values({
        token: crypto.randomUUID(),
        customerId: customer!.id,
        email,
        serviceId: world.auto.serviceId,
        currency: 'USD',
        netAmount: '10.0000',
        grossAmount: '10.0000',
        ip: '198.51.100.1',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      })
      .returning();
    await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: world.auto.serviceId,
      source: 'store',
      status: 'completed',
      dispatchState: 'done',
      checkoutSessionId: session!.id,
      createdAt: at,
      ...values,
    });
  }
  return customer!;
}

describe('RiskScreening.assess', () => {
  it('allows a payment with no signal and still records the assessment', async () => {
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const result = await assess({});
    expect(result).toMatchObject({
      score: 0,
      signals: [],
      decision: 'allow',
      hold: false,
      block: false,
      holdReason: null,
    });
    const [row] = await world.db.select().from(s.riskAssessments);
    expect(row).toMatchObject({
      id: result.assessmentId,
      score: 0,
      decision: 'allow',
      signals: [],
      provider: 'internal',
      orderId: null,
      reviewedAt: null,
    });
    expect(row!.createdAt.toISOString()).toBe('2026-11-08T12:00:00.000Z');
  });

  it('holds a payment whose signals reach the review threshold and says why', async () => {
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const result = await assess({ email: 'x@mailinator.com', prepaidCard: true, ipCountry: 'US' });
    expect(result.signals).toEqual([
      'Disposable email domain',
      'IP country differs from card country',
      'Prepaid card BIN',
    ]);
    expect(result).toMatchObject({ score: 59, decision: 'review', hold: true, block: false });
    expect(result.holdReason).toBe('Risk hold: score 59. Disposable email domain and 2 more signals');
    const [row] = await world.db.select().from(s.riskAssessments).where(eq(s.riskAssessments.id, result.assessmentId));
    expect(row).toMatchObject({ decision: 'review', score: 59 });
    expect(row!.signals).toEqual(result.signals as unknown[]);
  });

  it('flags the first order of a new customer above the rule’s amount, but not a repeat customer or a rejected-only history', async () => {
    const amount = '40.5000';
    const first = await assess({ email: 'new@example.com', amountUsd: amount });
    expect(first.signals).toEqual(['New customer, first order above $40']);
    expect(first.score).toBe(18);
    const customer = await earlierOrders('repeat@example.com', 1, new Date(clock.nowMs() - 3 * DAY));
    expect((await assess({ email: 'repeat@example.com', customerId: customer.id, amountUsd: amount })).signals).toEqual(
      [],
    );
    await earlierOrders('refused@example.com', 1, new Date(clock.nowMs() - 3 * DAY), { status: 'rejected' });
    expect((await assess({ email: 'refused@example.com', amountUsd: amount })).signals).toEqual([
      'New customer, first order above $40',
    ]);
    // The amount limit is the rule's number.
    await owner.put('/admin/risk/rules', {
      rules: [{ id: 'reviewFirstOrderAbove', on: true, value: 100 }],
    });
    expect((await assess({ email: 'new@example.com', amountUsd: amount })).signals).toEqual([]);
  });

  it('holds an email that already made the daily maximum of orders, counting only the last 24 hours', async () => {
    await earlierOrders('busy@example.com', 3, new Date(clock.nowMs() - 2 * HOUR));
    const over = await assess({ email: 'Busy@Example.com' });
    expect(over.signals).toContain('More than 3 orders in 24 hours from this email');
    expect(over.decision).toBe('review');
    await earlierOrders('slow@example.com', 3, new Date(clock.nowMs() - 30 * HOUR));
    expect((await assess({ email: 'slow@example.com' })).signals).toEqual([]);
  });

  it('adds the burst signal for the fourth order within an hour from one address', async () => {
    await earlierOrders('a@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    await earlierOrders('b@example.com', 1, new Date(clock.nowMs() - 10 * 60_000));
    const result = await assess({ email: 'someone-else@example.com', ip: '198.51.100.1' });
    expect(result.signals).toEqual(['4 orders in one hour from one device']);
    expect(result.score).toBe(20);
    expect((await assess({ email: 'someone-else@example.com', ip: '198.51.100.99' })).signals).toEqual([]);
  });

  it('does not count the order being screened as an earlier order', async () => {
    const held = await insertHeldOrder(world, { customer: { email: 'self@example.com' } });
    const withOrder = await assess({
      email: 'self@example.com',
      customerId: held.customerId,
      orderId: held.orderId,
      amountUsd: '90.0000',
    });
    expect(withOrder.signals).toEqual(['New customer, first order above $40']);
    const without = await assess({ email: 'self@example.com', customerId: held.customerId, amountUsd: '90.0000' });
    expect(without.signals).toEqual([]);
  });

  it('blocks a payment whose email, domain, IMEI, card or country is on the blocklist, whatever the case or spacing', async () => {
    const { db } = world;
    await insertBlock(t, db, 'email', 'bad@example.com');
    await insertBlock(t, db, 'domain', 'evil.example');
    await insertBlock(t, db, 'imei', '353890113898412');
    await insertBlock(t, db, 'card', 'fp_bad');
    await insertBlock(t, db, 'country', 'KP');
    const cases: Array<[Partial<ScreeningInput>, string]> = [
      [{ email: ' BAD@Example.com ' }, 'Email is on the blocklist'],
      [{ email: 'anyone@Evil.Example' }, 'Email domain is on the blocklist'],
      [{ imei: '35 389011 3898412' }, 'IMEI is on the blocklist'],
      [{ cardFingerprint: 'fp_bad' }, 'Card is on the blocklist'],
      [{ country: 'kp' }, 'Country is on the blocklist'],
      [{ ipCountry: 'KP', cardCountry: 'KP' }, 'Country is on the blocklist'],
    ];
    for (const [input, sentence] of cases) {
      const result = await assess(input);
      expect(result, sentence).toMatchObject({ score: 100, decision: 'block', block: true, hold: false });
      expect(result.signals[0]).toBe(sentence);
    }
    const clean = await assess({ imei: '352905112490861', cardFingerprint: 'fp_ok' });
    expect(clean.block).toBe(false);
  });

  it('words a chargeback entry as a previous chargeback and ignores an entry that has expired on the clock', async () => {
    const { db } = world;
    await insertBlock(t, db, 'email', 'cb@example.com', { source: 'chargeback' });
    await insertBlock(t, db, 'email', 'temp@example.com', {
      source: 'auto',
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect((await assess({ email: 'cb@example.com' })).signals).toEqual(['Email on a previous chargeback']);
    expect((await assess({ email: 'temp@example.com' })).block).toBe(true);
    clock.advance(2 * HOUR);
    expect((await assess({ email: 'temp@example.com' })).block).toBe(false);
  });

  it('blocks an IMEI an earlier check found blacklisted while its rule is on, and only scores it when the rule is off', async () => {
    const { db } = world;
    await insertImeiCheck(t, db, '353890113898412', { checkType: 'blacklist', status: 'blacklisted' });
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const blocked = await assess({ imei: '353890113898412' });
    expect(blocked).toMatchObject({ decision: 'block', score: 100, signals: ['IMEI was checked blacklisted before'] });
    await owner.put('/admin/risk/rules', { rules: [{ id: 'blockBlacklistedImei', on: false, value: null }] });
    const scored = await assess({ imei: '353890113898412' });
    expect(scored).toMatchObject({ decision: 'allow', score: 30 });
    // A check of another IMEI, or a clean one, says nothing.
    await insertImeiCheck(t, db, '352905112490861', { status: 'clean' });
    expect((await assess({ imei: '352905112490861' })).signals).toEqual([]);
  });

  it('follows the rules saved through the rules route on the very next payment', async () => {
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    expect((await assess({ email: 'x@mailinator.com' })).decision).toBe('allow');
    await owner.put('/admin/risk/rules', {
      rules: [
        { id: 'reviewThreshold', on: true, value: 20 },
        { id: 'blockThreshold', on: true, value: 25 },
      ],
    });
    expect((await assess({ email: 'x@mailinator.com' })).decision).toBe('review');
    await owner.put('/admin/risk/rules', { rules: [{ id: 'blockDisposableEmail', on: true, value: null }] });
    expect((await assess({ email: 'x@mailinator.com' })).decision).toBe('block');
  });

  it('writes nothing when the payment’s transaction rolls back', async () => {
    const { db } = world;
    let failure: unknown;
    try {
      await db.transaction(async (tx) => {
        await screening.assess(tx, CALM);
        throw new Error('the payment failed');
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: 'the payment failed' });
    expect(await db.select().from(s.riskAssessments)).toEqual([]);
  });
});

describe('RiskScreening and the placement rule', () => {
  it('a payment that is held is placed held, waits in the queue, and is released by a reviewer', async () => {
    const { db } = world;
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const customer = await earlierOrders('buyer@mailinator.com', 0, new Date());
    const verdict = await assess({
      email: 'buyer@mailinator.com',
      customerId: customer.id,
      prepaidCard: true,
      ipCountry: 'US',
    });
    expect(verdict.hold).toBe(true);
    // The placement rule of decision 025: a flagged order starts held, pending, with no dispatch request.
    const start = placementDispatchState({
      held: verdict.hold,
      deliveredFromInventory: false,
      manualService: false,
      hasActiveSupplierLink: true,
    });
    expect(start).toEqual({ status: 'pending', dispatchState: 'held', enqueueDispatch: false });
    const order = await insertOrderRow(db, {
      customerId: customer.id,
      serviceId: world.auto.serviceId,
      source: 'store',
      ...start,
    });
    expect(await screening.linkOrder(db, verdict.assessmentId, order.id)).toBe(true);
    expect(await screening.linkOrder(db, verdict.assessmentId, order.id)).toBe(false);
    const reviewer = await adminWith(t, ['risk:read', 'risk:decide']);
    const queue = await reviewer.get('/admin/risk/queue');
    expect(queue.body.held.map((row: { orderId: number }) => row.orderId)).toEqual([order.id]);
    expect(queue.body.held[0].signals).toEqual(verdict.signals);
    expect(queue.body.held[0].score).toBe(verdict.score);
    expect((await reviewer.post(`/admin/risk/orders/${order.id}/approve`)).status).toBe(204);
    expect((await assessmentOf(db, order.id)).outcome).toBe('approved');
  });

  it('a payment that is allowed is not in the queue', async () => {
    const { db } = world;
    await earlierOrders('calm@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const customer = await earlierOrders('fine@example.com', 1, new Date(clock.nowMs() - 5 * DAY));
    const verdict = await assess({ email: 'fine@example.com', customerId: customer.id });
    expect(verdict.decision).toBe('allow');
    const order = await insertOrderRow(db, {
      customerId: customer.id,
      serviceId: world.auto.serviceId,
      source: 'store',
    });
    await screening.linkOrder(db, verdict.assessmentId, order.id);
    const reviewer = await adminWith(t, ['risk:read']);
    expect((await reviewer.get('/admin/risk/queue')).body.held).toEqual([]);
  });
});

describe('RiskScreening.reviewTopUp', () => {
  it('flags a top-up whose card or email is on the blocklist, with the reason for the payment note', async () => {
    const { db } = world;
    await insertBlock(t, db, 'card', 'fp_bad');
    await insertBlock(t, db, 'email', 'merchant@example.com', { source: 'chargeback' });
    expect(await screening.reviewTopUp(db, { cardFingerprint: 'fp_bad' })).toEqual({
      flagged: true,
      reason: 'Risk review: Card is on the blocklist',
    });
    expect(await screening.reviewTopUp(db, { email: 'Merchant@Example.com', cardFingerprint: 'fp_ok' })).toEqual({
      flagged: true,
      reason: 'Risk review: Email on a previous chargeback',
    });
    expect(await screening.reviewTopUp(db, { email: 'fine@example.com', cardFingerprint: 'fp_ok' })).toEqual({
      flagged: false,
      reason: null,
    });
    expect(await screening.reviewTopUp(db, {})).toEqual({ flagged: false, reason: null });
  });
});

describe('RiskRules.load', () => {
  it('reads the stored rules inside the caller’s transaction', async () => {
    const rules = t.app.get(RiskRules);
    expect((await rules.load()).reviewThreshold.value).toBe(50);
    await owner.put('/admin/risk/rules', { rules: [{ id: 'reviewThreshold', on: true, value: 33 }] });
    expect((await world.db.transaction((tx) => rules.load(tx))).reviewThreshold.value).toBe(33);
  });
});
