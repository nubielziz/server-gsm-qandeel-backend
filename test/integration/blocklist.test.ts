// Integration tests of the blocklist routes (feature 18, /admin/blocklist, scenarios b2c-chargeback and b2c-account): the list with its
// filter, sort and search, adding each kind (normalised, hashed, displayed), the duplicate and validation refusals, removing an entry
// of any source, the audit rows and the permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { TokenService } from '../../src/infra/crypto';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { auditRows, blocklistRows, insertBlock } from '../support/risk';
import { makeCustomer } from '../support/store';

let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['risk:read', 'risk:create', 'risk:delete'], { name: 'Lina S.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('POST /admin/blocklist', () => {
  it('adds an email normalised and masked, stores only its hash, and audits it', async () => {
    const { db } = await testDb();
    const res = await staff.post('/admin/blocklist', {
      kind: 'email',
      value: '  Jack.Turner@TempBox.Example ',
      reason: 'Chargeback lost',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'email',
      display: 'ja****@tempbox.example',
      reason: 'Chargeback lost',
      source: 'manual',
      expiresAt: null,
      createdBy: { id: staff.staffId, name: 'Lina S.' },
    });
    expect(res.body.valueHash).toBeUndefined();
    const [row] = await blocklistRows(db);
    expect(row!.valueHash).toBe(t.app.get(TokenService).hash('jack.turner@tempbox.example'));
    expect(JSON.stringify(row)).not.toContain('Jack.Turner');
    expect(await auditRows(db, 'blocklist', res.body.id)).toMatchObject([
      {
        action: 'added to blocklist',
        entityLabel: 'email ja****@tempbox.example',
        after: { reason: 'Chargeback lost' },
      },
    ]);
  });

  it('adds a domain, an IMEI typed with spaces (shown grouped) and a card fingerprint', async () => {
    const domain = await staff.post('/admin/blocklist', {
      kind: 'domain',
      value: '@Mailinator.com',
      reason: 'Disposable',
    });
    expect(domain.body).toMatchObject({ kind: 'domain', display: 'mailinator.com' });
    const imei = await staff.post('/admin/blocklist', { kind: 'imei', value: '35 389011 884201 9', reason: 'Stolen' });
    expect(imei.body).toMatchObject({ kind: 'imei', display: '35 389011 884201 9' });
    const card = await staff.post('/admin/blocklist', {
      kind: 'card',
      value: 'fp_9f2c1a77b3d4e5',
      reason: 'Chargeback',
    });
    expect(card.body).toMatchObject({ kind: 'card', display: 'Card fingerprint fp_9f2…4e5' });
  });

  it('keeps no readable IMEI in the audit rows of adding and removing an IMEI entry: the TAC and a mask', async () => {
    const { db } = await testDb();
    const added = await staff.post('/admin/blocklist', { kind: 'imei', value: '35 389011 884201 9', reason: 'Stolen' });
    expect(added.status).toBe(201);
    expect((await staff.delete(`/admin/blocklist/${added.body.id}`)).status).toBe(204);
    const rows = await auditRows(db, 'blocklist', added.body.id);
    expect(rows.map((row) => [row.action, row.entityLabel])).toEqual([
      ['added to blocklist', 'imei 35389011•••••••'],
      ['removed from blocklist', 'imei 35389011•••••••'],
    ]);
    expect(rows[0]!.after).toMatchObject({ kind: 'imei', display: '35389011•••••••', reason: 'Stolen' });
    expect(rows[1]!.before).toMatchObject({ kind: 'imei', display: '35389011•••••••', source: 'manual' });
    for (const text of ['884201', '353890118842019', '35 389011 884201 9']) {
      expect(JSON.stringify(rows), text).not.toContain(text);
    }
    // The blocklist page itself still shows the entry in full: it is the staff's working list.
    const shown = await staff.post('/admin/blocklist', { kind: 'imei', value: '35 389011 884201 9', reason: 'Again' });
    expect(shown.body.display).toBe('35 389011 884201 9');
  });

  it('answers 409 ALREADY_BLOCKED for the same value in another case or typed another way, with no errors[]', async () => {
    await staff.post('/admin/blocklist', { kind: 'email', value: 'a@b.com', reason: 'x' });
    const again = await staff.post('/admin/blocklist', { kind: 'email', value: 'A@B.COM', reason: 'y' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_BLOCKED');
    expect(again.body.errors).toBeUndefined();
    await staff.post('/admin/blocklist', { kind: 'imei', value: '353890118842019', reason: 'x' });
    expect(
      (await staff.post('/admin/blocklist', { kind: 'imei', value: '35-389011-884201-9', reason: 'y' })).status,
    ).toBe(409);
    // Another kind with the same text is another entry.
    expect((await staff.post('/admin/blocklist', { kind: 'domain', value: 'b.com', reason: 'z' })).status).toBe(201);
    expect(await blocklistRows((await testDb()).db)).toHaveLength(3);
  });

  it('lets two requests for the same value make one entry', async () => {
    const body = { kind: 'email', value: 'race@example.com', reason: 'x' };
    const [a, b] = await Promise.all([staff.post('/admin/blocklist', body), staff.post('/admin/blocklist', body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await blocklistRows((await testDb()).db)).toHaveLength(1);
  });

  it('answers 422 on value or reason: a short IMEI, a bad email, an empty reason, a kind that cannot be added', async () => {
    const short = await staff.post('/admin/blocklist', { kind: 'imei', value: '35389011', reason: 'x' });
    expect(short.status).toBe(422);
    expect(short.body.errors[0]).toMatchObject({ field: 'value', message: 'An IMEI has 15 digits.' });
    const email = await staff.post('/admin/blocklist', { kind: 'email', value: 'nope', reason: 'x' });
    expect(email.body.errors[0]).toMatchObject({ field: 'value', message: 'Enter a valid email address.' });
    const reason = await staff.post('/admin/blocklist', { kind: 'email', value: 'a@b.com', reason: '   ' });
    expect(reason.status).toBe(422);
    expect(reason.body.errors[0].field).toBe('reason');
    for (const kind of ['device', 'country']) {
      const res = await staff.post('/admin/blocklist', { kind, value: 'GB', reason: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('kind');
    }
    expect(await blocklistRows((await testDb()).db)).toEqual([]);
  });

  it('blocks the email for the customer routes too: an entry made here is refused by the customer edit of feature 14b', async () => {
    const customer = await makeCustomer(t);
    await staff.post('/admin/blocklist', { kind: 'email', value: 'Blocked@Example.com', reason: 'Chargeback lost' });
    const editor = await adminWith(t, ['customers:update']);
    const res = await editor.patch(`/admin/customers/${customer.id}`, { email: 'blocked@example.com' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'email', message: 'This email is blocked.' });
  });

  it('needs risk:create', async () => {
    const reader = await adminWith(t, ['risk:read']);
    expect((await reader.post('/admin/blocklist', { kind: 'email', value: 'a@b.com', reason: 'x' })).status).toBe(403);
  });
});

describe('GET /admin/blocklist', () => {
  async function fill() {
    const { db } = await testDb();
    const email = await insertBlock(t, db, 'email', 'jt@tempbox.example', {
      display: 'jt****@tempbox.example',
      reason: 'Chargeback lost',
      source: 'chargeback',
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const domain = await insertBlock(t, db, 'domain', 'tempbox.example', {
      display: 'tempbox.example',
      reason: 'Disposable mailbox provider',
      createdBy: staff.staffId,
      createdAt: new Date('2026-11-03T00:00:00.000Z'),
    });
    const country = await insertBlock(t, db, 'country', 'KP', {
      display: 'KP',
      reason: 'Sanctions',
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    return { email, domain, country };
  }

  it('lists newest first with the total, the author as {id, name} (null for the system) and no hash', async () => {
    const rows = await fill();
    const res = await staff.get('/admin/blocklist');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([rows.domain.id, rows.country.id, rows.email.id]);
    expect(res.body[0].createdBy).toEqual({ id: staff.staffId, name: 'Lina S.' });
    expect(res.body[2]).toMatchObject({ source: 'chargeback', createdBy: null });
    expect(JSON.stringify(res.body)).not.toContain('valueHash');
    expect(res.body[0].updatedAt).toBeUndefined();
  });

  it('filters by kind, sorts, pages and searches the display and the reason', async () => {
    await fill();
    expect((await staff.get('/admin/blocklist?kind=email')).body).toHaveLength(1);
    expect((await staff.get('/admin/blocklist?kind=email&kind=domain')).total).toBe(2);
    expect(
      (await staff.get('/admin/blocklist?_sort=kind&_order=asc')).body.map((row: { kind: string }) => row.kind),
    ).toEqual(['country', 'domain', 'email']);
    const page = await staff.get('/admin/blocklist?_start=0&_end=1');
    expect(page.body).toHaveLength(1);
    expect(page.total).toBe(3);
    expect((await staff.get('/admin/blocklist?q=disposable')).body).toHaveLength(1);
    expect((await staff.get('/admin/blocklist?q=tempbox')).total).toBe(2);
    expect((await staff.get('/admin/blocklist?kind=bogus')).status).toBe(422);
    expect((await staff.get('/admin/blocklist?_sort=reason')).status).toBe(422);
  });

  it('reads one entry and answers 404 for an unknown id', async () => {
    const rows = await fill();
    expect((await staff.get(`/admin/blocklist/${rows.country.id}`)).body).toMatchObject({
      kind: 'country',
      display: 'KP',
    });
    expect((await staff.get('/admin/blocklist/999999')).status).toBe(404);
  });

  it('needs risk:read', async () => {
    const none = await adminWith(t, ['risk:create']);
    expect((await none.get('/admin/blocklist')).status).toBe(403);
  });
});

describe('DELETE /admin/blocklist/:id', () => {
  it('removes an entry of any source, audits it, and lets the value be added again', async () => {
    const { db } = await testDb();
    const entry = await insertBlock(t, db, 'email', 'x@y.com', { display: 'x@y.com', source: 'chargeback' });
    const res = await staff.delete(`/admin/blocklist/${entry.id}`);
    expect(res.status).toBe(204);
    expect(await blocklistRows(db)).toEqual([]);
    expect(await auditRows(db, 'blocklist', entry.id)).toMatchObject([
      { action: 'removed from blocklist', entityLabel: 'email x@y.com', before: { source: 'chargeback' } },
    ]);
    expect((await staff.post('/admin/blocklist', { kind: 'email', value: 'x@y.com', reason: 'again' })).status).toBe(
      201,
    );
  });

  it('answers 404 for an unknown or already removed entry', async () => {
    const { db } = await testDb();
    const entry = await insertBlock(t, db, 'domain', 'x.com');
    expect((await staff.delete(`/admin/blocklist/${entry.id}`)).status).toBe(204);
    expect((await staff.delete(`/admin/blocklist/${entry.id}`)).status).toBe(404);
  });

  it('needs risk:delete', async () => {
    const { db } = await testDb();
    const entry = await insertBlock(t, db, 'domain', 'x.com');
    const maker = await adminWith(t, ['risk:read', 'risk:create']);
    expect((await maker.delete(`/admin/blocklist/${entry.id}`)).status).toBe(403);
    expect(await blocklistRows(db)).toHaveLength(1);
  });
});
