// Integration tests of the code inventory routes (feature 4a): the masked list, the import (counts, encryption at rest, batch
// references, duplicates across services and against void codes) and the void action.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrder, insertUsd } from '../support/fixtures';
import { logSink } from '../support/log-sink';

let t: TestApp;
let admin: AdminApi;
let serviceId: number;
let otherServiceId: number;
const BULLETS = '•'.repeat(8);

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['inventory:*', 'catalog:*'], { name: 'Rami K.' });
  const { db } = await testDb();
  const category = await insertCategory(db, { type: 'server' });
  serviceId = await insertService(db, category, { name: 'UnlockTool 1-day', type: 'server' });
  otherServiceId = await insertService(db, category, { name: 'Z3X credits', type: 'server' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const codeRows = async () => (await testDb()).db.select().from(s.inventoryCodes).orderBy(s.inventoryCodes.id);
const importCodes = (id: number, body: unknown) => admin.post(`/admin/services/${id}/inventory/import`, body);

describe('POST /admin/services/:id/inventory/import', () => {
  it('counts imported, duplicates and rejected lines, and stores each code encrypted with a hash and its last four', async () => {
    logSink.clear();
    const res = await importCodes(serviceId, {
      codes: [
        '  UT-1000-A1B2  ',
        'UT-1001-C3D4',
        'UT-1000-A1B2',
        'short',
        'has space',
        'x'.repeat(129),
        '',
        'UT-1002-E5F6',
      ],
      batchRef: 'B-0002',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 3, duplicates: 1, rejected: 4, batchRef: 'B-0002' });
    const rows = await codeRows();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.codeLast4)).toEqual(['A1B2', 'C3D4', 'E5F6']);
    expect(
      rows.every((r) => r.status === 'available' && r.batchRef === 'B-0002' && r.createdBy === admin.staffId),
    ).toBe(true);

    // The clear code is nowhere in the row; the ciphertext decrypts to it with the column context.
    const encryption = t.app.get(EncryptionService);
    const hasher = t.app.get(TokenService);
    expect(JSON.stringify(rows)).not.toContain('UT-1000-A1B2');
    expect(encryption.decrypt(rows[0]!.codeEnc, 'inventory_codes.code_enc')).toBe('UT-1000-A1B2');
    expect(rows[0]!.codeHash).toBe(hasher.hash('inventory-code:UT-1000-A1B2'));
    expect(rows[0]!.codeHash).not.toBe(hasher.hash('UT-1000-A1B2'));

    // Counts only reach the audit log, and nothing logs a clear code.
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'imported inventory codes',
      entityType: 'service',
      entityId: serviceId,
      entityLabel: 'UnlockTool 1-day',
    });
    expect(audit!.after).toEqual({ imported: 3, duplicates: 1, rejected: 4, batchRef: 'B-0002' });
    expect(JSON.stringify(audit)).not.toContain('UT-1000');
    expect(JSON.stringify(logSink.lines)).not.toContain('UT-1000-A1B2');
  });

  it('generates the batch reference from the sequence when none is sent', async () => {
    const a = await importCodes(serviceId, { codes: ['AAAAAA-1'] });
    const b = await importCodes(serviceId, { codes: ['BBBBBB-1'] });
    expect(a.body.batchRef).toMatch(/^B-\d{4,}$/);
    expect(b.body.batchRef).toMatch(/^B-\d{4,}$/);
    expect(Number(b.body.batchRef.slice(2))).toBe(Number(a.body.batchRef.slice(2)) + 1);
  });

  it('finds duplicates across services and in later imports, but not against void codes', async () => {
    await importCodes(serviceId, { codes: ['SHARED-CODE-1', 'ONLY-HERE-1'] });
    const other = await importCodes(otherServiceId, { codes: ['SHARED-CODE-1', 'NEW-CODE-1'] });
    expect(other.body).toMatchObject({ imported: 1, duplicates: 1, rejected: 0 });
    const again = await importCodes(serviceId, { codes: ['ONLY-HERE-1'] });
    expect(again.body).toMatchObject({ imported: 0, duplicates: 1 });

    const [shared] = (await codeRows()).filter((r) => r.codeLast4 === 'DE-1');
    expect((await admin.post('/admin/inventory-codes/void', { ids: [shared!.id] })).body).toEqual({
      voided: 1,
      skipped: 0,
    });
    const reimport = await importCodes(otherServiceId, { codes: ['SHARED-CODE-1'] });
    expect(reimport.body).toMatchObject({ imported: 1, duplicates: 0 });
  });

  it('keeps codes case sensitive', async () => {
    const res = await importCodes(serviceId, { codes: ['AbCdEf-1', 'abcdef-1'] });
    expect(res.body).toMatchObject({ imported: 2, duplicates: 0 });
  });

  it('counts a repeat inside one batch once, even when two imports race on the same codes', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `RACE-CODE-${i}`);
    const results = await Promise.all([importCodes(serviceId, { codes }), importCodes(otherServiceId, { codes })]);
    const imported = results.reduce((sum, r) => sum + r.body.imported, 0);
    const duplicates = results.reduce((sum, r) => sum + r.body.duplicates, 0);
    expect(imported).toBe(50);
    expect(duplicates).toBe(50);
    expect((await codeRows()).length).toBe(50);
  });

  it('imports ten thousand codes in one call and refuses ten thousand and one', async () => {
    const codes = Array.from({ length: 10_000 }, (_, i) => `BULK-${String(i).padStart(6, '0')}`);
    const res = await importCodes(serviceId, { codes });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(10_000);
    const over = await importCodes(serviceId, { codes: [...codes, 'BULK-EXTRA'] });
    expect(over.status).toBe(422);
    expect(over.body.errors[0].field).toBe('codes');
    expect((await codeRows()).length).toBe(10_000);
  }, 60_000);

  it('refuses an empty list, a bad batch reference and non-text entries on the field', async () => {
    const empty = await importCodes(serviceId, { codes: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0].field).toBe('codes');
    for (const batchRef of ['has space', 'x'.repeat(41), '', 'a/b']) {
      const bad = await importCodes(serviceId, { codes: ['ABCDEF-1'], batchRef });
      expect(bad.status).toBe(422);
      expect(bad.body.errors[0].field).toBe('batchRef');
    }
    expect((await importCodes(serviceId, { codes: [123456] })).status).toBe(422);
    expect(await codeRows()).toEqual([]);
  });

  it('trims a sent batch reference', async () => {
    expect((await importCodes(serviceId, { codes: ['ABCDEF-1'], batchRef: ' B-77 ' })).body.batchRef).toBe('B-77');
  });

  it('answers 404 for an unknown or archived service and needs inventory:write', async () => {
    expect((await importCodes(999999, { codes: ['ABCDEF-1'] })).status).toBe(404);
    const { db } = await testDb();
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date() })
      .where(eq(s.services.id, otherServiceId));
    expect((await importCodes(otherServiceId, { codes: ['ABCDEF-1'] })).status).toBe(404);
    const reader = await adminWith(t, ['inventory:read']);
    expect((await reader.post(`/admin/services/${serviceId}/inventory/import`, { codes: ['ABCDEF-1'] })).status).toBe(
      403,
    );
  });
});

describe('GET /admin/inventory-codes', () => {
  it('lists masked codes newest first with the service, status and batch, never the code', async () => {
    await importCodes(serviceId, { codes: ['UT-1000-A1B2', 'UT-1001-C3D4'], batchRef: 'B-0001' });
    await importCodes(otherServiceId, { codes: ['Z3X-1000-E5F6'], batchRef: 'B-0002' });
    const res = await admin.get('/admin/inventory-codes?_start=0&_end=25&_sort=createdAt&_order=desc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body[0]).toEqual({
      id: expect.any(Number),
      maskedCode: `${BULLETS}E5F6`,
      serviceId: otherServiceId,
      service: { id: otherServiceId, name: 'Z3X credits' },
      status: 'available',
      orderId: null,
      batchRef: 'B-0002',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(res.body.map((r: { maskedCode: string }) => r.maskedCode.length)).toEqual([12, 12, 12]);
    expect(JSON.stringify(res.body)).not.toContain('UT-1000');
    expect(JSON.stringify(res.body)).not.toContain('v1:');
  });

  it('filters by service and status, searches the service name and batch, and defaults to newest first', async () => {
    await importCodes(serviceId, { codes: ['UT-1000-A1B2', 'UT-1001-C3D4'], batchRef: 'B-0001' });
    await importCodes(otherServiceId, { codes: ['Z3X-1000-E5F6'], batchRef: 'B-0002' });
    const [first] = await codeRows();
    await admin.post('/admin/inventory-codes/void', { ids: [first!.id] });
    expect((await admin.get('/admin/inventory-codes')).body.map((r: { id: number }) => r.id)).toEqual([3, 2, 1]);
    expect((await admin.get(`/admin/inventory-codes?serviceId=${serviceId}`)).total).toBe(2);
    expect((await admin.get('/admin/inventory-codes?status=void')).body.map((r: { id: number }) => r.id)).toEqual([
      first!.id,
    ]);
    expect((await admin.get('/admin/inventory-codes?status=available')).total).toBe(2);
    expect((await admin.get('/admin/inventory-codes?q=z3x')).total).toBe(1);
    expect((await admin.get('/admin/inventory-codes?q=b-0001')).total).toBe(2);
    expect((await admin.get('/admin/inventory-codes?status=lost')).status).toBe(422);
  });

  it('needs inventory:read', async () => {
    const other = await adminWith(t, ['catalog:read']);
    expect((await other.get('/admin/inventory-codes')).status).toBe(403);
  });
});

describe('POST /admin/inventory-codes/void', () => {
  it('voids available codes only and counts the rest as skipped (reserved, sold, void, unknown), idempotently', async () => {
    await importCodes(serviceId, {
      codes: ['CODE-AAAA-1', 'CODE-BBBB-2', 'CODE-CCCC-3', 'CODE-DDDD-4', 'CODE-EEEE-5'],
    });
    const { db } = await testDb();
    const [available, reserved, sold, voidAlready, spare] = await codeRows();
    await db.update(s.inventoryCodes).set({ status: 'reserved' }).where(eq(s.inventoryCodes.id, reserved!.id));
    await db.update(s.inventoryCodes).set({ status: 'sold' }).where(eq(s.inventoryCodes.id, sold!.id));
    await db.update(s.inventoryCodes).set({ status: 'void' }).where(eq(s.inventoryCodes.id, voidAlready!.id));

    const ids = [available!.id, reserved!.id, sold!.id, voidAlready!.id, 999999, available!.id];
    const res = await admin.post('/admin/inventory-codes/void', { ids });
    expect(res.status).toBe(200);
    // Five distinct ids: one available code voided, four skipped (the repeated id counts once).
    expect(res.body).toEqual({ voided: 1, skipped: 4 });
    const after = await codeRows();
    expect(after.map((r) => r.status)).toEqual(['void', 'reserved', 'sold', 'void', 'available']);
    expect(after.find((r) => r.id === spare!.id)!.status).toBe('available');

    const again = await admin.post('/admin/inventory-codes/void', { ids });
    expect(again.body).toEqual({ voided: 0, skipped: 5 });
    const audits = await auditRows();
    expect(audits.at(-1)).toMatchObject({
      action: 'voided inventory codes',
      entityType: 'inventory_code',
      entityId: 0,
    });
    expect(audits[audits.length - 2]!.after).toMatchObject({ voided: 1, skipped: 4, voidedIds: [available!.id] });
  });

  it('never voids a code that an order reserved first (the status guard is in the statement)', async () => {
    await importCodes(serviceId, { codes: ['CODE-AAAA-1'] });
    const { db } = await testDb();
    await insertUsd(db);
    const clientId = await insertMerchant(db);
    const orderId = await insertOrder(db, { clientId, serviceId });
    const [code] = await codeRows();
    await db.update(s.inventoryCodes).set({ status: 'reserved', orderId }).where(eq(s.inventoryCodes.id, code!.id));
    const res = await admin.post('/admin/inventory-codes/void', { ids: [code!.id] });
    expect(res.body).toEqual({ voided: 0, skipped: 1 });
    expect((await codeRows())[0]).toMatchObject({ status: 'reserved', orderId });
  });

  it('refuses an empty list on ids and needs inventory:write', async () => {
    const empty = await admin.post('/admin/inventory-codes/void', { ids: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0].field).toBe('ids');
    const reader = await adminWith(t, ['inventory:read']);
    expect((await reader.post('/admin/inventory-codes/void', { ids: [1] })).status).toBe(403);
  });
});
