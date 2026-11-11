// Integration tests of the payment provider fixes on the gateway settings and top-ups (feature 24C): up to two webhook secrets on the
// admin routes (hints, replace, remove, the 422, audit without values), deliveries signed with either secret on both webhook URLs, and the
// card details of a card top-up read from the PaymentIntent (fingerprint stored; unavailable details wait for staff review).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { GATEWAY_WEBHOOK_SECRET_AAD } from '../../src/modules/money/application/gateway-credentials';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  insertInvoiceRow,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;

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
  clock.set('2026-11-01T10:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

const FIRST = 'whsec_first_secret_aaaa';
const SECOND = 'whsec_second_secret_bbbb';
const eventId = () => `evt_${crypto.randomUUID()}`;
const gatewayBody = (overrides: Record<string, unknown> = {}) => ({
  code: 'stripe-pay',
  driver: 'card',
  name: 'Card gateway',
  audience: 'both',
  feePercent: '2.9',
  feeFixed: '0.30',
  minAmount: '5',
  maxAmount: '2000',
  allowedGroupIds: [] as number[],
  supportsRefunds: true,
  supports3ds: true,
  isManual: false,
  instructions: '',
  holdHours: 0,
  isActive: true,
  secret: 'sk_test_x',
  ...overrides,
});
const storedSecrets = async (id: number) => {
  const [row] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, id));
  return row!.webhookSecretEnc === null
    ? null
    : t.app.get(EncryptionService).decrypt(row!.webhookSecretEnc, GATEWAY_WEBHOOK_SECRET_AAD);
};

describe('webhook secrets on /admin/payment-gateways (24C)', () => {
  it('stores two secrets, answers both hints in create, list and show, and never the values', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const created = await admin.post(
      '/admin/payment-gateways',
      gatewayBody({ webhookSecret: FIRST, secondaryWebhookSecret: SECOND }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ webhookSecretHint: '••••aaaa', secondaryWebhookSecretHint: '••••bbbb' });
    expect(JSON.parse((await storedSecrets(created.body.id))!)).toEqual([FIRST, SECOND]);
    const list = await admin.get('/admin/payment-gateways');
    expect(list.body[0]).toMatchObject({ webhookSecretHint: '••••aaaa', secondaryWebhookSecretHint: '••••bbbb' });
    const shown = await admin.get(`/admin/payment-gateways/${created.body.id}`);
    expect(shown.body).toMatchObject({ webhookSecretHint: '••••aaaa', secondaryWebhookSecretHint: '••••bbbb' });
    expect(JSON.stringify([created.body, list.body, shown.body])).not.toContain(FIRST);
    expect(JSON.stringify([created.body, list.body, shown.body])).not.toContain(SECOND);
  });

  it('a gateway without webhook secrets answers null hints', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const created = await admin.post('/admin/payment-gateways', gatewayBody());
    expect(created.body).toMatchObject({ webhookSecretHint: null, secondaryWebhookSecretHint: null });
    expect(await storedSecrets(created.body.id)).toBeNull();
  });

  it('replacing the first keeps the second; null removes the second; the audit says changed without values', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const { id } = (await admin.post('/admin/payment-gateways', gatewayBody({ webhookSecret: FIRST }))).body;
    const added = await admin.patch(`/admin/payment-gateways/${id}`, { secondaryWebhookSecret: `  ${SECOND}  ` });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ webhookSecretHint: '••••aaaa', secondaryWebhookSecretHint: '••••bbbb' });
    expect(JSON.parse((await storedSecrets(id))!)).toEqual([FIRST, SECOND]);

    const replaced = await admin.patch(`/admin/payment-gateways/${id}`, { webhookSecret: 'whsec_new_first_cccc' });
    expect(replaced.body).toMatchObject({ webhookSecretHint: '••••cccc', secondaryWebhookSecretHint: '••••bbbb' });
    expect(JSON.parse((await storedSecrets(id))!)).toEqual(['whsec_new_first_cccc', SECOND]);

    const removed = await admin.patch(`/admin/payment-gateways/${id}`, { secondaryWebhookSecret: null });
    expect(removed.body).toMatchObject({ webhookSecretHint: '••••cccc', secondaryWebhookSecretHint: null });
    expect(JSON.parse((await storedSecrets(id))!)).toEqual(['whsec_new_first_cccc']);

    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'payment_gateway'));
    expect(audits.map((row) => row.action)).toEqual([
      'added payment method',
      'changed payment method',
      'changed payment method',
      'changed payment method',
    ]);
    expect(audits[1]!.after).toMatchObject({ hasWebhookSecret: true, hasSecondaryWebhookSecret: true });
    expect(audits[3]!.after).toMatchObject({ hasSecondaryWebhookSecret: false });
    const text = JSON.stringify(audits);
    for (const secret of [FIRST, SECOND, 'whsec_new_first_cccc']) expect(text).not.toContain(secret);
  });

  it('refuses a second secret without a first (422 on secondaryWebhookSecret), and a blank one', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const alone = await admin.post('/admin/payment-gateways', gatewayBody({ secondaryWebhookSecret: SECOND }));
    expect(alone.status).toBe(422);
    expect(alone.body.errors).toEqual([
      expect.objectContaining({ field: 'secondaryWebhookSecret', code: 'requires_first' }),
    ]);
    expect(await db.select().from(s.paymentGateways)).toHaveLength(0);

    const { id } = (await admin.post('/admin/payment-gateways', gatewayBody())).body;
    const later = await admin.patch(`/admin/payment-gateways/${id}`, { secondaryWebhookSecret: SECOND });
    expect(later.status).toBe(422);
    expect(later.body.errors[0]).toMatchObject({ field: 'secondaryWebhookSecret' });
    const blank = await admin.patch(`/admin/payment-gateways/${id}`, {
      webhookSecret: FIRST,
      secondaryWebhookSecret: '   ',
    });
    expect(blank.status).toBe(422);
    expect(blank.body.errors[0]).toMatchObject({ field: 'secondaryWebhookSecret' });
    // Sending both at once is fine.
    const both = await admin.patch(`/admin/payment-gateways/${id}`, {
      webhookSecret: FIRST,
      secondaryWebhookSecret: SECOND,
    });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ webhookSecretHint: '••••aaaa', secondaryWebhookSecretHint: '••••bbbb' });
  });
});

describe('deliveries signed with either secret (24C)', () => {
  /** A merchant with an open top-up invoice at a card gateway that keeps the given webhook keys. */
  async function world(secrets: string[] | null) {
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    const gatewayId = await insertGateway(t, db, { code: 'card', driver: 'card', apiBase: fake.url });
    if (secrets !== null) {
      const sealed = t.app.get(EncryptionService).encrypt(JSON.stringify(secrets), GATEWAY_WEBHOOK_SECRET_AAD);
      await db.update(s.paymentGateways).set({ webhookSecretEnc: sealed }).where(eq(s.paymentGateways.id, gatewayId));
    }
    const invoice = await insertInvoiceRow(db, merchant.id, { amount: '100.0000', fee: '3.2000', gatewayId });
    return { invoice };
  }
  const deliver = (url: 'payments' | 'disputes', body: string, secret: string) =>
    t.app.inject({
      method: 'POST',
      url: `/webhooks/${url}/card`,
      headers: signedHeaders(secret, body, clock),
      payload: body,
    });

  it('a legacy single secret still verifies', async () => {
    const { invoice } = await world(null);
    const body = cardEvent(eventId(), invoice.number, { reference: 'pi_legacy', amount: 10000 });
    expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
    expect(await db.select().from(s.payments)).toHaveLength(1);
  });

  it('the first or the second secret verifies on both URLs; neither is 400 WEBHOOK_SIGNATURE_INVALID', async () => {
    const { invoice } = await world([FIRST, SECOND]);
    for (const [url, secret] of [
      ['payments', FIRST],
      ['payments', SECOND],
      ['disputes', FIRST],
      ['disputes', SECOND],
    ] as const) {
      const body = cardEvent(eventId(), invoice.number, { type: 'customer.created' });
      const res = await deliver(url, body, secret);
      expect({ url, secret, status: res.statusCode }).toEqual({ url, secret, status: 200 });
    }
    for (const url of ['payments', 'disputes'] as const) {
      const res = await deliver(url, cardEvent(eventId(), invoice.number), 'whsec_someone_else');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    // The payment confirmed with the second secret is recorded.
    const body = cardEvent(eventId(), invoice.number, { reference: 'pi_second', amount: 10000 });
    expect((await deliver('payments', body, SECOND)).statusCode).toBe(200);
    expect((await db.select().from(s.payments))[0]).toMatchObject({ gatewayTxnId: 'pi_second' });
  });
});

describe('card details of a card top-up (24C)', () => {
  async function world() {
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    const gatewayId = await insertGateway(t, db, { code: 'card', driver: 'card', apiBase: fake.url });
    const invoice = await insertInvoiceRow(db, merchant.id, { amount: '100.0000', fee: '3.2000', gatewayId });
    return { invoice };
  }
  const send = (body: string) => postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock));

  it('stores the fingerprint read from the latest charge and credits itself as usual', async () => {
    const { invoice } = await world();
    fake.cards.set('pi_fp', { brand: 'visa', last4: '4242', fingerprint: 'fp_topup' });
    expect((await send(cardEvent(eventId(), invoice.number, { reference: 'pi_fp', amount: 10000 }))).statusCode).toBe(
      200,
    );
    const [payment] = await db.select().from(s.payments);
    expect(payment).toMatchObject({ cardFingerprint: 'fp_topup', reviewRequired: false, reviewNote: null });
    expect(payment!.autoCreditAt).not.toBeNull();
    const read = fake.requests.find((request) => request.path === '/v1/payment_intents/pi_fp');
    expect(read).toMatchObject({ method: 'GET' });
  });

  it('unavailable details put the top-up in staff review instead of the automatic credit', async () => {
    const { invoice } = await world();
    fake.failDetails = 503;
    expect((await send(cardEvent(eventId(), invoice.number, { reference: 'pi_down', amount: 10000 }))).statusCode).toBe(
      200,
    );
    const [payment] = await db.select().from(s.payments);
    expect(payment).toMatchObject({
      status: 'pending',
      cardFingerprint: null,
      reviewRequired: true,
      autoCreditAt: null,
      reviewNote: 'Card details could not be read from the gateway.',
    });
  });

  it('joins the note to an amount mismatch', async () => {
    const { invoice } = await world();
    fake.failDetails = 500;
    expect((await send(cardEvent(eventId(), invoice.number, { reference: 'pi_both', amount: 5000 }))).statusCode).toBe(
      200,
    );
    const [payment] = await db.select().from(s.payments);
    expect(payment!.reviewNote).toBe(
      'The gateway reports 50.0000 paid; the invoice is 100.0000. Card details could not be read from the gateway.',
    );
  });
});
