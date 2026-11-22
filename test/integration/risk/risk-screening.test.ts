// Integration tests of the payment screening (feature 18, RiskScreening, RESOLUTIONS orders-suppliers-11 and money-3): the signals read
// from the database (earlier orders, the blocklist, earlier IMEI checks), the rules that decide, the assessment row, the link to the
// order and the top-up question billing asks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { placementDispatchState } from '@src/modules/orders';
import { Blocklist, RiskRules, RiskScreening, type ScreeningInput } from '@src/modules/risk';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow, type OrdersWorld, ordersWorld } from '../../support/orders';
import { assessmentOf, insertBlock, insertHeldOrder, insertImeiCheck } from '../../support/risk';
import { insertTaxWindow } from '../../support/storefront';

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

/** A payment that trips nothing: a guest with a small amount and matching countries (a guest checkout, decision 050). */
const CALM: ScreeningInput = {
  customerId: null,
  email: 'calm@example.com',
  amountUsd: '15.0000',
  paymentMethod: 'card',
  ip: '203.0.113.7',
  ipCountry: 'GB',
  cardCountry: 'GB',
  openedSignedIn: false,
};
const assess = (input: Partial<ScreeningInput>) =>
  world.db.transaction((tx) => screening.assess(tx, { ...CALM, ...input }));

/** Gives an email `count` paid orders at `at` (one customer, one checkout session per order; `session` changes the sessions). */
async function earlierOrders(
  email: string,
  count: number,
  at: Date,
  values: Partial<typeof s.orders.$inferInsert> = {},
  session: Partial<typeof s.checkoutSessions.$inferInsert> = {},
) {
  const { db } = world;
  const [customer] = await db.insert(s.customers).values({ email, name: 'Repeat Buyer', country: 'GB' }).returning();
  for (let i = 0; i < count; i += 1) {
    const [made] = await db
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
        ...session,
      })
      .returning();
    await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: world.auto.serviceId,
      source: 'store',
      status: 'completed',
      dispatchState: 'done',
      checkoutSessionId: made!.id,
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
    // The earlier order of a signed-in customer counts for that customer's own signed-in payment (decision 050).
    const customer = await earlierOrders(
      'repeat@example.com',
      1,
      new Date(clock.nowMs() - 3 * DAY),
      {},
      { openedSignedIn: true },
    );
    expect(
      (await assess({ email: 'repeat@example.com', customerId: customer.id, openedSignedIn: true, amountUsd: amount }))
        .signals,
    ).toEqual([]);
    const refused = await earlierOrders(
      'refused@example.com',
      1,
      new Date(clock.nowMs() - 3 * DAY),
      { status: 'rejected' },
      { openedSignedIn: true },
    );
    expect(
      (await assess({ email: 'refused@example.com', customerId: refused.id, openedSignedIn: true, amountUsd: amount }))
        .signals,
    ).toEqual(['New customer, first order above $40']);
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
    const held = await insertHeldOrder(world, { customer: { email: 'self@example.com' }, openedSignedIn: true });
    const withOrder = await assess({
      email: 'self@example.com',
      customerId: held.customerId,
      openedSignedIn: true,
      orderId: held.orderId,
      amountUsd: '90.0000',
    });
    expect(withOrder.signals).toEqual(['New customer, first order above $40']);
    const without = await assess({
      email: 'self@example.com',
      customerId: held.customerId,
      openedSignedIn: true,
      amountUsd: '90.0000',
    });
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

/** Inserts a checkout of an email whose payment is in flight: a session without an order and one pending order payment. */
async function pendingCheckout(
  email: string,
  options: {
    reviewRequired?: boolean;
    at?: Date;
    customerId?: number | null;
    openedSignedIn?: boolean;
    ip?: string;
  } = {},
): Promise<number> {
  const { db } = world;
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token: crypto.randomUUID(),
      customerId: options.customerId ?? null,
      email,
      serviceId: world.auto.serviceId,
      currency: 'USD',
      netAmount: '10.0000',
      grossAmount: '10.0000',
      ip: options.ip ?? '198.51.100.20',
      openedSignedIn: options.openedSignedIn ?? false,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    .returning();
  const [gateway] = await db
    .insert(s.paymentGateways)
    .values({ code: `stripe-${crypto.randomUUID().slice(0, 6)}`, driver: 'stripe', name: 'Card' })
    .returning({ id: s.paymentGateways.id });
  await db.insert(s.payments).values({
    customerId: options.customerId ?? null,
    purpose: 'order',
    gatewayId: gateway!.id,
    amount: '10.0000',
    currency: 'USD',
    status: 'pending',
    methodType: 'card',
    checkoutSessionId: session!.id,
    reviewRequired: options.reviewRequired ?? false,
    createdAt: options.at ?? new Date(clock.nowMs()),
  });
  return session!.id;
}

/** Inserts a guest checkout of an email that is attached to an existing customer row, with its order, at `at`. */
async function guestOrderOf(customerId: number, email: string, at: Date, ip = '198.51.100.77'): Promise<void> {
  const { db } = world;
  const [session] = await db
    .insert(s.checkoutSessions)
    .values({
      token: crypto.randomUUID(),
      customerId,
      email,
      serviceId: world.auto.serviceId,
      currency: 'USD',
      netAmount: '10.0000',
      grossAmount: '10.0000',
      ip,
      openedSignedIn: false,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    .returning();
  await insertOrderRow(db, {
    customerId,
    serviceId: world.auto.serviceId,
    source: 'store',
    status: 'completed',
    dispatchState: 'done',
    checkoutSessionId: session!.id,
    createdAt: at,
  });
}

const TOO_MANY = 'More than 3 orders in 24 hours from this email';

describe('RiskScreening.assess: guest payments and signed-in payments', () => {
  it('treats a guest payment as a first order even when its email has earlier orders', async () => {
    const account = await earlierOrders(
      'known@example.com',
      2,
      new Date(clock.nowMs() - 3 * DAY),
      {},
      { openedSignedIn: true },
    );
    const guest = await assess({
      email: 'known@example.com',
      customerId: account.id,
      openedSignedIn: false,
      amountUsd: '40.5000',
    });
    expect(guest.signals).toEqual(['Guest checkout, treated as a first order above $40']);
    expect(guest.score).toBe(18);
    const signedIn = await assess({
      email: 'known@example.com',
      customerId: account.id,
      openedSignedIn: true,
      amountUsd: '40.5000',
    });
    expect(signedIn.signals).toEqual([]);
  });

  it('does not count guest orders typed with an account’s email against that account’s signed-in payments', async () => {
    const account = await earlierOrders(
      'owner@example.com',
      1,
      new Date(clock.nowMs() - 5 * DAY),
      {},
      { openedSignedIn: true },
    );
    for (let i = 0; i < 3; i += 1) {
      await guestOrderOf(account.id, 'owner@example.com', new Date(clock.nowMs() - 30 * 60_000));
    }
    const signedIn = await assess({ email: 'owner@example.com', customerId: account.id, openedSignedIn: true });
    expect(signedIn.signals).toEqual([]);
    const guest = await assess({ email: 'owner@example.com', customerId: account.id, openedSignedIn: false });
    expect(guest.signals).toContain(TOO_MANY);
  });

  it('counts the checkouts of the email whose payment is pending or held, and not the checkout being screened', async () => {
    await earlierOrders('flight@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    // Two orders in the last hour: the rule's limit is three earlier orders, so one more in flight reaches it.
    expect((await assess({ email: 'flight@example.com' })).signals).toEqual([]);
    const open = await pendingCheckout('flight@example.com');
    expect((await assess({ email: 'flight@example.com' })).signals).toContain(TOO_MANY);
    // The screened checkout's own pending payment never counts.
    expect((await assess({ email: 'flight@example.com', checkoutSessionId: open })).signals).toEqual([]);
  });

  it('counts a held confirmation like an open payment page, and ignores a page older than the window', async () => {
    await earlierOrders('held@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    await pendingCheckout('held@example.com', { reviewRequired: true });
    expect((await assess({ email: 'held@example.com' })).signals).toContain(TOO_MANY);
    await earlierOrders('stale@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    await pendingCheckout('stale@example.com', { at: new Date(clock.nowMs() - 25 * HOUR) });
    expect((await assess({ email: 'stale@example.com' })).signals).toEqual([]);
  });

  it('counts each of two open checkouts of the email against the other, never against itself', async () => {
    await earlierOrders('own@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    const first = await pendingCheckout('own@example.com');
    const second = await pendingCheckout('own@example.com');
    // Each of the two checkouts sees the other one, never itself: 2 orders + 1 in flight.
    expect((await assess({ email: 'own@example.com', checkoutSessionId: first })).signals).toContain(TOO_MANY);
    expect((await assess({ email: 'own@example.com', checkoutSessionId: second })).signals).toContain(TOO_MANY);
  });

  it('counts a paid checkout that also has a pending page once, as its order', async () => {
    const buyer = await earlierOrders('twice@example.com', 2, new Date(clock.nowMs() - 20 * 60_000));
    // The first order's checkout has a second payment page still pending: it is an order, not an in-flight checkout.
    const [session] = await world.db
      .select()
      .from(s.checkoutSessions)
      .where(eq(s.checkoutSessions.customerId, buyer.id))
      .limit(1);
    const [order] = await world.db.select().from(s.orders).where(eq(s.orders.checkoutSessionId, session!.id));
    await world.db.update(s.checkoutSessions).set({ orderId: order!.id }).where(eq(s.checkoutSessions.id, session!.id));
    const [gateway] = await world.db
      .insert(s.paymentGateways)
      .values({ code: `stripe-${crypto.randomUUID().slice(0, 6)}`, driver: 'stripe', name: 'Card' })
      .returning({ id: s.paymentGateways.id });
    await world.db.insert(s.payments).values({
      purpose: 'order',
      gatewayId: gateway!.id,
      amount: '10.0000',
      currency: 'USD',
      status: 'pending',
      methodType: 'card',
      checkoutSessionId: session!.id,
    });
    expect((await assess({ email: 'twice@example.com' })).signals).toEqual([]);
  });

  it('ignores the guest checkouts of an account’s email that have pending pages when the account pays signed in', async () => {
    const account = await earlierOrders(
      'shared@example.com',
      1,
      new Date(clock.nowMs() - 5 * DAY),
      {},
      { openedSignedIn: true },
    );
    for (let i = 0; i < 3; i += 1) await pendingCheckout('shared@example.com', { customerId: account.id });
    const signedIn = await assess({ email: 'shared@example.com', customerId: account.id, openedSignedIn: true });
    expect(signedIn.signals).toEqual([]);
    const guest = await assess({ email: 'shared@example.com', customerId: account.id, openedSignedIn: false });
    expect(guest.signals).toContain(TOO_MANY);
  });

  it('screens payments of one email one after the other, so the second counts the first one’s order', async () => {
    const email = 'race@example.com';
    const buyer = await earlierOrders(email, 2, new Date(clock.nowMs() - 20 * 60_000));
    const sessionOf = async () => {
      const [row] = await world.db
        .insert(s.checkoutSessions)
        .values({
          token: crypto.randomUUID(),
          customerId: buyer.id,
          email,
          serviceId: world.auto.serviceId,
          currency: 'USD',
          netAmount: '10.0000',
          grossAmount: '10.0000',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        })
        .returning({ id: s.checkoutSessions.id });
      return row!.id;
    };
    const firstSession = await sessionOf();
    const secondSession = await sessionOf();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const firstHolds = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const first = world.db.transaction(async (tx) => {
      const verdict = await screening.assess(tx, { ...CALM, email, checkoutSessionId: firstSession });
      await tx.insert(s.orders).values({
        type: 'imei',
        source: 'store',
        imei: '353890113898412',
        unitPrice: '10.0000',
        totalPrice: '10.0000',
        currency: 'USD',
        serviceId: world.auto.serviceId,
        customerId: buyer.id,
        checkoutSessionId: firstSession,
        createdAt: new Date(clock.nowMs()),
      });
      holding();
      await gate;
      return verdict;
    });
    await firstHolds;
    let settled = false;
    const second = world.db
      .transaction((tx) => screening.assess(tx, { ...CALM, email, checkoutSessionId: secondSession }))
      .finally(() => {
        settled = true;
      });
    // The second screening waits for the first one's transaction: poll the lock table (bounded, no sleeping) until it is queued.
    for (let attempt = 0; attempt < 500 && !settled; attempt += 1) {
      const waiting = await world.db.execute(
        sql`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
      );
      if (Number((waiting.rows[0] as { waiting: number }).waiting) > 0) break;
    }
    release();
    const [firstVerdict, secondVerdict] = await Promise.all([first, second]);
    expect(firstVerdict.signals).toEqual([]);
    expect(secondVerdict.signals).toContain(TOO_MANY);
  });
});

describe('RiskScreening.assess: countries and the blocklist scopes', () => {
  it('matches a blocked country against the card’s and the visitor’s country too', async () => {
    await insertBlock(t, world.db, 'country', 'US');
    const byCard = await assess({ country: 'GB', ipCountry: 'GB', cardCountry: 'US' });
    expect(byCard).toMatchObject({ decision: 'block', score: 100 });
    expect(byCard.signals[0]).toBe('Country is on the blocklist');
    const byVisitor = await assess({ country: 'GB', ipCountry: 'us', cardCountry: null });
    expect(byVisitor).toMatchObject({ decision: 'block' });
    expect((await assess({ country: 'GB' })).block).toBe(false);
  });

  it('a guest-checkout entry blocks a guest payment and nothing else', async () => {
    const { db } = world;
    await insertBlock(t, db, 'email', 'shared@example.com', { guestOnly: true });
    const guest = await assess({ email: 'shared@example.com', openedSignedIn: false });
    expect(guest).toMatchObject({ decision: 'block', score: 100 });
    expect(guest.signals[0]).toBe('Email is on the blocklist');
    const account = await earlierOrders(
      'shared@example.com',
      1,
      new Date(clock.nowMs() - 5 * DAY),
      {},
      { openedSignedIn: true },
    );
    const signedIn = await assess({ email: 'shared@example.com', customerId: account.id, openedSignedIn: true });
    expect(signedIn.block).toBe(false);
    const blocklist = t.app.get(Blocklist);
    expect(await blocklist.isEmailBlocked(db, 'shared@example.com')).toBe(false);
    expect(await blocklist.match(db, { email: 'shared@example.com', guest: true })).toHaveLength(1);
    expect(await blocklist.match(db, { email: 'shared@example.com' })).toHaveLength(0);
    expect(await screening.reviewTopUp(db, { email: 'shared@example.com' })).toEqual({ flagged: false, reason: null });
  });
});

describe('RiskScreening.assess: the declared tax country against the evidence', () => {
  const TAX_GB_CARD_US = 'Tax country GB differs from the card country US';

  it('holds for review a payment whose card country differs from the declared country, with no other signal', async () => {
    await insertTaxWindow(world.db);
    const held = await assess({ country: 'GB', ipCountry: 'US', cardCountry: 'US' });
    expect(held).toMatchObject({ score: 0, decision: 'review', hold: true, block: false, signals: [TAX_GB_CARD_US] });
    expect(held.holdReason).toBe(`Risk hold: score 0. ${TAX_GB_CARD_US}`);
  });

  it('holds whatever the review threshold says, and a block stays a block', async () => {
    await insertTaxWindow(world.db);
    await owner.put('/admin/risk/rules', { rules: [{ id: 'reviewThreshold', on: false, value: 50 }] });
    expect((await assess({ country: 'GB', ipCountry: 'US', cardCountry: 'US' })).decision).toBe('review');
    await insertBlock(t, world.db, 'email', 'bad@example.com');
    const blocked = await assess({ country: 'GB', ipCountry: 'US', cardCountry: 'US', email: 'bad@example.com' });
    expect(blocked.decision).toBe('block');
    expect(blocked.signals).toEqual(['Email is on the blocklist', TAX_GB_CARD_US]);
  });

  it('uses the visitor’s country only when the card does not say its country', async () => {
    await insertTaxWindow(world.db);
    const byVisitor = await assess({ country: 'GB', ipCountry: 'US', cardCountry: null });
    expect(byVisitor).toMatchObject({ decision: 'review', signals: ['Tax country GB differs from the IP country US'] });
    // The card agrees with the declared country: the visitor's country is the IP-country rule's business, not a hold.
    const cardAgrees = await assess({ country: 'GB', ipCountry: 'US', cardCountry: 'GB' });
    expect(cardAgrees.signals).toEqual(['IP country differs from card country']);
    expect(cardAgrees.decision).toBe('allow');
  });

  it('keeps the declared country when no evidence is known or the evidence agrees', async () => {
    await insertTaxWindow(world.db);
    expect((await assess({ country: 'GB', ipCountry: null, cardCountry: null })).signals).toEqual([]);
    expect((await assess({ country: 'gb', ipCountry: 'GB', cardCountry: 'gb' })).signals).toEqual([]);
    expect((await assess({ country: null, ipCountry: 'US', cardCountry: 'US' })).signals).toEqual([]);
  });

  it('holds only while the shop has a tax window in force', async () => {
    const evidence = { country: 'GB', ipCountry: 'US', cardCountry: 'US' };
    expect((await assess(evidence)).decision).toBe('allow');
    const ended = await insertTaxWindow(world.db, { validTo: new Date(clock.nowMs() - DAY) });
    expect((await assess(evidence)).decision).toBe('allow');
    await world.db.update(s.taxRates).set({ validTo: null }).where(eq(s.taxRates.id, ended));
    expect((await assess(evidence)).decision).toBe('review');
  });

  it('lists the payment side’s review reasons first and applies the review once', async () => {
    await insertTaxWindow(world.db);
    const late = "Paid 45 minutes after the checkout's price lock ended";
    const result = await assess({ country: 'GB', ipCountry: 'US', cardCountry: 'US', reviewReasons: [late] });
    expect(result.signals).toEqual([late, TAX_GB_CARD_US]);
    expect(result).toMatchObject({ decision: 'review', hold: true, holdReason: late });
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
