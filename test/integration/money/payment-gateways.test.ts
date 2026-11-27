// Integration tests of the payment gateway routes (map stage 8): list, read, add, change and delete with the secret hint, the
// webhook key, the validation field errors, the immutable code, the delete guard, the audit rows and the public group cleanup.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { EncryptionService } from '@src/infra/crypto';
import { PaymentGateways } from '@src/modules/money';
import { GATEWAY_CONFIG_AAD, GATEWAY_WEBHOOK_SECRET_AAD } from '@src/modules/money/application/gateway-credentials';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';

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
    const admin = await adminWith(t, ['*']);
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
    // Since 24C the column holds a list of one or two keys (a legacy plain key is still read).
    expect(JSON.parse(encryption.decrypt(row!.webhookSecretEnc!, GATEWAY_WEBHOOK_SECRET_AAD))).toEqual([
      'whsec_card_key',
    ]);
    expect(res.body).toMatchObject({ webhookSecretHint: '••••_key', secondaryWebhookSecretHint: null });
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'added payment method',
      entityType: 'payment_gateway',
      entityLabel: 'Card gateway',
    });
    expect(JSON.stringify(audit!.after)).not.toContain('sk_live');
  });

  it('refuses each bad field with its name and a code that another gateway uses', async () => {
    const admin = await adminWith(t, ['*']);
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

describe('POST /admin/payment-gateways without a code (decision 077)', () => {
  /** A manual custom method without a code and without a secret: the staff member needs only payments:gateways. */
  const manual = (overrides: Record<string, unknown> = {}) =>
    body({
      code: undefined,
      driver: 'cliq',
      name: 'Bank of Jordan',
      isManual: true,
      secret: undefined,
      ...overrides,
    });
  const gatewayRows = async () => (await testDb()).db.select().from(s.paymentGateways).orderBy(s.paymentGateways.id);
  const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

  it('makes the code from the name of a custom method: the stored row, the answer and the audit row carry it', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const res = await admin.post('/admin/payment-gateways', manual());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'bank_of_jordan', name: 'Bank of Jordan', preset: null });
    const [row] = await gatewayRows();
    expect(row).toMatchObject({ id: res.body.id, code: 'bank_of_jordan', preset: null });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'added payment method',
      entityType: 'payment_gateway',
      entityId: res.body.id,
      entityLabel: 'Bank of Jordan',
      actorId: admin.staffId,
    });
    expect(audit!.after).toMatchObject({ code: 'bank_of_jordan', name: 'Bank of Jordan' });
    expect((await admin.get(`/admin/payment-gateways/${res.body.id}`)).body.code).toBe('bank_of_jordan');
  });

  it('keeps the made code for good: a change that names another code is refused, the same code is accepted', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const created = await admin.post('/admin/payment-gateways', manual());
    const other = await admin.patch(`/admin/payment-gateways/${created.body.id}`, { code: 'renamed' });
    expect(other.status).toBe(422);
    expect(other.body.errors[0]).toMatchObject({ field: 'code', code: 'immutable' });
    const same = await admin.patch(`/admin/payment-gateways/${created.body.id}`, {
      code: 'bank_of_jordan',
      isActive: false,
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ code: 'bank_of_jordan', isActive: false });
  });

  it('takes _2, _3 when a method already holds the code, a typed one included, and never answers 422 for it', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    expect((await admin.post('/admin/payment-gateways', manual({ code: 'bank_of_jordan' }))).body.code).toBe(
      'bank_of_jordan',
    );
    const second = await admin.post('/admin/payment-gateways', manual());
    const third = await admin.post('/admin/payment-gateways', manual());
    expect([second.status, second.body.code]).toEqual([201, 'bank_of_jordan_2']);
    expect([third.status, third.body.code]).toEqual([201, 'bank_of_jordan_3']);
    // A typed code that is taken is still refused as before.
    const typed = await admin.post('/admin/payment-gateways', manual({ code: 'bank_of_jordan_2' }));
    expect(typed.status).toBe(422);
    expect(typed.body.errors[0]).toMatchObject({ field: 'code', code: 'taken' });
    expect((await gatewayRows()).map((row) => row.code)).toEqual([
      'bank_of_jordan',
      'bank_of_jordan_2',
      'bank_of_jordan_3',
    ]);
    const audits = await auditRows();
    expect(audits.map((row) => (row.after as { code: string }).code)).toEqual([
      'bank_of_jordan',
      'bank_of_jordan_2',
      'bank_of_jordan_3',
    ]);
  });

  it('keeps a typed code exactly as before, whatever the name would make', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const typed = await admin.post('/admin/payment-gateways', manual({ code: 'my-code_1' }));
    expect([typed.status, typed.body.code]).toEqual([201, 'my-code_1']);
    const bad = await admin.post('/admin/payment-gateways', manual({ code: 'Bad Code' }));
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toMatchObject([{ field: 'code', code: 'format' }]);
    // A blank code is a typed code that is empty: still 422 on code, not a request to make one.
    const blank = await admin.post('/admin/payment-gateways', manual({ code: '   ' }));
    expect(blank.status).toBe(422);
    expect(blank.body.errors).toMatchObject([{ field: 'code', code: 'required' }]);
    expect(await gatewayRows()).toHaveLength(1);
  });

  it('judges every other field as before, and reports no problem on code for a request without one', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const res = await admin.post('/admin/payment-gateways', manual({ name: ' ', feePercent: '120' }));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(['feePercent', 'name']);
    expect(await gatewayRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('makes method for a name with no letter or digit a-z in it, and a digit-first name stays a valid code', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const arabic = await admin.post(
      '/admin/payment-gateways',
      manual({ name: '\u0628\u0646\u0643 \u0627\u0644\u0623\u0631\u062f\u0646' }),
    );
    const again = await admin.post('/admin/payment-gateways', manual({ name: '\u0628\u0646\u0643' }));
    const digits = await admin.post('/admin/payment-gateways', manual({ name: '7 Eleven pay' }));
    expect([arabic.body.code, again.body.code, digits.body.code]).toEqual(['method', 'method_2', '7_eleven_pay']);
    expect(arabic.body.name).toBe('\u0628\u0646\u0643 \u0627\u0644\u0623\u0631\u062f\u0646');
  });

  it('cuts a long name to 40 characters and still fits the suffix of the next one', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const name = `${'x'.repeat(30)} ${'y'.repeat(30)}`;
    const first = await admin.post('/admin/payment-gateways', manual({ name }));
    const second = await admin.post('/admin/payment-gateways', manual({ name }));
    expect(first.body.code).toBe(`${'x'.repeat(30)}_${'y'.repeat(9)}`);
    expect(first.body.code).toHaveLength(40);
    expect(second.body.code).toBe(`${'x'.repeat(30)}_${'y'.repeat(7)}_2`);
    expect(second.body.code).toHaveLength(40);
  });

  it('makes the key of the preset for a ready-made method, and _2 for the second one made from it', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const vodafone = (name: string) =>
      manual({ driver: 'vodafone_cash', name, preset: 'vodafone_cash', instructions: 'Send it to 01000000000.' });
    const first = await admin.post('/admin/payment-gateways', vodafone('Vodafone Cash'));
    const second = await admin.post('/admin/payment-gateways', vodafone('Vodafone Cash (second line)'));
    expect([first.status, first.body.code, first.body.preset]).toEqual([201, 'vodafone_cash', 'vodafone_cash']);
    expect([second.status, second.body.code, second.body.preset]).toEqual([201, 'vodafone_cash_2', 'vodafone_cash']);
    expect((await gatewayRows()).map((row) => [row.code, row.preset])).toEqual([
      ['vodafone_cash', 'vodafone_cash'],
      ['vodafone_cash_2', 'vodafone_cash'],
    ]);
    expect((await auditRows()).map((row) => (row.after as { code: string }).code)).toEqual([
      'vodafone_cash',
      'vodafone_cash_2',
    ]);
    // A custom method with the same words as the preset's key meets the preset-made code and takes the next number.
    const custom = await admin.post('/admin/payment-gateways', manual({ driver: 'cash', name: 'Vodafone cash' }));
    expect(custom.body.code).toBe('vodafone_cash_3');
    // A typed code beats the preset's key.
    const typed = await admin.post('/admin/payment-gateways', vodafone('Vodafone Cash third'));
    expect(typed.body.code).toBe('vodafone_cash_4');
    const named = await admin.post('/admin/payment-gateways', {
      ...vodafone('Vodafone Cash fourth'),
      code: 'vf-office',
    });
    expect(named.body.code).toBe('vf-office');
  });

  it('keeps the preset refusals: an unknown preset is 422 on preset and nothing is written', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const res = await admin.post('/admin/payment-gateways', manual({ preset: 'not_a_preset' }));
    expect(res.status).toBe(422);
    expect(res.body.errors).toMatchObject([{ field: 'preset', code: 'unknown' }]);
    expect(await gatewayRows()).toHaveLength(0);
  });

  it('gives six creates of one name at the same moment six different codes, each with its audit row', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => admin.post('/admin/payment-gateways', manual({ name: 'Cash pickup' }))),
    );
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const codes = answers.map((answer) => answer.body.code as string).sort();
    expect(codes).toEqual([
      'cash_pickup',
      'cash_pickup_2',
      'cash_pickup_3',
      'cash_pickup_4',
      'cash_pickup_5',
      'cash_pickup_6',
    ]);
    expect((await gatewayRows()).map((row) => row.code).sort()).toEqual(codes);
    expect((await auditRows()).map((row) => (row.after as { code: string }).code).sort()).toEqual(codes);
  });

  it('gives a made code and a typed one that meet at the same moment their own rows: only the typed one can be refused', async () => {
    const admin = await adminWith(t, ['payments:gateways']);
    const answers = await Promise.all([
      admin.post('/admin/payment-gateways', manual({ code: 'cash_pickup' })),
      admin.post('/admin/payment-gateways', manual({ name: 'Cash pickup' })),
    ]);
    const made = answers[1];
    expect(made.status).toBe(201);
    if (answers[0].status === 201) expect(made.body.code).toBe('cash_pickup_2');
    else {
      expect(answers[0].status).toBe(422);
      expect(made.body.code).toBe('cash_pickup');
    }
    expect(await gatewayRows()).toHaveLength(2 - (answers[0].status === 201 ? 0 : 1));
  });

  it('refuses a caller without payments:gateways before it makes anything', async () => {
    const reader = await adminWith(t, ['payments:read']);
    expect((await reader.post('/admin/payment-gateways', manual())).status).toBe(403);
    expect(await gatewayRows()).toHaveLength(0);
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
    const admin = await adminWith(t, ['*']);
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
    const admin = await adminWith(t, ['*']);
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
    const admin = await adminWith(t, ['*']);
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
    const admin = await adminWith(t, ['*']);
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

describe('owner-only secrets (decision 046)', () => {
  const OWNER_DETAIL = 'Only an owner can set up an automatic payment method or change its secrets.';

  it('refuses a staff member who is not an Owner adding an automatic method or sending a secret, and stores nothing', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    for (const automatic of [body(), body({ isManual: false, secret: undefined })]) {
      const refused = await admin.post('/admin/payment-gateways', automatic);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.detail).toBe(OWNER_DETAIL);
    }
    const manual = { code: 'bank', driver: 'bank', isManual: true, secret: undefined };
    expect((await admin.post('/admin/payment-gateways', body(manual))).status).toBe(201);
    const withSecret = await admin.post(
      '/admin/payment-gateways',
      body({ ...manual, code: 'bank2', secret: 'sk_manual_1234' }),
    );
    expect(withSecret.status).toBe(403);
    expect((await db.select().from(s.paymentGateways)).map((row) => row.code)).toEqual(['bank']);
    expect(await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'payment_gateway'))).toHaveLength(1);

    // The field checks answer first, for everyone.
    expect((await admin.post('/admin/payment-gateways', body({ name: ' ' }))).status).toBe(422);
  });

  it('refuses a non-Owner changing a secret, turning a manual method automatic or changing the driver of an automatic one; other changes pass', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const card = await insertGateway(t, db, { code: 'card', secret: 'sk_abcd1234' });
    const bank = await insertGateway(t, db, { code: 'bank', driver: 'bank', isManual: true });
    const storedConfig = async (id: number) =>
      (await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, id)))[0]!;
    const before = await storedConfig(card);

    for (const change of [{ secret: 'sk_new_1111' }, { webhookSecret: 'whsec_x' }, { driver: 'stripe' }]) {
      const refused = await admin.patch(`/admin/payment-gateways/${card}`, change);
      expect(refused.status).toBe(403);
      expect(refused.body.detail).toBe(OWNER_DETAIL);
    }
    const after = await storedConfig(card);
    expect(after.configEnc).toBe(before.configEnc);
    expect(after.webhookSecretEnc).toBe(before.webhookSecretEnc);
    expect(after.driver).toBe(before.driver);

    expect((await admin.patch(`/admin/payment-gateways/${card}`, { isActive: false })).status).toBe(200);
    expect((await admin.patch(`/admin/payment-gateways/${card}`, { feePercent: '3' })).status).toBe(200);
    const kind = await admin.patch(`/admin/payment-gateways/${bank}`, { isManual: false });
    expect(kind.status).toBe(403);
    expect((await storedConfig(bank)).isManual).toBe(true);
    // A manual method may change its driver while it stays manual.
    expect((await admin.patch(`/admin/payment-gateways/${bank}`, { driver: 'cliq' })).status).toBe(200);

    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/payment-gateways/${card}`, { secret: 'sk_new_1111' })).status).toBe(200);
    expect((await owner.patch(`/admin/payment-gateways/${card}`, { driver: 'stripe' })).status).toBe(200);
  });

  it('refuses a non-Owner turning an automatic method manual, writes nothing, and keeps the plain fields open', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const card = await insertGateway(t, db, { code: 'card', secret: 'sk_abcd1234' });
    const storedRow = async () => (await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, card)))[0]!;
    const before = await storedRow();

    const refused = await admin.patch(`/admin/payment-gateways/${card}`, { isManual: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toBe(OWNER_DETAIL);
    // The kind and the driver together are refused too.
    expect((await admin.patch(`/admin/payment-gateways/${card}`, { isManual: true, driver: 'bank' })).status).toBe(403);
    expect(await storedRow()).toEqual(before);
    expect(await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'payment_gateway'))).toHaveLength(0);

    // The plain fields of an automatic method stay under the route's own permission.
    const plain = await admin.patch(`/admin/payment-gateways/${card}`, {
      name: 'Cards',
      feePercent: '3',
      isActive: false,
    });
    expect(plain.status).toBe(200);
    expect(await storedRow()).toMatchObject({ name: 'Cards', isManual: false, driver: 'card' });

    const owner = await adminWith(t, ['*']);
    const turned = await owner.patch(`/admin/payment-gateways/${card}`, { isManual: true });
    expect(turned.status).toBe(200);
    expect(turned.body.isManual).toBe(true);
    expect((await storedRow()).isManual).toBe(true);
  });

  it('does not count removing a second webhook secret that the method does not have as a change of secrets', async () => {
    const { db } = await testDb();
    const admin = await adminWith(t, ['payments:gateways']);
    const owner = await adminWith(t, ['*']);
    const card = await insertGateway(t, db, { code: 'card' });
    const bank = await insertGateway(t, db, { code: 'bank', driver: 'bank', isManual: true });
    const storedRow = async (id: number) =>
      (await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, id)))[0]!;
    const before = await storedRow(card);

    // No second secret: nothing to remove, so a non-Owner may send the null.
    const none = await admin.patch(`/admin/payment-gateways/${card}`, { secondaryWebhookSecret: null, name: 'Cards' });
    expect(none.status).toBe(200);
    expect(none.body.secondaryWebhookSecretHint).toBeNull();
    expect((await storedRow(card)).webhookSecretEnc).toBe(before.webhookSecretEnc);
    expect((await admin.patch(`/admin/payment-gateways/${bank}`, { secondaryWebhookSecret: null })).status).toBe(200);

    // A stored second secret: only an Owner removes it.
    const added = await owner.patch(`/admin/payment-gateways/${card}`, { secondaryWebhookSecret: 'whsec_second_2222' });
    expect(added.status).toBe(200);
    expect(added.body.secondaryWebhookSecretHint).toBe('••••2222');
    const withSecond = await storedRow(card);
    const refused = await admin.patch(`/admin/payment-gateways/${card}`, { secondaryWebhookSecret: null });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe(OWNER_DETAIL);
    expect((await storedRow(card)).webhookSecretEnc).toBe(withSecond.webhookSecretEnc);
    expect(
      (await owner.patch(`/admin/payment-gateways/${card}`, { secondaryWebhookSecret: null })).body
        .secondaryWebhookSecretHint,
    ).toBeNull();
  });
});
