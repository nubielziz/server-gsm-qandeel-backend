// Integration tests of the 24-hour limit on one staff member's approvals of transfer receipts (decision 049): the top-ups that merchants
// and customers make through a manual method count per staff member against `wallet.receipt_approval_limit` (default $10,000); above it
// the approval is `409 APPROVAL_REQUIRED` and nothing is posted; an Owner is not limited; an automatic top-up sent to review and the
// payment of a staff-issued invoice are not counted; two approvals of one staff member are judged one after the other.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminFor, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertStaff } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment, insertProofFile } from '../../support/billing';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { accountFigures, insertWalletMerchant } from '../../support/money';
import { makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

const REVIEWER = ['payments:approve', 'payments:read'];

/** A merchant, a manual (bank) and an automatic (card) gateway. */
async function world() {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const bank = await insertGateway(t, db, { name: 'Bank transfer', isManual: true });
  const card = await insertGateway(t, db, { name: 'Card gateway', driver: 'card' });
  return { db, merchant, bank, card };
}

/** A pending top-up of the merchant with a receipt, through the given gateway; `issuedBy` makes it a staff-issued invoice. */
async function pendingTopUp(
  w: Awaited<ReturnType<typeof world>>,
  amount: string,
  options: { gatewayId?: number; fee?: string; issuedBy?: number; reviewRequired?: boolean } = {},
) {
  const gatewayId = options.gatewayId ?? w.bank;
  const manual = gatewayId === w.bank;
  const invoice = await insertInvoiceRow(w.db, w.merchant.id, {
    amount,
    fee: options.fee ?? '0.0000',
    gatewayId,
    ...(options.issuedBy === undefined ? {} : { kind: 'manual' as const, issuedBy: options.issuedBy }),
  });
  const receiptFileId = manual ? await insertProofFile(w.db, w.merchant.id) : null;
  const payment = await insertPendingPayment(w.db, invoice, gatewayId, {
    methodType: manual ? 'bank' : 'card',
    gatewayTxnId: `TRX-${crypto.randomUUID()}`,
    receiptFileId,
    reviewRequired: options.reviewRequired ?? false,
  });
  return payment.id;
}

const approve = (staff: AdminApi, paymentId: number) => staff.post(`/admin/payments/${paymentId}/approve`);
const walletOf = async (clientId: number) => {
  const { db } = await testDb();
  return (await accountFigures(db, 'client_wallet', { type: 'account', id: clientId }))?.balance;
};
const statusOf = async (paymentId: number) => {
  const { db } = await testDb();
  return (await db.select({ status: s.payments.status }).from(s.payments).where(eq(s.payments.id, paymentId)))[0]
    ?.status;
};

describe('POST /admin/payments/:id/approve: the 24-hour limit of a staff member', () => {
  it('approves up to the limit, then refuses with 409 APPROVAL_REQUIRED and posts nothing', async () => {
    const w = await world();
    const staff = await adminWith(t, REVIEWER);
    expect((await approve(staff, await pendingTopUp(w, '6000.0000'))).status).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '4000.0000'))).status).toBe(200);
    const third = await pendingTopUp(w, '0.0001');
    const refused = await approve(staff, third);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'APPROVAL_REQUIRED',
      detail: 'Approved transfer top-ups over $10,000 in 24 hours need an owner: yours would come to $10,000.0001.',
    });
    expect(await statusOf(third)).toBe('pending');
    expect(await walletOf(w.merchant.id)).toBe('10000.0000');
    // Another staff member has a limit of their own, and an Owner none.
    expect((await approve(await adminWith(t, REVIEWER), third)).status).toBe(200);
    const owner = await adminWith(t, ['*']);
    expect((await approve(owner, await pendingTopUp(w, '20000.0000'))).status).toBe(200);
    expect((await approve(owner, await pendingTopUp(w, '20000.0000'))).status).toBe(200);
  });

  it('counts what is credited (net of the fee) and forgets approvals after 24 hours', async () => {
    const w = await world();
    const staff = await adminWith(t, REVIEWER);
    expect((await approve(staff, await pendingTopUp(w, '10003.0000', { fee: '3.0000' }))).status).toBe(200);
    const next = await pendingTopUp(w, '1.0000');
    expect((await approve(staff, next)).status).toBe(409);
    clock.advance(DAY + 1);
    const later = await adminFor(t, staff.staffId, staff.roleId);
    expect((await approve(later, next)).status).toBe(200);
  });

  it('reads the limit from the setting wallet.receipt_approval_limit', async () => {
    const w = await world();
    const { db } = await testDb();
    await db.insert(s.settings).values({ key: 'wallet.receipt_approval_limit', value: 250 });
    const staff = await adminWith(t, REVIEWER);
    expect((await approve(staff, await pendingTopUp(w, '250.0000'))).status).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '0.0001'))).status).toBe(409);
  });

  it('does not count an automatic top-up sent to review or the payment of a staff-issued invoice', async () => {
    const w = await world();
    const staff = await adminWith(t, REVIEWER);
    const issuer = await insertStaff(w.db, staff.roleId);
    expect(
      (await approve(staff, await pendingTopUp(w, '20000.0000', { gatewayId: w.card, reviewRequired: true }))).status,
    ).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '20000.0000', { issuedBy: issuer }))).status).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '10000.0000'))).status).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '0.0001'))).status).toBe(409);
  });

  it("counts a storefront customer's transfer top-up with the merchants' ones", async () => {
    const w = await world();
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const cliq = await insertGateway(t, w.db, {
      driver: 'manual',
      name: 'CliQ transfer',
      audience: 'b2c',
      isManual: true,
    });
    const invoice = await insertInvoiceRow(w.db, customer.id, {
      legacyClientId: null,
      walletKind: 'customer_wallet',
      amount: '6000.0000',
      gatewayId: cliq,
    });
    const receiptFileId = await insertProofFile(w.db, customer.id, { ownerType: 'account' });
    const payment = await insertPendingPayment(w.db, invoice, cliq, { methodType: 'bank', receiptFileId });
    const staff = await adminWith(t, REVIEWER);
    expect((await approve(staff, payment.id)).status).toBe(200);
    expect((await approve(staff, await pendingTopUp(w, '4000.0001'))).status).toBe(409);
  });

  it('judges two approvals of one staff member at once one after the other', async () => {
    const w = await world();
    const staff = await adminWith(t, REVIEWER);
    const first = await pendingTopUp(w, '6000.0000');
    const second = await pendingTopUp(w, '6000.0000');
    const answers = await Promise.all([approve(staff, first), approve(staff, second)]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await walletOf(w.merchant.id)).toBe('6000.0000');
  });
});
