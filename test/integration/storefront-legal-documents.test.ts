// Integration tests of the legal document routes (feature 15): list with filters and the consent count, show, create a draft
// (VERSION_EXISTS, races), and publish (the swap of the current version, ALREADY_CURRENT, NOT_A_DRAFT, parallel publishes),
// with audit rows and permissions. Rules: b2c-14, ANSWERS storefront Q5.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertCustomerRow, insertLegalRow } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['legal:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

describe('GET /admin/legal-documents', () => {
  it('lists every version with the consent count, null for a version never published', async () => {
    const { db } = await testDb();
    const earlier = await insertLegalRow(db, { version: '3.1', effectiveFrom: new Date('2026-07-25T12:00:00.000Z') });
    const current = await insertLegalRow(db, {
      version: '3.2',
      effectiveFrom: new Date('2026-11-01T12:00:00.000Z'),
      isCurrent: true,
    });
    const draft = await insertLegalRow(db, { version: '3.3', requiresReacceptance: true });
    const customer = await insertCustomerRow(db);
    await db.insert(s.consentRecords).values([
      {
        subjectType: 'customer',
        subjectId: customer,
        legalDocumentId: current.id,
        purpose: 'terms',
        granted: true,
        ip: '203.0.113.9',
      },
      {
        subjectType: 'customer',
        subjectId: customer,
        legalDocumentId: current.id,
        purpose: 'terms',
        granted: false,
        ip: '203.0.113.9',
      },
      {
        subjectType: 'customer',
        subjectId: customer,
        legalDocumentId: earlier.id,
        purpose: 'terms',
        granted: true,
        ip: '203.0.113.9',
      },
    ]);
    const res = await admin.get('/admin/legal-documents?_start=0&_end=200&_sort=type&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    const byVersion = Object.fromEntries(res.body.map((v: { version: string }) => [v.version, v]));
    expect(byVersion['3.1']).toMatchObject({
      id: earlier.id,
      type: 'terms',
      locale: 'en',
      isCurrent: false,
      acceptedCount: 1,
      effectiveFrom: '2026-07-25T12:00:00.000Z',
    });
    expect(byVersion['3.2']).toMatchObject({ id: current.id, isCurrent: true, acceptedCount: 1, bodyMd: '# Terms' });
    expect(byVersion['3.3']).toMatchObject({
      id: draft.id,
      isCurrent: false,
      effectiveFrom: null,
      acceptedCount: null,
      requiresReacceptance: true,
    });
  });

  it('filters by type, locale and isCurrent and searches type and version', async () => {
    const { db } = await testDb();
    await insertLegalRow(db, { type: 'terms', version: '3.2', isCurrent: true, effectiveFrom: new Date() });
    await insertLegalRow(db, { type: 'privacy', version: '2.1', locale: 'ar' });
    await insertLegalRow(db, { type: 'cookies', version: '1.0' });
    expect((await admin.get('/admin/legal-documents?type=privacy')).total).toBe(1);
    expect((await admin.get('/admin/legal-documents?locale=ar')).total).toBe(1);
    expect((await admin.get('/admin/legal-documents?isCurrent=true')).total).toBe(1);
    expect((await admin.get('/admin/legal-documents?q=cook')).total).toBe(1);
    expect((await admin.get('/admin/legal-documents?q=2.1')).total).toBe(1);
    expect((await admin.get('/admin/legal-documents?type=imprint')).status).toBe(422);
  });

  it('needs legal:read and is not opened by storefront permissions', async () => {
    const other = await adminWith(t, ['storefront:*']);
    expect((await other.get('/admin/legal-documents')).status).toBe(403);
  });
});

describe('GET /admin/legal-documents/:id', () => {
  it('shows one version and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const version = await insertLegalRow(db);
    expect((await admin.get(`/admin/legal-documents/${version.id}`)).body).toMatchObject({
      id: version.id,
      version: '1.0',
    });
    expect((await admin.get('/admin/legal-documents/999999')).status).toBe(404);
  });
});

describe('POST /admin/legal-documents', () => {
  it('creates a draft by the signed-in staff member and audits it with the demo label', async () => {
    const { db } = await testDb();
    const res = await admin.post('/admin/legal-documents', {
      type: 'terms',
      locale: 'en',
      version: '3.3',
      bodyMd: '# Terms of service\n\n  kept as typed',
      requiresReacceptance: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'terms',
      locale: 'en',
      version: '3.3',
      bodyMd: '# Terms of service\n\n  kept as typed',
      effectiveFrom: null,
      isCurrent: false,
      requiresReacceptance: false,
      acceptedCount: null,
    });
    const [row] = await db.select().from(s.legalDocuments);
    expect(row?.createdBy).toBe(admin.staffId);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created legal document',
      entityType: 'legal',
      entityId: res.body.id,
      entityLabel: 'Terms of service (EN) 3.3',
    });
  });

  it('defaults requiresReacceptance to true', async () => {
    const res = await admin.post('/admin/legal-documents', {
      type: 'privacy',
      locale: 'ar',
      version: '1',
      bodyMd: 'x',
    });
    expect(res.body.requiresReacceptance).toBe(true);
  });

  it('answers 409 VERSION_EXISTS on version for the same type, language and version, but not for another language or type', async () => {
    const { db } = await testDb();
    await insertLegalRow(db, { type: 'terms', locale: 'en', version: '3.2' });
    const taken = await admin.post('/admin/legal-documents', {
      type: 'terms',
      locale: 'en',
      version: '3.2',
      bodyMd: 'x',
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({
      code: 'VERSION_EXISTS',
      errors: [expect.objectContaining({ field: 'version' })],
    });
    expect(
      (await admin.post('/admin/legal-documents', { type: 'terms', locale: 'ar', version: '3.2', bodyMd: 'x' })).status,
    ).toBe(201);
    expect(
      (await admin.post('/admin/legal-documents', { type: 'privacy', locale: 'en', version: '3.2', bodyMd: 'x' }))
        .status,
    ).toBe(201);
  });

  it('maps a race on the same version to 409, never 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        admin.post('/admin/legal-documents', { type: 'refund', locale: 'en', version: '1.5', bodyMd: 'x' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('refuses an unknown type, a bad language, a blank version or body and a version with spaces on the field', async () => {
    const res = await admin.post('/admin/legal-documents', {
      type: 'imprint',
      locale: 'de',
      version: ' ',
      bodyMd: '  ',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'bodyMd',
      'locale',
      'type',
      'version',
    ]);
    const spaced = await admin.post('/admin/legal-documents', {
      type: 'terms',
      locale: 'en',
      version: '3 2',
      bodyMd: 'x',
    });
    expect(spaced.body.errors[0].field).toBe('version');
  });

  it('needs legal:create', async () => {
    const reader = await adminWith(t, ['legal:read', 'legal:publish']);
    expect(
      (await reader.post('/admin/legal-documents', { type: 'terms', locale: 'en', version: '9', bodyMd: 'x' })).status,
    ).toBe(403);
  });
});

describe('POST /admin/legal-documents/:id/publish', () => {
  it('makes the draft current at the clock time, retires the old current keeping its effective date, and audits the swap', async () => {
    const { db } = await testDb();
    const old = await insertLegalRow(db, {
      version: '3.2',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });
    const draft = await insertLegalRow(db, { version: '3.3' });
    const otherLocale = await insertLegalRow(db, {
      version: '3.2',
      locale: 'ar',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });
    const otherType = await insertLegalRow(db, {
      type: 'privacy',
      version: '2.0',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });

    const res = await admin.post(`/admin/legal-documents/${draft.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: draft.id,
      version: '3.3',
      isCurrent: true,
      effectiveFrom: '2026-11-07T12:00:00.000Z',
      acceptedCount: 0,
    });

    const [oldRow] = await db.select().from(s.legalDocuments).where(eq(s.legalDocuments.id, old.id));
    expect(oldRow).toMatchObject({ isCurrent: false });
    expect(oldRow?.effectiveFrom?.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    // Another language and another document keep their own current version.
    for (const id of [otherLocale.id, otherType.id]) {
      const [row] = await db.select().from(s.legalDocuments).where(eq(s.legalDocuments.id, id));
      expect(row?.isCurrent).toBe(true);
    }
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'published legal document',
      entityType: 'legal',
      entityId: draft.id,
      entityLabel: 'Terms of service (EN) 3.3',
    });
    expect(audit?.before).toEqual({ version: '3.2' });
    expect(audit?.after).toEqual({ version: '3.3', effectiveFrom: '2026-11-07T12:00:00.000Z' });
    expect(
      (await db.select().from(s.legalDocuments).where(eq(s.legalDocuments.isCurrent, true)))
        .map((row) => row.id)
        .sort(),
    ).toEqual([draft.id, otherLocale.id, otherType.id].sort((a, b) => a - b));
  });

  it('publishes a first version when nothing is in force', async () => {
    const { db } = await testDb();
    const draft = await insertLegalRow(db, { type: 'cookies', version: '1.0' });
    const res = await admin.post(`/admin/legal-documents/${draft.id}/publish`);
    expect(res.body).toMatchObject({ isCurrent: true });
    expect((await auditRows())[0]?.before).toEqual({ version: null });
  });

  it('answers 409 ALREADY_CURRENT for the version in force and 409 NOT_A_DRAFT for a replaced one', async () => {
    const { db } = await testDb();
    const replaced = await insertLegalRow(db, { version: '3.1', effectiveFrom: new Date('2026-07-25T12:00:00.000Z') });
    const current = await insertLegalRow(db, {
      version: '3.2',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });
    const already = await admin.post(`/admin/legal-documents/${current.id}/publish`);
    expect(already.status).toBe(409);
    expect(already.body).toMatchObject({ code: 'ALREADY_CURRENT', detail: 'Version 3.2 is already in force.' });
    const notDraft = await admin.post(`/admin/legal-documents/${replaced.id}/publish`);
    expect(notDraft.status).toBe(409);
    expect(notDraft.body.code).toBe('NOT_A_DRAFT');
    expect(await auditRows()).toEqual([]);
  });

  it('lets two drafts of one document be published at once: exactly one ends current, none fails with 500', async () => {
    const { db } = await testDb();
    const a = await insertLegalRow(db, { version: '4.0' });
    const b = await insertLegalRow(db, { version: '4.1' });
    const c = await insertLegalRow(db, { version: '4.2' });
    const results = await Promise.all([a, b, c].map((v) => admin.post(`/admin/legal-documents/${v.id}/publish`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const rows = await db.select().from(s.legalDocuments);
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(rows.every((row) => row.effectiveFrom !== null)).toBe(true);
  });

  it('answers 404 for an unknown version and needs legal:publish', async () => {
    const { db } = await testDb();
    const draft = await insertLegalRow(db);
    expect((await admin.post('/admin/legal-documents/999999/publish')).status).toBe(404);
    const editor = await adminWith(t, ['legal:read', 'legal:create']);
    expect((await editor.post(`/admin/legal-documents/${draft.id}/publish`)).status).toBe(403);
  });
});
