// Integration tests of the reply template routes (feature 17): list with filters and search, show, create, change and delete, the shortcut
// rules (trimmed, empty is none, unique ignoring case among the non-empty ones), the audit trail and the permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { supportStaff } from '../support/support';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await supportStaff(t, ['support:*'], 'Rami K.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const NEW_TEMPLATE = {
  title: 'Order is in progress',
  category: 'delay',
  locale: 'en',
  body: 'Hi {{name}}, your order {{order}} is with the carrier; the usual time is {{eta}}.',
  shortcut: '/progress',
} as const;

describe('POST /admin/reply-templates', () => {
  it('creates a template with its author, keeps the variables raw, and audits it', async () => {
    const res = await admin.post('/admin/reply-templates', {
      ...NEW_TEMPLATE,
      title: '  Order is in progress ',
      body: ` ${NEW_TEMPLATE.body} `,
      shortcut: ' /progress ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...NEW_TEMPLATE, createdBy: admin.staffId });
    expect(res.body.createdAt).toBe('2026-11-08T12:00:00.000Z');
    expect(res.body.updatedAt).toBe('2026-11-08T12:00:00.000Z');
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created reply template',
      entityType: 'reply_template',
      entityId: res.body.id,
      entityLabel: 'Order is in progress',
    });
  });

  it('stores an empty shortcut as none and reads it back as an empty string, for any number of templates', async () => {
    const first = await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, shortcut: '' });
    const second = await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, title: 'Second', shortcut: '   ' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.shortcut).toBe('');
    const { db } = await testDb();
    const stored = await db.select({ shortcut: s.replyTemplates.shortcut }).from(s.replyTemplates);
    expect(stored).toEqual([{ shortcut: null }, { shortcut: null }]);
    expect((await admin.get(`/admin/reply-templates/${second.body.id}`)).body.shortcut).toBe('');
  });

  it('answers 409 SHORTCUT_TAKEN naming the owner, ignoring case, with no errors list', async () => {
    await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const res = await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, title: 'Other', shortcut: '/PROGRESS' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHORTCUT_TAKEN');
    expect(res.body.detail).toBe('/PROGRESS already belongs to “Order is in progress”.');
    expect(res.body.errors).toBeUndefined();
    expect((await admin.get('/admin/reply-templates')).total).toBe(1);
  });

  it('maps two creates of one shortcut at once to one 201 and one 409, never a 500', async () => {
    const results = await Promise.all([
      admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, title: 'A' }),
      admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, title: 'B' }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
  });

  it('validates each field with the console’s messages', async () => {
    const res = await admin.post('/admin/reply-templates', {
      title: '  ',
      category: 'nope',
      locale: 'fr',
      body: '',
      shortcut: 'progress',
    });
    expect(res.status).toBe(422);
    const messages = Object.fromEntries(
      res.body.errors.map((error: { field: string; message: string }) => [error.field, error.message]),
    );
    expect(messages).toEqual({
      title: 'Give the template a title.',
      category: 'Choose a category.',
      locale: 'Choose a language.',
      body: 'Write the reply text.',
      shortcut: 'A shortcut starts with a slash, like /refund.',
    });
    expect((await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, shortcut: '/two words' })).status).toBe(422);
    expect((await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, locale: 'ar' })).status).toBe(201);
  });

  it('needs support:create', async () => {
    const reader = await supportStaff(t, ['support:read', 'support:update', 'support:delete']);
    const res = await reader.post('/admin/reply-templates', NEW_TEMPLATE);
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('support:create');
    expect((await admin.withoutCsrf('POST', '/admin/reply-templates', NEW_TEMPLATE)).status).toBe(403);
  });
});

describe('GET /admin/reply-templates', () => {
  it('lists A to Z by title with the total, filters by category and language, and searches the title, text and shortcut', async () => {
    await admin.post('/admin/reply-templates', { ...NEW_TEMPLATE, title: 'Zebra', shortcut: '/z' });
    await admin.post('/admin/reply-templates', {
      ...NEW_TEMPLATE,
      title: 'Alpha',
      category: 'refund',
      shortcut: '/refund',
    });
    await admin.post('/admin/reply-templates', {
      ...NEW_TEMPLATE,
      title: 'Mid',
      locale: 'ar',
      body: 'marhaba {{name}}',
      shortcut: '',
    });
    const res = await admin.get('/admin/reply-templates?_start=0&_end=200&_sort=title&_order=asc');
    expect(res.total).toBe(3);
    expect(res.body.map((row: { title: string }) => row.title)).toEqual(['Alpha', 'Mid', 'Zebra']);
    const titles = async (query: string) =>
      (await admin.get(`/admin/reply-templates?${query}`)).body.map((row: { title: string }) => row.title);
    expect(await titles('category=refund')).toEqual(['Alpha']);
    expect(await titles('locale=ar')).toEqual(['Mid']);
    expect(await titles('q=marhaba')).toEqual(['Mid']);
    expect(await titles('q=/refund')).toEqual(['Alpha']);
    expect(await titles('q=zebra')).toEqual(['Zebra']);
    expect((await admin.get('/admin/reply-templates?_sort=body')).status).toBe(422);
  });

  it('needs support:read', async () => {
    const other = await supportStaff(t, ['groups:read']);
    expect((await other.get('/admin/reply-templates')).status).toBe(403);
    expect((await other.get('/admin/reply-templates/1')).status).toBe(403);
  });
});

describe('GET /admin/reply-templates/:id', () => {
  it('shows one template and answers 404 for an unknown id', async () => {
    const created = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const res = await admin.get(`/admin/reply-templates/${created.body.id}`);
    expect(res.body).toEqual(created.body);
    const missing = await admin.get('/admin/reply-templates/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /admin/reply-templates/:id', () => {
  it('changes only the keys sent, moves updatedAt forward and audits before and after', async () => {
    const created = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    clock.advance(60_000);
    const res = await admin.patch(`/admin/reply-templates/${created.body.id}`, {
      title: ' Renamed ',
      body: 'New text.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Renamed',
      body: 'New text.',
      shortcut: '/progress',
      category: 'delay',
      locale: 'en',
    });
    expect(res.body.createdAt).toBe('2026-11-08T12:00:00.000Z');
    expect(res.body.updatedAt).toBe('2026-11-08T12:01:00.000Z');
    const [, audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'edited reply template',
      entityType: 'reply_template',
      entityId: created.body.id,
      entityLabel: 'Renamed',
      before: { title: 'Order is in progress' },
      after: { title: 'Renamed', body: 'New text.' },
    });
  });

  it('clears a shortcut with an empty string, frees it for another template, and refuses one another has', async () => {
    const first = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const second = await admin.post('/admin/reply-templates', {
      ...NEW_TEMPLATE,
      title: 'Second',
      shortcut: '/second',
    });
    const taken = await admin.patch(`/admin/reply-templates/${second.body.id}`, { shortcut: '/Progress' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SHORTCUT_TAKEN');
    expect(taken.body.detail).toContain('Order is in progress');
    expect((await admin.patch(`/admin/reply-templates/${first.body.id}`, { shortcut: '' })).body.shortcut).toBe('');
    expect((await admin.patch(`/admin/reply-templates/${second.body.id}`, { shortcut: '/progress' })).status).toBe(200);
    // The template's own shortcut is not a clash with itself.
    expect((await admin.patch(`/admin/reply-templates/${second.body.id}`, { shortcut: '/PROGRESS' })).status).toBe(200);
  });

  it('validates the keys that are present, needs one key, answers 404 and needs support:update', async () => {
    const created = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const url = `/admin/reply-templates/${created.body.id}`;
    expect((await admin.patch(url, { title: '' })).body.errors).toEqual([
      expect.objectContaining({ field: 'title', message: 'Give the template a title.' }),
    ]);
    expect((await admin.patch(url, {})).status).toBe(422);
    expect((await admin.patch('/admin/reply-templates/999999', { title: 'x' })).status).toBe(404);
    const other = await supportStaff(t, ['support:read']);
    expect((await other.patch(url, { title: 'x' })).status).toBe(403);
  });
});

describe('DELETE /admin/reply-templates/:id', () => {
  it('deletes for good with 204, audits it, and answers 404 the second time', async () => {
    const created = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const res = await admin.delete(`/admin/reply-templates/${created.body.id}`);
    expect(res.status).toBe(204);
    const { db } = await testDb();
    expect(await db.select().from(s.replyTemplates).where(eq(s.replyTemplates.id, created.body.id))).toHaveLength(0);
    expect((await auditRows())[1]).toMatchObject({
      action: 'deleted reply template',
      entityId: created.body.id,
      entityLabel: 'Order is in progress',
      before: { title: 'Order is in progress', shortcut: '/progress' },
    });
    expect((await admin.delete(`/admin/reply-templates/${created.body.id}`)).status).toBe(404);
  });

  it('needs support:delete', async () => {
    const created = await admin.post('/admin/reply-templates', NEW_TEMPLATE);
    const other = await supportStaff(t, ['support:read', 'support:update', 'support:create']);
    const res = await other.delete(`/admin/reply-templates/${created.body.id}`);
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('support:delete');
  });
});
