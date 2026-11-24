// Integration tests of the risk module on the one account type (decision 064): the review queue names the
// buyer account of any rank and counts its shop orders only, the velocity rules of the screening ignore the orders a merchant account
// holds from its wallet, the assessment and the blocklist entries carry `account_id`, and the assessments of a guest row move to the account
// that claims them without ever waiting for a lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CLOCK } from '@src/common/clock';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { GuestClaimParticipants } from '@src/modules/identity';
import { Blocklist, RiskScreening, type ScreeningInput } from '@src/modules/risk';
import { GUEST_CLAIM_RISK, RiskGuestClaimParticipant } from '@src/modules/risk/application/guest-claim.participant';
import { makeAccount } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { insertCustomerHistory } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow, type OrdersWorld, ordersWorld } from '../../support/orders';
import { insertHeldOrder } from '../../support/risk';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;
let db: Database;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld(db);
  staff = await adminWith(t, ['risk:read', 'risk:decide', 'clients:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A shop order of an account, created `minutesAgo` minutes before the clock. */
const shopOrder = (accountId: number, minutesAgo: number) =>
  insertOrderRow(db, {
    accountId,
    serviceId: world.auto.serviceId,
    source: 'store',
    status: 'completed',
    dispatchState: 'done',
    createdAt: new Date(clock.nowMs() - minutesAgo * MINUTE),
  });

describe('the review queue names the buyer account', () => {
  it('shows an account of a merchant rank as the buyer, with its shop orders only in the history', async () => {
    const merchantId = world.merchant.id;
    const held = await insertHeldOrder(world, { customerId: merchantId, createdAt: new Date(clock.nowMs() - HOUR) });
    // Two shop orders before the held one count; three portal orders of the same account are not its shopping history.
    await shopOrder(merchantId, 600);
    await shopOrder(merchantId, 500);
    for (const minutes of [900, 800, 700]) {
      await insertOrderRow(db, {
        accountId: merchantId,
        serviceId: world.auto.serviceId,
        source: 'portal',
        createdAt: new Date(clock.nowMs() - minutes * MINUTE),
      });
    }
    const [card] = (await staff.get('/admin/risk/queue')).body.held;
    expect(card).toMatchObject({
      orderId: held.orderId,
      customer: { id: merchantId, name: world.merchant.name, history: { earlierOrders: 2, refunds: 0, disputes: 0 } },
    });
    // The key keeps its name on the wire and holds the account number: the retired customer number space is gone.
    expect(Object.keys(card)).toContain('customer');
    expect(Object.keys(card)).not.toContain('account');
  });

  it('counts the refunds and disputes of the account by account id', async () => {
    const buyer = await makeAccount({ rank: 'retail', db, name: 'Omar Haddad' });
    const earlier = await shopOrder(buyer.id, 600);
    await insertCustomerHistory(db, buyer.id, earlier.id);
    const held = await insertHeldOrder(world, { customerId: buyer.id });
    const [card] = (await staff.get('/admin/risk/queue')).body.held;
    expect(card).toMatchObject({
      orderId: held.orderId,
      customer: { id: buyer.id, history: { earlierOrders: 1, refunds: 1, disputes: 1 } },
    });
    // Another account's refund and dispute are not this account's history.
    const stranger = await makeAccount({ rank: 'retail', db });
    const strangerOrder = await shopOrder(stranger.id, 600);
    await insertCustomerHistory(db, stranger.id, strangerOrder.id);
    expect((await staff.get('/admin/risk/queue')).body.held[0].customer.history).toEqual({
      earlierOrders: 1,
      refunds: 1,
      disputes: 1,
    });
  });

  it('lists shop orders only, and counts only shop orders in the held share', async () => {
    const merchantId = world.merchant.id;
    const held = await insertHeldOrder(world, { createdAt: new Date(clock.nowMs() - HOUR) });
    await shopOrder(held.accountId, 30);
    // A held-looking portal order with a review assessment is not a shop order: the queue and the share leave it out.
    for (let i = 0; i < 3; i += 1) {
      const portal = await insertOrderRow(db, {
        accountId: merchantId,
        serviceId: world.auto.serviceId,
        source: 'portal',
        dispatchState: 'held',
      });
      await db.insert(s.riskAssessments).values({
        orderId: portal.id,
        accountId: merchantId,
        score: 70,
        decision: 'review',
        signals: ['Test signal'],
      });
    }
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).toEqual([held.orderId]);
    // Two shop orders in the window (the held one and the delivered one), one of them held: 50 %.
    expect(queue.stats.heldShare).toBe(50);
  });

  it('names an account made by staff before the order in the decision: the email block is limited to guest checkouts', async () => {
    const at = new Date(clock.nowMs());
    // The account of the email exists (made by staff, never verified); the guest checkout is another row of the same email.
    await makeAccount({
      rank: 'retail',
      db,
      email: 'staff-made@example.com',
      password: null,
      createdBy: staff.staffId,
    });
    const held = await insertHeldOrder(world, { createdAt: at, customer: { email: 'staff-made@example.com' } });
    const res = await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { blockEmail: true });
    expect(res.status).toBe(204);
    const entries = await db.select().from(s.blocklistEntries);
    expect(entries.map((entry) => [entry.kind, entry.guestOnly])).toEqual([['email', true]]);
  });
});

describe('the velocity rules count shop orders only', () => {
  const CALM: ScreeningInput = {
    accountId: null,
    email: 'calm@example.com',
    amountUsd: '15.0000',
    paymentMethod: 'card',
    ip: '203.0.113.7',
    ipCountry: 'GB',
    cardCountry: 'GB',
    openedSignedIn: false,
  };
  const assess = (input: Partial<ScreeningInput>) =>
    db.transaction((tx) => t.app.get(RiskScreening).assess(tx, { ...CALM, ...input }));
  const BURST = '4 orders in one hour from one device';

  it('ignores 300 portal orders of the same account: no daily or burst signal, and the first shop order is still a first order', async () => {
    const merchantId = world.merchant.id;
    const [merchant] = await db.select().from(s.clients).where(eq(s.clients.id, merchantId));
    await db.insert(s.orders).values(
      Array.from({ length: 300 }, (_, index) => ({
        type: 'imei' as const,
        source: 'portal' as const,
        imei: '353890113898412',
        unitPrice: '10.0000',
        totalPrice: '10.0000',
        currency: 'USD',
        accountId: merchantId,
        legacyClientId: merchantId,
        serviceId: world.auto.serviceId,
        createdAt: new Date(clock.nowMs() - (index % 50) * MINUTE),
      })),
    );
    for (const openedSignedIn of [false, true]) {
      const result = await assess({
        email: merchant!.email,
        accountId: merchantId,
        openedSignedIn,
        amountUsd: '90.0000',
      });
      expect(result.signals, String(openedSignedIn)).toEqual(['New customer, first order above $40']);
    }
    // The same number of shop orders of the account does raise the signals: three in the hour make the next one the fourth.
    for (const minutes of [5, 10, 15]) await shopOrder(merchantId, minutes);
    const raised = await assess({ email: merchant!.email, accountId: merchantId, openedSignedIn: false });
    expect(raised.signals).toContain(BURST);
  });
});

describe('the assessment and the blocklist carry the account', () => {
  it('writes the buyer account on the assessment and nothing in the retired customer column', async () => {
    const guest = await makeAccount({ rank: 'retail', db, guest: true });
    const result = await db.transaction((tx) =>
      t.app.get(RiskScreening).assess(tx, {
        accountId: guest.id,
        email: guest.email,
        amountUsd: '15.0000',
        paymentMethod: 'card',
        openedSignedIn: false,
      }),
    );
    const [row] = await db.select().from(s.riskAssessments).where(eq(s.riskAssessments.id, result.assessmentId));
    expect(row).toMatchObject({ accountId: guest.id, retiredCustomerId: null });
    const without = await db.transaction((tx) =>
      t.app.get(RiskScreening).assess(tx, {
        accountId: null,
        email: 'nobody@example.com',
        amountUsd: '15.0000',
        paymentMethod: 'card',
        openedSignedIn: false,
      }),
    );
    const [none] = await db.select().from(s.riskAssessments).where(eq(s.riskAssessments.id, without.assessmentId));
    expect(none).toMatchObject({ accountId: null, retiredCustomerId: null });
  });

  it('links a block to the account it came from, of any rank, and unblocking removes only its manual entries', async () => {
    const blocklist = t.app.get(Blocklist);
    const merchantId = world.merchant.id;
    const retail = await makeAccount({ rank: 'retail', db });
    const base = { reason: 'Chargeback lost', createdBy: staff.staffId } as const;
    const added = await db.transaction((tx) =>
      blocklist.add(tx, [
        { ...base, kind: 'email', value: 'merchant-block@example.com', source: 'manual', accountId: merchantId },
        { ...base, kind: 'card', value: 'fp_merchant', source: 'manual', accountId: merchantId },
        { ...base, kind: 'email', value: 'chargeback@example.com', source: 'chargeback', accountId: merchantId },
        { ...base, kind: 'email', value: 'retail-block@example.com', source: 'manual', accountId: retail.id },
        { ...base, kind: 'email', value: 'plain@example.com', source: 'manual' },
      ]),
    );
    expect(added).toHaveLength(5);
    expect(added.map((entry) => [entry.accountId, entry.retiredCustomerId])).toEqual([
      [merchantId, null],
      [merchantId, null],
      [merchantId, null],
      [retail.id, null],
      [null, null],
    ]);
    const removed = await db.transaction((tx) => blocklist.removeAddedByBlockOf(tx, merchantId));
    expect(removed.map((entry) => entry.kind).sort()).toEqual(['card', 'email']);
    const left = await db.select().from(s.blocklistEntries);
    expect(left.map((entry) => [entry.kind, entry.source, entry.accountId]).sort()).toEqual([
      ['email', 'chargeback', merchantId],
      ['email', 'manual', null],
      ['email', 'manual', retail.id],
    ]);
  });
});

describe('the guest claim participant of risk', () => {
  const claim = (participant: RiskGuestClaimParticipant, guestId: number, accountId: number) =>
    db.transaction((tx) => participant.move(tx, { guestId, accountId }));
  const newParticipant = () => new RiskGuestClaimParticipant(new GuestClaimParticipants(), t.app.get(CLOCK));

  /** An assessment of an account row, as a screening or a held order writes it. */
  const assessmentOf = async (accountId: number) => {
    const [row] = await db
      .insert(s.riskAssessments)
      .values({ accountId, score: 40, decision: 'allow', signals: ['A signal'] })
      .returning();
    return row!;
  };

  it('registers under its own name with the claim registry when the module starts', () => {
    const registry = new GuestClaimParticipants();
    new RiskGuestClaimParticipant(registry, t.app.get(CLOCK)).onModuleInit();
    expect(registry.names()).toEqual([GUEST_CLAIM_RISK]);
    expect(GUEST_CLAIM_RISK).toBe('risk_assessments');
    // The running application installs it too, next to the other participants.
    expect(t.app.get(GuestClaimParticipants).names()).toContain(GUEST_CLAIM_RISK);
  });

  it('moves the assessments of the guest row to the account, changes nothing else, and leaves other accounts alone', async () => {
    const guest = await makeAccount({ rank: 'retail', db, guest: true });
    const account = await makeAccount({ rank: 'retail', db });
    const other = await makeAccount({ rank: 'retail', db });
    const first = await assessmentOf(guest.id);
    const second = await assessmentOf(guest.id);
    const theirs = await assessmentOf(other.id);
    clock.advance(5 * MINUTE);
    expect(await claim(newParticipant(), guest.id, account.id)).toBe(2);
    const rows = new Map((await db.select().from(s.riskAssessments)).map((row) => [row.id, row]));
    for (const moved of [first, second]) {
      expect(rows.get(moved.id)).toMatchObject({
        accountId: account.id,
        score: 40,
        decision: 'allow',
        signals: ['A signal'],
        reviewedBy: null,
        outcome: null,
      });
      expect(rows.get(moved.id)!.updatedAt.getTime()).toBe(clock.nowMs());
    }
    expect(rows.get(theirs.id)).toMatchObject({ accountId: other.id });
    // Nothing is left to move the second time.
    expect(await claim(newParticipant(), guest.id, account.id)).toBe(0);
  });

  it('moves nothing and takes no lock when the guest row has no assessment', async () => {
    const guest = await makeAccount({ rank: 'retail', db, guest: true });
    const account = await makeAccount({ rank: 'retail', db });
    expect(await claim(newParticipant(), guest.id, account.id)).toBe(0);
  });

  it('refuses at once with the lock error while another transaction holds one of the assessments (a staff decision)', async () => {
    const guest = await makeAccount({ rank: 'retail', db, guest: true });
    const account = await makeAccount({ rank: 'retail', db });
    const held = await assessmentOf(guest.id);
    await assessmentOf(guest.id);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A reviewer approving the order locks its assessment first.
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: s.riskAssessments.id })
        .from(s.riskAssessments)
        .where(eq(s.riskAssessments.id, held.id))
        .for('update');
      locked();
      await hold;
    });
    await holding;
    const started = performance.now();
    const failure = await claim(newParticipant(), guest.id, account.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(pgErrorInfo(failure)?.code).toBe('55P03');
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
    // The refused claim rolled back: both assessments still belong to the guest row.
    const owners = (await db.select().from(s.riskAssessments)).map((row) => row.accountId);
    expect(owners).toEqual([guest.id, guest.id]);
  });
});
