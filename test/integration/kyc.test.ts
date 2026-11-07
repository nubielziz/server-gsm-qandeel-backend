// Integration tests of the identity verification (KYC) routes (map stage 8, MISMATCHES B161): a merchant waiting for approval
// submits its own uploaded documents, staff list and decide the requests, and the merchant's `kyc_status` follows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { insertProofFile } from '../support/billing';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type PortalClient, portalFor } from '../support/webhooks';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
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

async function merchant(
  overrides: Partial<typeof s.clients.$inferInsert> = {},
): Promise<{ id: number; portal: PortalClient }> {
  const id = await insertMerchant(db, {
    status: 'pending',
    name: 'Gulf Digital',
    email: 'ops@gulf.example',
    country: 'AE',
    ...overrides,
  });
  return { id, portal: await portalFor(t, id) };
}
const kycOf = async (id: number) => (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0]!.kycStatus;

describe('GET /client/kyc and POST /client/kyc', () => {
  it('shows none for a merchant that never submitted, even while it waits for approval', async () => {
    const { portal } = await merchant();
    const res = await portal.call('GET', '/client/kyc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'none', submission: null });
  });

  it('submits documents the merchant uploaded and sets its status to pending', async () => {
    const { id, portal } = await merchant();
    const passport = await insertProofFile(db, id, { filename: 'passport.jpg', mime: 'image/jpeg', size: 482000 });
    const licence = await insertProofFile(db, id, { filename: 'licence.pdf', mime: 'application/pdf', size: 1240000 });
    const res = await portal.call('POST', '/client/kyc', {
      fileIds: [passport, licence],
      note: ' Trade licence attached ',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.submission).toMatchObject({
      status: 'pending',
      note: null,
      documents: [
        { fileId: passport, filename: 'passport.jpg', mime: 'image/jpeg', size: 482000 },
        { fileId: licence, filename: 'licence.pdf', mime: 'application/pdf', size: 1240000 },
      ],
      submittedAt: '2026-11-01T10:00:00.000Z',
      reviewedAt: null,
    });
    expect(await kycOf(id)).toBe('pending');
    const [row] = await db.select().from(s.kycSubmissions);
    expect(row).toMatchObject({
      clientId: id,
      status: 'pending',
      fileIds: [passport, licence],
      submittedNote: 'Trade licence attached',
    });
    // A portal write writes no audit row (B121).
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    expect((await portal.call('GET', '/client/kyc')).body.submission.id).toBe(row!.id);
  });

  it('refuses a second submit while one is under review, one after approval, and an unusable list of files', async () => {
    const { id, portal } = await merchant();
    const file = await insertProofFile(db, id);
    for (const fileIds of [[], [file, file], Array.from({ length: 6 }, (_, i) => file + i)]) {
      const res = await portal.call('POST', '/client/kyc', { fileIds });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('fileIds');
    }
    const other = await merchant({ email: 'other@example.com', name: 'Other' });
    const foreign = await insertProofFile(db, other.id);
    const html = await insertProofFile(db, id, { mime: 'text/html', filename: 'x.html' });
    const bad = await portal.call('POST', '/client/kyc', { fileIds: [file, 99999, foreign, html] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((error: { field: string }) => error.field)).toEqual([
      'fileIds.1',
      'fileIds.2',
      'fileIds.3',
    ]);
    expect(
      (await portal.call('POST', '/client/kyc', { fileIds: [file], note: 'x'.repeat(501) })).body.errors[0].field,
    ).toBe('note');
    expect(await db.select().from(s.kycSubmissions)).toHaveLength(0);

    expect((await portal.call('POST', '/client/kyc', { fileIds: [file] })).status).toBe(201);
    const again = await portal.call('POST', '/client/kyc', { fileIds: [file] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT', detail: 'Your documents are already under review.' });
    await db.update(s.clients).set({ kycStatus: 'approved' }).where(eq(s.clients.id, id));
    const done = await portal.call('POST', '/client/kyc', { fileIds: [file] });
    expect(done.status).toBe(409);
    expect(done.body).toMatchObject({ code: 'ALREADY_DECIDED', detail: 'Your identity is already verified.' });
  });

  it('keeps one request under review when two submits race', async () => {
    const { id, portal } = await merchant();
    const file = await insertProofFile(db, id);
    const results = await Promise.all([1, 2, 3].map(() => portal.call('POST', '/client/kyc', { fileIds: [file] })));
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(2);
    expect(await db.select().from(s.kycSubmissions)).toHaveLength(1);
  });

  it('lets a rejected merchant see the staff reason and submit again', async () => {
    const { id, portal } = await merchant();
    const file = await insertProofFile(db, id);
    await portal.call('POST', '/client/kyc', { fileIds: [file] });
    const admin = await adminWith(t, ['kyc:read', 'kyc:decide']);
    const [submission] = await db.select().from(s.kycSubmissions);
    clock.advance(5 * MINUTE);
    await admin.post(`/admin/kyc-submissions/${submission!.id}/decide`, {
      decision: 'reject',
      note: 'The passport photo is unreadable.',
    });
    const view = (await portal.call('GET', '/client/kyc')).body;
    expect(view.status).toBe('rejected');
    expect(view.submission).toMatchObject({
      status: 'rejected',
      note: 'The passport photo is unreadable.',
      reviewedAt: '2026-11-01T10:05:00.000Z',
    });
    clock.advance(MINUTE);
    const second = await portal.call('POST', '/client/kyc', { fileIds: [file] });
    expect(second.status).toBe(201);
    expect(second.body.submission.id).not.toBe(submission!.id);
    expect(await kycOf(id)).toBe('pending');
  });
});

describe('GET /admin/kyc-submissions', () => {
  it('lists requests newest first with the merchant, the documents and the reviewer, filtered by status', async () => {
    const one = await merchant({ name: 'One', email: 'one@example.com' });
    const two = await merchant({ name: 'Two', email: 'two@example.com' });
    const admin = await adminWith(t, ['kyc:read', 'kyc:decide'], { name: 'Rami K.' });
    const file = await insertProofFile(db, one.id, { filename: 'a.pdf', size: 10 });
    await one.portal.call('POST', '/client/kyc', { fileIds: [file] });
    clock.advance(MINUTE);
    await two.portal.call('POST', '/client/kyc', { fileIds: [await insertProofFile(db, two.id)] });
    const [first] = await db.select().from(s.kycSubmissions).where(eq(s.kycSubmissions.clientId, one.id));
    clock.advance(MINUTE);
    await admin.post(`/admin/kyc-submissions/${first!.id}/decide`, { decision: 'approve' });

    const res = await admin.get('/admin/kyc-submissions?_start=0&_end=25&_sort=createdAt&_order=desc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((row: { client: { name: string } }) => row.client.name)).toEqual(['Two', 'One']);
    expect(res.body[1]).toMatchObject({
      id: first!.id,
      clientId: one.id,
      status: 'approved',
      fileIds: [file],
      files: [{ id: file, filename: 'a.pdf', mime: 'application/pdf', size: 10 }],
      client: { id: one.id, name: 'One', email: 'one@example.com', country: 'AE', status: 'pending' },
      reviewedBy: { id: admin.staffId, name: 'Rami K.' },
    });
    expect(res.body[0]).toMatchObject({ status: 'pending', reviewedBy: null, reviewedAt: null, note: '' });
    expect((await admin.get('/admin/kyc-submissions?status=pending')).total).toBe(1);
    expect((await admin.get(`/admin/kyc-submissions?clientId=${one.id}`)).total).toBe(1);
    expect((await admin.get(`/admin/kyc-submissions/${first!.id}`)).body.id).toBe(first!.id);
    expect((await admin.get('/admin/kyc-submissions/99999')).status).toBe(404);
  });

  it('refuses a caller without kyc:read', async () => {
    const other = await adminWith(t, ['payments:read']);
    expect((await other.get('/admin/kyc-submissions')).status).toBe(403);
  });
});

describe('POST /admin/kyc-submissions/:id/decide', () => {
  async function pending() {
    const { id, portal } = await merchant();
    await portal.call('POST', '/client/kyc', { fileIds: [await insertProofFile(db, id)] });
    const [submission] = await db.select().from(s.kycSubmissions);
    return { id, submission: submission! };
  }

  it('approves: sets the request and the merchant verification, leaves the account status, audits', async () => {
    const { id, submission } = await pending();
    const admin = await adminWith(t, ['kyc:decide'], { name: 'Rami K.' });
    clock.advance(MINUTE);
    const res = await admin.post(`/admin/kyc-submissions/${submission.id}/decide`, {
      decision: 'approve',
      note: ' Documents match. ',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      note: 'Documents match.',
      reviewedAt: '2026-11-01T10:01:00.000Z',
      reviewedBy: { name: 'Rami K.' },
    });
    expect(await kycOf(id)).toBe('approved');
    expect((await db.select().from(s.clients).where(eq(s.clients.id, id)))[0]!.status).toBe('pending');
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'approved verification of',
      entityType: 'kyc_submission',
      entityId: submission.id,
      entityLabel: 'Gulf Digital',
    });
  });

  it('rejects with a reason, refuses a rejection without one and a request that was decided', async () => {
    const { id, submission } = await pending();
    const admin = await adminWith(t, ['kyc:decide']);
    for (const note of [undefined, '   ', 'x'.repeat(301)]) {
      const res = await admin.post(`/admin/kyc-submissions/${submission.id}/decide`, {
        decision: 'reject',
        ...(note === undefined ? {} : { note }),
      });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('note');
    }
    expect((await admin.post(`/admin/kyc-submissions/${submission.id}/decide`, { decision: 'maybe' })).status).toBe(
      422,
    );
    expect(await kycOf(id)).toBe('pending');
    expect(
      (await admin.post(`/admin/kyc-submissions/${submission.id}/decide`, { decision: 'reject', note: 'Blurry' }))
        .status,
    ).toBe(200);
    expect(await kycOf(id)).toBe('rejected');
    const again = await admin.post(`/admin/kyc-submissions/${submission.id}/decide`, { decision: 'approve' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_DECIDED', detail: 'This request was already rejected.' });
    expect((await admin.post('/admin/kyc-submissions/99999/decide', { decision: 'approve' })).status).toBe(404);
  });

  it('refuses a caller who may only read, and decides once when two decisions race', async () => {
    const { submission } = await pending();
    const reader = await adminWith(t, ['kyc:read']);
    expect((await reader.post(`/admin/kyc-submissions/${submission.id}/decide`, { decision: 'approve' })).status).toBe(
      403,
    );
    const admin = await adminWith(t, ['kyc:decide']);
    const results = await Promise.all(
      ['approve', 'reject', 'approve'].map((decision) =>
        admin.post(`/admin/kyc-submissions/${submission.id}/decide`, { decision, note: 'Because' }),
      ),
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409).every((res) => res.body.code === 'ALREADY_DECIDED')).toBe(true);
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
  });
});
