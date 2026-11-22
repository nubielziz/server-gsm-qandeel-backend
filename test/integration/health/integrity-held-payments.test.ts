// Integration tests of the money integrity check for storefront payments held for staff (decision 048): a payment the gateway confirmed
// that could not pay its checkout is a finding of "Every confirmed payment has an entry" until its money is sent back.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { HealthJobsModule, LedgerIntegrityProcessor } from '@src/modules/health';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ordersWorld } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { RedisService } from '@src/infra/redis';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-21T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [HealthJobsModule] });
});
beforeEach(async () => {
  clock.set('2026-11-21T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const runJob = () => t.app.get(LedgerIntegrityProcessor, { strict: false }).process({ data: {} } as Job);
/** The payments check of the report, read with a fresh session. */
async function paymentsCheck() {
  const body = (await (await adminWith(t, ['system:read'])).get('/admin/system/integrity')).body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
  return body.checks.find((check: { key: string }) => check.key === 'payments_without_entry') as Record<string, any>;
}

describe('payments_without_entry and held storefront payments (decision 048)', () => {
  it('a held storefront payment is a finding until its money is back', async () => {
    const { db } = await testDb();
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'card-b2c', driver: 'card', name: 'Card gateway', audience: 'b2c' })
      .returning();
    const [held] = await db
      .insert(s.payments)
      .values({
        purpose: 'order',
        gatewayId: gateway!.id,
        gatewayTxnId: 'pi_h',
        amount: '3.8400',
        currency: 'USD',
        status: 'pending',
        methodType: 'card',
        reviewRequired: true,
        reviewNote: 'The gateway confirmed 1.0000 but the payment was opened for 3.8400.',
      })
      .returning();
    // A pending payment that is not held is not confirmed: never a finding.
    await db.insert(s.payments).values({
      purpose: 'order',
      gatewayId: gateway!.id,
      amount: '3.8400',
      currency: 'USD',
      status: 'pending',
      methodType: 'card',
    });
    await runJob();
    const found = await paymentsCheck();
    expect(found).toMatchObject({ status: 'fail', count: 1, difference: '3.8400' });
    expect(found.findings).toEqual([
      expect.objectContaining({
        kind: 'payment',
        id: held!.id,
        ref: 'pi_h',
        label: 'Payment · Card gateway',
        difference: '3.8400',
      }),
    ]);

    const [refund] = await db
      .insert(s.refunds)
      .values({
        paymentId: held!.id,
        amount: '3.8400',
        currency: 'USD',
        reason: 'Paid back by hand by staff',
        method: 'manual',
        status: 'completed',
        requestedByType: 'system',
      })
      .returning();
    const statusOf = async (status: 'processing' | 'completed' | 'failed') => {
      await db.update(s.refunds).set({ status }).where(eq(s.refunds.id, refund!.id));
      clock.advance(60_000);
      await runJob();
      return (await paymentsCheck()).count as number;
    };
    expect(await statusOf('completed')).toBe(0);
    expect(await statusOf('processing')).toBe(0);
    // A return that failed leaves the money with the buyer's gateway: the finding comes back.
    expect(await statusOf('failed')).toBe(1);
  });
});
