// Integration tests of the content page routes (feature 15): list with kind, status, locale and search filters, show, create (a
// draft by the signed-in author, slug rules, reserved legal words, races), change (slug per language, SEO fields, never the
// status) and publish or hide, with the audit rows and permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertPageRow } from '../support/storefront';

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
  admin = await adminWith(t, ['storefront:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

describe('GET /admin/content-pages', () => {
  it('lists the full rows, last change first, with the figures the map has no source for as null', async () => {
    const { db } = await testDb();
    // Explicit times: the column default has microseconds while a change writes milliseconds, so times taken a few
    // microseconds apart could sort either way.
    const old = await insertPageRow(db, {
      slug: 'old',
      title: 'Old',
      kind: 'carrier',
      bodyMd: '# Old body',
      updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    const fresh = await insertPageRow(db, {
      slug: 'fresh',
      title: 'Fresh',
      seoTitle: 'Fresh SEO',
      updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    });
    // A change moves `updated_at`, so the older page is now the one changed last.
    await db
      .update(s.contentPages)
      .set({ title: 'Old', updatedAt: new Date('2026-11-03T10:00:00.000Z') })
      .where(eq(s.contentPages.id, old.id));
    const res = await admin.get('/admin/content-pages');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((p: { id: number }) => p.id)).toEqual([old.id, fresh.id]);
    expect(res.body[0]).toMatchObject({
      id: old.id,
      kind: 'carrier',
      slug: 'old',
      locale: 'en',
      title: 'Old',
      bodyMd: '# Old body',
      seoTitle: '',
      seoDescription: '',
      status: 'published',
      canonicalUrl: null,
      visits30d: null,
      orders30d: null,
    });
    expect(typeof res.body[0].publishedAt).toBe('string');
    expect(typeof res.body[0].updatedAt).toBe('string');
  });

  it('filters by repeated kind, status and locale, and counts with _start=0&_end=1', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { kind: 'carrier', slug: 'c1' });
    await insertPageRow(db, { kind: 'brand', slug: 'b1', status: 'draft', publishedAt: null });
    await insertPageRow(db, { kind: 'static', slug: 's1' });
    await insertPageRow(db, { kind: 'blog', slug: 'g1', status: 'noindex' });
    await insertPageRow(db, { kind: 'blog', slug: 'g2', locale: 'ar' });
    expect(
      (await admin.get('/admin/content-pages?kind=static&kind=blog&_start=0&_end=200&_sort=title&_order=asc')).total,
    ).toBe(3);
    expect((await admin.get('/admin/content-pages?kind=carrier&_start=0&_end=1')).total).toBe(1);
    expect((await admin.get('/admin/content-pages?status=draft&_start=0&_end=1')).total).toBe(1);
    expect((await admin.get('/admin/content-pages?status=noindex&_start=0&_end=1')).total).toBe(1);
    expect((await admin.get('/admin/content-pages?locale=ar')).total).toBe(1);
    expect((await admin.get('/admin/content-pages?kind=news')).status).toBe(422);
  });

  it('searches the title and the slug and sorts by title, status and updatedAt', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about', title: 'About us' });
    await insertPageRow(db, { slug: 'contact', title: 'Contact and support' });
    expect((await admin.get('/admin/content-pages?q=abou')).body.map((p: { slug: string }) => p.slug)).toEqual([
      'about',
    ]);
    expect((await admin.get('/admin/content-pages?q=SUPPORT')).total).toBe(1);
    expect((await admin.get('/admin/content-pages?_sort=title&_order=desc')).body[0].slug).toBe('contact');
    expect((await admin.get('/admin/content-pages?_sort=status')).status).toBe(200);
    expect((await admin.get('/admin/content-pages?_sort=bodyMd')).status).toBe(422);
  });

  it('needs storefront:read', async () => {
    const other = await adminWith(t, ['legal:*']);
    expect((await other.get('/admin/content-pages')).status).toBe(403);
  });
});

describe('GET /admin/content-pages/:id', () => {
  it('shows one page and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const page = await insertPageRow(db, { slug: 'about' });
    expect((await admin.get(`/admin/content-pages/${page.id}`)).body).toMatchObject({ id: page.id, slug: 'about' });
    expect((await admin.get('/admin/content-pages/999999')).status).toBe(404);
  });

  it('carries the canonical address of the page, or null when none is set (ANSWERS storefront Q8)', async () => {
    const { db } = await testDb();
    const plain = await insertPageRow(db, { slug: 'plain' });
    const canonical = await insertPageRow(db, { slug: 'about', canonicalUrl: 'https://shop.example/en/about' });
    expect((await admin.get(`/admin/content-pages/${plain.id}`)).body.canonicalUrl).toBeNull();
    expect((await admin.get(`/admin/content-pages/${canonical.id}`)).body.canonicalUrl).toBe(
      'https://shop.example/en/about',
    );
    const list = await admin.get('/admin/content-pages?_sort=slug&_order=asc');
    expect(list.body.map((p: { slug: string; canonicalUrl: string | null }) => [p.slug, p.canonicalUrl])).toEqual([
      ['about', 'https://shop.example/en/about'],
      ['plain', null],
    ]);
  });
});

describe('POST /admin/content-pages', () => {
  it('creates a draft by the signed-in staff member, keeps the body as typed, and audits it', async () => {
    const { db } = await testDb();
    const body = '# About\n\n  two spaces kept\n\n<b>html stays as sent</b>\n';
    const res = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: '  About us ',
      locale: 'en',
      bodyMd: body,
      seoTitle: ' About us | GSM ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'static',
      slug: 'about-us',
      locale: 'en',
      title: 'About us',
      bodyMd: body,
      seoTitle: 'About us | GSM',
      seoDescription: '',
      status: 'draft',
      publishedAt: null,
    });
    const [row] = await db.select().from(s.contentPages);
    expect(row?.authorId).toBe(admin.staffId);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created page',
      entityType: 'content_page',
      entityId: res.body.id,
      entityLabel: 'About us',
    });
  });

  it('keeps a typed slug, and a slug is unique per language only', async () => {
    const first = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: 'About',
      locale: 'en',
      slug: 'about',
      bodyMd: '',
    });
    expect(first.body.slug).toBe('about');
    const arabic = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: 'عنا',
      locale: 'ar',
      slug: 'about',
      bodyMd: '',
    });
    expect(arabic.status).toBe(201);
    const taken = await admin.post('/admin/content-pages', {
      kind: 'blog',
      title: 'Other',
      locale: 'en',
      slug: 'about',
      bodyMd: '',
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'SLUG_TAKEN', errors: [expect.objectContaining({ field: 'slug' })] });
  });

  it('makes the slug from the title when none is typed and refuses a title that cannot make one', async () => {
    const res = await admin.post('/admin/content-pages', {
      kind: 'carrier',
      title: 'Unlock iPhone on AT&T',
      locale: 'en',
      bodyMd: '',
    });
    expect(res.body.slug).toBe('unlock-iphone-on-atandt');
    const none = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: 'من نحن',
      locale: 'ar',
      bodyMd: '',
    });
    expect(none.status).toBe(422);
    expect(none.body.errors[0].field).toBe('slug');
    const bad = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: 'X',
      locale: 'en',
      slug: 'Bad Slug',
      bodyMd: '',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('slug');
  });

  it('reserves terms, privacy, refund and cookies for the legal documents', async () => {
    const res = await admin.post('/admin/content-pages', { kind: 'static', title: 'Terms', locale: 'en', bodyMd: '' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SLUG_TAKEN',
      detail: 'The slug terms is reserved for the legal documents.',
      errors: [expect.objectContaining({ field: 'slug' })],
    });
  });

  it('maps a race on the same slug to 409, never 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        admin.post('/admin/content-pages', { kind: 'static', title: 'Racing', locale: 'en', bodyMd: '' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('refuses an unknown kind, a blank title, a bad language and a missing body on the field', async () => {
    const res = await admin.post('/admin/content-pages', { kind: 'news', title: ' ', locale: 'de' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'bodyMd',
      'kind',
      'locale',
      'title',
    ]);
  });

  it('needs storefront:create and a CSRF token', async () => {
    const reader = await adminWith(t, ['storefront:read', 'storefront:update']);
    const payload = { kind: 'static', title: 'About', locale: 'en', bodyMd: '' };
    expect((await reader.post('/admin/content-pages', payload)).status).toBe(403);
    expect((await admin.withoutCsrf('POST', '/admin/content-pages', payload)).status).toBe(403);
  });
});

describe('PATCH /admin/content-pages/:id', () => {
  it('changes the fields sent, trims short ones, clears an SEO field with an empty string and moves updatedAt', async () => {
    const { db } = await testDb();
    const page = await insertPageRow(db, {
      slug: 'about',
      title: 'About',
      seoTitle: 'Old SEO',
      seoDescription: 'Old description',
    });
    const before = (await admin.get(`/admin/content-pages/${page.id}`)).body;
    const res = await admin.patch(`/admin/content-pages/${page.id}`, {
      title: '  About GSM  ',
      bodyMd: '# New  \n',
      seoTitle: '',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'About GSM',
      bodyMd: '# New  \n',
      seoTitle: '',
      seoDescription: 'Old description',
      slug: 'about',
      status: 'published',
    });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'edited page',
      entityType: 'content_page',
      entityId: page.id,
      entityLabel: 'About GSM',
    });
    expect(audit?.before).toMatchObject({ title: 'About', seoTitle: 'Old SEO' });
    expect(audit?.after).toMatchObject({ title: 'About GSM', seoTitle: '' });
  });

  it('refuses an empty title or slug, keeps the slug unique in the (new) language and ignores kind and status', async () => {
    const { db } = await testDb();
    const a = await insertPageRow(db, { slug: 'about', locale: 'en' });
    await insertPageRow(db, { slug: 'about', locale: 'ar' });
    const b = await insertPageRow(db, { slug: 'other', locale: 'en' });
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { title: '  ' })).body.errors[0].field).toBe('title');
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { slug: '' })).body.errors[0].field).toBe('slug');
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { slug: 'Not Valid' })).body.errors[0].field).toBe(
      'slug',
    );
    const taken = await admin.patch(`/admin/content-pages/${b.id}`, { slug: 'about' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SLUG_TAKEN');
    // Moving the English "about" to Arabic collides with the Arabic "about"; moving it with a new slug does not.
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { locale: 'ar' })).status).toBe(409);
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { locale: 'ar', slug: 'about-en' })).status).toBe(200);
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { slug: 'terms' })).status).toBe(409);
    expect((await admin.patch(`/admin/content-pages/${a.id}`, { kind: 'blog', status: 'draft' })).status).toBe(422);
    expect((await admin.patch(`/admin/content-pages/${a.id}`, {})).status).toBe(422);
  });

  it('answers 404 for an unknown page and needs storefront:update', async () => {
    const { db } = await testDb();
    const page = await insertPageRow(db);
    expect((await admin.patch('/admin/content-pages/999999', { title: 'x' })).status).toBe(404);
    const reader = await adminWith(t, ['storefront:read']);
    expect((await reader.patch(`/admin/content-pages/${page.id}`, { title: 'x' })).status).toBe(403);
  });
});

describe('POST /admin/content-pages/:id/publish', () => {
  it('publishes a draft at the clock time, hides it again keeping that publish time, and audits all three', async () => {
    const { db } = await testDb();
    const draft = await insertPageRow(db, { slug: 'draft', status: 'draft', publishedAt: null, title: 'A draft' });
    const live = await admin.post(`/admin/content-pages/${draft.id}/publish`, { published: true });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'published', publishedAt: '2026-11-07T12:00:00.000Z' });

    clock.advance(60_000);
    const hidden = await admin.post(`/admin/content-pages/${draft.id}/publish`, { published: false });
    expect(hidden.body).toMatchObject({ status: 'draft', publishedAt: '2026-11-07T12:00:00.000Z' });

    // Published again after being hidden: it is a new publication, stamped with the clock's time.
    const again = await admin.post(`/admin/content-pages/${draft.id}/publish`, { published: true });
    expect(again.body.publishedAt).toBe('2026-11-07T12:01:00.000Z');

    const audit = await auditRows();
    expect(audit.map((a) => [a.action, a.entityType, a.entityId, a.entityLabel])).toEqual([
      ['published page', 'content_page', draft.id, 'A draft'],
      ['unpublished page', 'content_page', draft.id, 'A draft'],
      ['published page', 'content_page', draft.id, 'A draft'],
    ]);
    expect(audit[0]?.before).toEqual({ status: 'draft' });
    expect(audit[0]?.after).toEqual({ status: 'published' });
  });

  it('works from noindex and sets the publish time again for a page that is already live (published_at now)', async () => {
    const { db } = await testDb();
    const first = new Date('2026-10-01T09:00:00.000Z');
    const page = await insertPageRow(db, { status: 'noindex', publishedAt: first });
    const res = await admin.post(`/admin/content-pages/${page.id}/publish`, { published: true });
    expect(res.body).toMatchObject({ status: 'published', publishedAt: '2026-11-07T12:00:00.000Z' });
    // A live page published again takes the clock's time again, not the old one.
    clock.advance(60_000);
    const again = await admin.post(`/admin/content-pages/${page.id}/publish`, { published: true });
    expect(again.body).toMatchObject({ status: 'published', publishedAt: '2026-11-07T12:01:00.000Z' });
    // Hiding keeps the last publish time.
    const hidden = await admin.post(`/admin/content-pages/${page.id}/publish`, { published: false });
    expect(hidden.body).toMatchObject({ status: 'draft', publishedAt: '2026-11-07T12:01:00.000Z' });
  });

  it('refuses a body without a boolean on published, answers 404 for an unknown page and needs storefront:publish', async () => {
    const { db } = await testDb();
    const page = await insertPageRow(db, { status: 'draft', publishedAt: null });
    const bad = await admin.post(`/admin/content-pages/${page.id}/publish`, { published: 'yes' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('published');
    expect((await admin.post('/admin/content-pages/999999/publish', { published: true })).status).toBe(404);
    const editor = await adminWith(t, ['storefront:read', 'storefront:create', 'storefront:update']);
    expect((await editor.post(`/admin/content-pages/${page.id}/publish`, { published: true })).status).toBe(403);
  });
});
