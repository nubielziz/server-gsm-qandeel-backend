// Integration tests of the retired landing pages (decision 068): a page is a static page or a blog post and nothing else. Writing
// another kind is a 422 from the contract, the lists refuse the old kinds as filters, the public routes never answer a page of an
// old kind (even a row an old database or a restored backup still holds), and the landing-page generator is not served any more.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { ParsedListQuery } from '@src/common/contract';
import { schema as s } from '@src/infra/db';
import {
  findLivePage,
  findPage,
  listLivePages,
  listPages,
} from '@src/modules/storefront/infra/content-page.repository';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertPageRow } from '../../support/storefront';

/** The five kinds of page decision 068 retired. */
const LANDING_KINDS = ['country', 'model', 'brand', 'carrier', 'tool'] as const;

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['storefront:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** An anonymous GET on the store surface. */
async function publicGet(url: string) {
  const res = await t.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.body === '' ? undefined : JSON.parse(res.body), res };
}

const pageCount = async () => (await testDb()).db.$count(s.contentPages);

describe('writing a page of a retired landing kind', () => {
  it.each(LANDING_KINDS)('refuses to create a %s page with 422 on kind and writes nothing', async (kind) => {
    const res = await admin.post('/admin/content-pages', { kind, title: 'Unlock iPhone on AT&T', bodyMd: '# Unlock' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(['kind']);
    expect(await pageCount()).toBe(0);
  });

  it('still creates a static page and a blog post', async () => {
    expect((await admin.post('/admin/content-pages', { kind: 'static', title: 'About', bodyMd: '' })).status).toBe(201);
    expect((await admin.post('/admin/content-pages', { kind: 'blog', title: 'News', bodyMd: '' })).status).toBe(201);
  });

  it.each(LANDING_KINDS)('never turns a page into a %s page: a change carries no kind', async (kind) => {
    const { db } = await testDb();
    const page = await insertPageRow(db, { slug: 'about', title: 'About', kind: 'static' });
    // A body with nothing but the kind has nothing to change (422); with a field next to it, only that field changes.
    const alone = await admin.patch(`/admin/content-pages/${page.id}`, { kind });
    expect(alone.status).toBe(422);
    const next = await admin.patch(`/admin/content-pages/${page.id}`, { title: 'About us', kind });
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ title: 'About us', kind: 'static' });
    expect((await admin.get(`/admin/content-pages/${page.id}`)).body.kind).toBe('static');
  });
});

describe('reading with a retired landing kind', () => {
  it.each(LANDING_KINDS)('refuses kind=%s as a filter of the admin list and of the public list', async (kind) => {
    expect((await admin.get(`/admin/content-pages?kind=${kind}`)).status).toBe(422);
    expect((await admin.get(`/admin/content-pages?kind=static&kind=${kind}`)).status).toBe(422);
    expect((await publicGet(`/store/v1/pages?kind=${kind}`)).status).toBe(422);
  });

  it('lists and serves only static pages and blog posts, and answers 404 for the slug of an old landing page', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about', kind: 'static' });
    await insertPageRow(db, { slug: 'news', kind: 'blog' });
    const list = await publicGet('/store/v1/pages?_start=0&_end=100');
    expect(list.status).toBe(200);
    expect(list.body.map((row: { kind: string }) => row.kind).sort()).toEqual(['blog', 'static']);
    expect((await admin.get('/admin/content-pages')).body.map((row: { kind: string }) => row.kind).sort()).toEqual([
      'blog',
      'static',
    ]);
    expect((await publicGet('/store/v1/pages/unlock-iphone-on-atandt')).status).toBe(404);
    expect((await publicGet('/store/v1/pages/about')).status).toBe(200);
  });

  it('never reads a row of a retired kind, even one an old database or a restored backup still holds', async () => {
    const { db } = await testDb();
    const query: ParsedListQuery<'id'> = {
      range: { start: 0, end: 100, limit: 100 },
      sort: [{ field: 'id', order: 'asc' }],
      filters: [],
      search: undefined,
      extra: {},
    };
    await db.transaction(async (tx) => {
      // A temporary table of the same name hides `content_pages` for this transaction only. It has no check constraint, so it can hold
      // a landing row before and after the migration that makes the database refuse one; nothing outside the transaction sees it.
      await tx.execute(
        sql`create temp table content_pages (like public.content_pages including defaults including identity) on commit drop`,
      );
      await tx.execute(sql`insert into content_pages (kind, slug, title, status, published_at) values
        ('country', 'old-country', 'Old country', 'published', now()),
        ('carrier', 'old-carrier', 'Old carrier', 'noindex', now()),
        ('static', 'about', 'About', 'published', now())`);
      const { rows: ids } = await tx.execute<{ id: number; slug: string }>(
        sql`select id, slug from content_pages order by id`,
      );
      const idOf = (slug: string) => ids.find((row) => row.slug === slug)!.id;

      expect((await listLivePages(tx, query)).rows.map((row) => row.slug)).toEqual(['about']);
      expect((await listLivePages(tx, query)).total).toBe(1);
      expect((await listPages(tx, query)).rows.map((row) => row.slug)).toEqual(['about']);
      expect((await listPages(tx, query)).total).toBe(1);
      expect(await findLivePage(tx, 'old-country')).toBeUndefined();
      expect(await findLivePage(tx, 'old-carrier')).toBeUndefined();
      expect((await findLivePage(tx, 'about'))?.kind).toBe('static');
      expect(await findPage(tx, idOf('old-country'))).toBeUndefined();
      expect(await findPage(tx, idOf('old-carrier'), true)).toBeUndefined();
      expect((await findPage(tx, idOf('about')))?.slug).toBe('about');
    });
    // The transaction left nothing behind in the real table.
    expect(await pageCount()).toBe(0);
  });
});

describe('POST /admin/content-pages/generate', () => {
  it('is not served any more: the landing-page generator was retired', async () => {
    const res = await admin.post('/admin/content-pages/generate', {
      brands: [],
      models: ['iPhone 12'],
      networks: ['AT&T'],
    });
    expect(res.status).toBe(404);
    expect(await pageCount()).toBe(0);
  });
});
