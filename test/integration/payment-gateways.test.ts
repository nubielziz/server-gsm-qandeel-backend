// Integration tests of the payment gateway routes (map stage 8): list, read, add, change and delete with the secret hint, the
// webhook key, the validation field errors, the immutable code, the delete guard, the audit rows and the public group cleanup.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { EncryptionService } from '../../src/infra/crypto';
import { PaymentGateways } from '../../src/modules/money';
import {
  GATEWAY_CONFIG_AAD,
  GATEWAY_WEBHOOK_SECRET_AAD,
} from '../../src/modules/money/application/gateway-credentials';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../support/billing';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';

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

const body = (overrides: Record<string, unknown> = {}) => ({
  code: 'card',
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
  secret: 'sk_live_abcdef4f2a',
  ...overrides,
});

describe('POST /admin/payment-gateways', () => {
  it('stores the gateway with the credentials encrypted and answers only a hint', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const res = await admin.post('/admin/payment-gateways', body({ webhookSecret: 'whsec_card_key' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'card',
      feePercent: '2.9000',
      feeFixed: '0.3000',
      minAmount: '5.0000',
      maxAmount: '2000.0000',
      secretHint: '••••4f2a',
      volume30d: '0.0000',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toContain('sk_live');
    const { db } = await testDb();
    const [row] = await db.select().from(s.paymentGateways);
    const encryption = t.app.get(EncryptionService);
    expect(row!.configEnc).not.toContain('sk_live');
    expect(JSON.parse(encryption.decrypt(row!.configEnc!, GATEWAY_CONFIG_AAD))).toEqual({
      secret: 'sk_live_abcdef4f2a',
    });
    expect(encryption.decrypt(row!.webhookSecretEnc!, GATEWAY_WEBHOOK_SECRET_AAD)).toBe('whsec_card_key');
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'added payment method',
      entityType: 'payment_gateway',
      entityLabel: 'Card gateway',
    });
    expect(JSON.stringify(audit!.after)).not.toContain('sk_live');
  });

  it('refuses each bad field with its name and a code that another gateway uses', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const bad = await admin.post(
      '/admin/payment-gateways',
      body({
        code: 'Bad Code',
        name: ' ',
        feePercent: '120',
        feeFixed: '-1',
        minAmount: '50',
        maxAmount: '10',
        holdHours: 721,
        allowedGroupIds: [9999],
      }),
    );
    expect(bad.status).toBe(422);
    const fields = bad.body.errors.map((error: { field: string }) => error.field).sort();
    expect(fields).toEqual(['allowedGroupIds', 'code', 'feeFixed', 'feePercent', 'holdHours', 'maxAmount', 'name']);
    expect((await admin.post('/admin/payment-gateways', body())).status).toBe(201);
    const taken = await admin.post('/admin/payment-gateways', body());
    expect(taken.status).toBe(422);
    expect(taken.body.errors[0]).toMatchObject({
      field: 'code',
      message: 'Another payment method already uses this code.',
    });
  });

  it('refuses a caller without payments:gateways and a request without the CSRF token', async () => {
    const reader = await adminWith(t, ['payments:read']);
    expect((await reader.post('/admin/payment-gateways', body())).status).toBe(403);
    const admin = await adminWith(t, ['payments:gateways']);
    expect((await admin.withoutCsrf('POST', '/admin/payment-gateways', body())).status).toBe(403);
  });
});

describe('GET /admin/payment-gateways', () => {
  it('lists with the secret hint and the 30-day volume of captured top-ups only', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    const gatewayId = await insertGateway(t, db, { code: 'card', name: 'Card', secret: 'sk_abcd1234' });
    await insertGateway(t, db, { code: 'bank', name: 'Bank', isManual: true });
    const invoice = await insertInvoiceRow(db, merchant.id);
    const day = 86_400_000;
    await insertPendingPayment(db, invoice, gatewayId, {
      status: 'approved',
      amount: '100.0000',
      capturedAt: new Date(clock.nowMs() - 5 * day),
    });
    await insertPendingPayment(db, invoice, gatewayId, {
      status: 'approved',
      amount: '50.0000',
      capturedAt: new Date(clock.nowMs() - 40 * day),
    });
    await insertPendingPayment(db, invoice, gatewayId, {
      status: 'pending',
      amount: '70.0000',
      capturedAt: new Date(clock.nowMs() - 1 * day),
    });
    await insertPendingPayment(db, invoice, gatewayId, {
      status: 'rejected',
      amount: '30.0000',
      capturedAt: new Date(clock.nowMs() - 1 * day),
    });
    const res = await admin.get('/admin/payment-gateways?_start=0&_end=200&_sort=name&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((row: { name: string }) => row.name)).toEqual(['Bank', 'Card']);
    const card = res.body.find((row: { code: string }) => row.code === 'card');
    expect(card).toMatchObject({ secretHint: '••••1234', volume30d: '100.0000' });
    expect(res.body.find((row: { code: string }) => row.code === 'bank')).toMatchObject({
      secretHint: null,
      volume30d: '0.0000',
    });
    expect((await admin.get('/admin/payment-gateways?q=bank')).body).toHaveLength(1);
    expect((await admin.get('/admin/payment-gateways?isActive=false')).total).toBe(0);
  });

  it('reads one gateway and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const id = await insertGateway(t, db, { code: 'wise', driver: 'wise', isManual: true, name: 'Wise' });
    expect((await admin.get(`/admin/payment-gateways/${id}`)).body).toMatchObject({ code: 'wise', isManual: true });
    expect((await admin.get('/admin/payment-gateways/99999')).status).toBe(404);
  });
});

describe('PATCH /admin/payment-gateways/:id', () => {
  it('changes only what is sent, keeps the secret unless a new one comes, and audits before and after', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const created = (await admin.post('/admin/payment-gateways', body())).body;
    const off = await admin.patch(`/admin/payment-gateways/${created.id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, name: 'Card gateway', secretHint: '••••4f2a' });
    const renamed = await admin.patch(`/admin/payment-gateways/${created.id}`, {
      name: 'Cards',
      secret: 'sk_live_new_9z9z',
    });
    expect(renamed.body).toMatchObject({ name: 'Cards', secretHint: '••••9z9z' });
    const audits = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    const patches = audits.filter(
      (row) => row.entityType === 'payment_gateway' && row.action !== 'added payment method',
    );
    expect(patches.map((row) => row.action)).toEqual(['turned off payment method', 'changed payment method']);
    expect(patches[0]!.before).toMatchObject({ isActive: true });
    expect(patches[0]!.after).toMatchObject({ isActive: false });
    expect(patches[1]!.before).toMatchObject({ name: 'Card gateway' });
    expect(patches[1]!.after).toMatchObject({ name: 'Cards' });
  });

  it("audits the switch with the demo's on and off phrases, and any other change as a change", async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const created = (await admin.post('/admin/payment-gateways', body())).body;
    const patch = (changes: Record<string, unknown>) => admin.patch(`/admin/payment-gateways/${created.id}`, changes);
    expect((await patch({ isActive: false })).status).toBe(200);
    expect((await patch({ isActive: true })).status).toBe(200);
    // Nothing moved: not a switch.
    expect((await patch({ isActive: true })).status).toBe(200);
    // The switch together with another field, or with a new secret, is a general change.
    expect((await patch({ isActive: false, name: 'Renamed' })).status).toBe(200);
    expect((await patch({ isActive: true, secret: 'sk_live_rotated_7y7y' })).status).toBe(200);
    // A fee change alone does not touch the switch.
    expect((await patch({ feePercent: '3.5' })).status).toBe(200);
    const rows = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(
      rows
        .filter((row) => row.entityType === 'payment_gateway' && row.action !== 'added payment method')
        .map((row) => row.action),
    ).toEqual([
      'turned off payment method',
      'turned on payment method',
      'changed payment method',
      'changed payment method',
      'changed payment method',
      'changed payment method',
    ]);
  });

  it('refuses a code change, an invalid merged row and an unknown group, and answers 404 for an unknown id', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const created = (await admin.post('/admin/payment-gateways', body())).body;
    const code = await admin.patch(`/admin/payment-gateways/${created.id}`, { code: 'other' });
    expect(code.status).toBe(422);
    expect(code.body.errors[0].field).toBe('code');
    expect((await admin.patch(`/admin/payment-gateways/${created.id}`, { code: 'card' })).status).toBe(200);
    const range = await admin.patch(`/admin/payment-gateways/${created.id}`, { maxAmount: '1' });
    expect(range.body.errors[0].field).toBe('maxAmount');
    const group = await admin.patch(`/admin/payment-gateways/${created.id}`, { allowedGroupIds: [4242] });
    expect(group.body.errors[0].field).toBe('allowedGroupIds');
    expect((await admin.patch('/admin/payment-gateways/99999', { isActive: false })).status).toBe(404);
  });
});

describe('DELETE /admin/payment-gateways/:id', () => {
  it('deletes an unused gateway with an audit row and refuses one that has payments', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const merchant = await insertWalletMerchant(db);
    const free = await insertGateway(t, db, { code: 'free' });
    const used = await insertGateway(t, db, { code: 'used' });
    await insertPendingPayment(db, await insertInvoiceRow(db, merchant.id), used);
    expect((await admin.delete(`/admin/payment-gateways/${free}`)).status).toBe(204);
    expect((await admin.get(`/admin/payment-gateways/${free}`)).status).toBe(404);
    const refused = await admin.delete(`/admin/payment-gateways/${used}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GATEWAY_IN_USE');
    expect((await admin.delete('/admin/payment-gateways/99999')).status).toBe(404);
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'removed payment method'));
    expect(audit!.entityLabel).toBe('Test gateway');
  });
});

describe('PaymentGateways.dropGroup', () => {
  it('takes a deleted group out of every gateway that listed it', async () => {
    const { db } = await testDb();
    const [one, two] = await db
      .insert(s.clientGroups)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning({ id: s.clientGroups.id });
    const gatewayId = await insertGateway(t, db, { allowedGroupIds: [one!.id, two!.id] });
    const untouched = await insertGateway(t, db, { allowedGroupIds: [two!.id] });
    const changed = await db.transaction((tx) => t.app.get(PaymentGateways).dropGroup(tx, one!.id));
    expect(changed).toEqual({ changed: 1, turnedOffIds: [] });
    const rows = await db.select().from(s.paymentGateways);
    expect(rows.find((row) => row.id === gatewayId)!.allowedGroupIds).toEqual([two!.id]);
    expect(rows.find((row) => row.id === untouched)!.allowedGroupIds).toEqual([two!.id]);
  });

  it('turns off a gateway only the deleted group could use, instead of opening it to every group', async () => {
    const { db } = await testDb();
    const [only, other] = await db
      .insert(s.clientGroups)
      .values([{ name: 'Only' }, { name: 'Other' }])
      .returning({ id: s.clientGroups.id });
    const restricted = await insertGateway(t, db, { allowedGroupIds: [only!.id] });
    const shared = await insertGateway(t, db, { allowedGroupIds: [only!.id, other!.id] });
    const dropped = await db.transaction((tx) => t.app.get(PaymentGateways).dropGroup(tx, only!.id));
    expect(dropped).toEqual({ changed: 2, turnedOffIds: [restricted] });
    const rows = await db.select().from(s.paymentGateways);
    expect(rows.find((row) => row.id === restricted)).toMatchObject({ allowedGroupIds: [], isActive: false });
    expect(rows.find((row) => row.id === shared)).toMatchObject({ allowedGroupIds: [other!.id], isActive: true });
  });
});
