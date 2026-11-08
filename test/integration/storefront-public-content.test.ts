// Integration tests of the public content routes (feature 15): GET /store/v1/pages/:slug (live content pages, noindex, drafts,
// the legal documents in force, languages) and GET /store/v1/help and /help/:slug (published articles only, search, topic filter,
// the derived slug). Anonymous reads on the store surface.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../support/app';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertArticleRow, insertLegalRow, insertPageRow } from '../support/storefront';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

/** An anonymous GET on the store surface: no session, no cookie, no token. */
async function get(url: string) {
  const res = await t.app.inject({ method: 'GET', url });
  return {
    status: res.statusCode,
    body: res.body === '' ? undefined : JSON.parse(res.body),
    total: Number(res.headers['x-total-count'] ?? Number.NaN),
    res,
  };
}

describe('GET /store/v1/pages/:slug', () => {
  it('serves a published content page without a session, with its SEO fields and times', async () => {
    const { db } = await testDb();
    await insertPageRow(db, {
      kind: 'carrier',
      slug: 'unlock-iphone-on-atandt',
      title: 'Unlock iPhone on AT&T',
      bodyMd: '# Unlock\n\n<b>raw html as stored</b>',
      seoTitle: 'Unlock AT&T',
      seoDescription: 'How it works',
      publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    });
    const res = await get('/store/v1/pages/unlock-iphone-on-atandt');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'carrier',
      slug: 'unlock-iphone-on-atandt',
      locale: 'en',
      title: 'Unlock iPhone on AT&T',
      bodyMd: '# Unlock\n\n<b>raw html as stored</b>',
      seoTitle: 'Unlock AT&T',
      seoDescription: 'How it works',
      canonicalUrl: null,
      noindex: false,
      publishedAt: '2026-10-01T09:00:00.000Z',
      legal: null,
    });
    // No private field leaks: no author, no id, no status.
    expect(Object.keys(res.body).sort()).toEqual([
      'bodyMd',
      'canonicalUrl',
      'kind',
      'legal',
      'locale',
      'noindex',
      'publishedAt',
      'seoDescription',
      'seoTitle',
      'slug',
      'title',
      'updatedAt',
    ]);
  });

  it('serves a noindex page with noindex true and answers 404 for a draft and for an unknown slug', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'hidden-from-google', status: 'noindex' });
    await insertPageRow(db, { slug: 'not-yet', status: 'draft', publishedAt: null });
    expect((await get('/store/v1/pages/hidden-from-google')).body.noindex).toBe(true);
    const draft = await get('/store/v1/pages/not-yet');
    expect(draft.status).toBe(404);
    expect(draft.body.code).toBe('NOT_FOUND');
    expect((await get('/store/v1/pages/nothing-here')).status).toBe(404);
  });

  it('keeps languages apart: ?locale= picks the page, English is the default, and a missing translation is 404', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about', locale: 'en', title: 'About us' });
    await insertPageRow(db, { slug: 'about', locale: 'ar', title: 'من نحن' });
    await insertPageRow(db, { slug: 'english-only', locale: 'en' });
    expect((await get('/store/v1/pages/about')).body.title).toBe('About us');
    expect((await get('/store/v1/pages/about?locale=ar')).body.title).toBe('من نحن');
    expect((await get('/store/v1/pages/english-only?locale=ar')).status).toBe(404);
    expect((await get('/store/v1/pages/about?locale=fr')).status).toBe(422);
  });

  it('serves the legal document in force for terms, privacy, refund and cookies, with the version a consent references', async () => {
    const { db } = await testDb();
    const current = await insertLegalRow(db, {
      type: 'terms',
      version: '3.2',
      bodyMd: '# Terms of service v3.2',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
      requiresReacceptance: true,
    });
    await insertLegalRow(db, { type: 'terms', version: '3.1', effectiveFrom: new Date('2026-07-01T09:00:00.000Z') });
    await insertLegalRow(db, { type: 'terms', version: '3.3' });
    const res = await get('/store/v1/pages/terms');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'legal',
      slug: 'terms',
      locale: 'en',
      title: 'Terms of service',
      bodyMd: '# Terms of service v3.2',
      noindex: false,
      publishedAt: '2026-10-01T09:00:00.000Z',
      legal: {
        id: current.id,
        type: 'terms',
        version: '3.2',
        effectiveFrom: '2026-10-01T09:00:00.000Z',
        requiresReacceptance: true,
      },
    });
  });

  it('answers 404 for a legal slug with nothing in force (only drafts or earlier versions) or in another language', async () => {
    const { db } = await testDb();
    await insertLegalRow(db, { type: 'privacy', version: '1.0' });
    await insertLegalRow(db, { type: 'refund', version: '1.0', effectiveFrom: new Date('2026-07-01T09:00:00.000Z') });
    await insertLegalRow(db, { type: 'cookies', version: '1.0', isCurrent: true, effectiveFrom: new Date() });
    expect((await get('/store/v1/pages/privacy')).status).toBe(404);
    expect((await get('/store/v1/pages/refund')).status).toBe(404);
    expect((await get('/store/v1/pages/cookies')).status).toBe(200);
    expect((await get('/store/v1/pages/cookies?locale=ar')).status).toBe(404);
  });

  it('is a read: no CSRF token and no Turnstile token needed', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about' });
    const res = await t.app.inject({
      method: 'GET',
      url: '/store/v1/pages/about',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /store/v1/help', () => {
  it('lists only the published articles of the language in the staff order, with slugs, votes and the total', async () => {
    const { db } = await testDb();
    const second = await insertArticleRow(db, {
      question: 'Can I cancel my order?',
      sort: 2,
      helpfulYes: 96,
      helpfulNo: 31,
    });
    const first = await insertArticleRow(db, { question: 'Where is my order?', sort: 1 });
    await insertArticleRow(db, { question: 'A draft', isPublished: false, sort: 3 });
    await insertArticleRow(db, { question: 'كيف أدفع؟', locale: 'ar', sort: 4 });
    const res = await get('/store/v1/help');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((a: { id: number }) => a.id)).toEqual([first.id, second.id]);
    expect(res.body[1]).toMatchObject({
      id: second.id,
      slug: `${second.id}-can-i-cancel-my-order`,
      category: 'Orders',
      question: 'Can I cancel my order?',
      answerMd: 'Usually one to three days.',
      locale: 'en',
      helpfulYes: 96,
      helpfulNo: 31,
    });
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'answerMd',
      'category',
      'helpfulNo',
      'helpfulYes',
      'id',
      'locale',
      'question',
      'slug',
      'sort',
      'updatedAt',
    ]);
    expect((await get('/store/v1/help?locale=ar')).body.map((a: { question: string }) => a.question)).toEqual([
      'كيف أدفع؟',
    ]);
  });

  it('searches the question, the answer and the topic, filters by topic and pages with an exact total', async () => {
    const { db } = await testDb();
    await insertArticleRow(db, {
      question: 'How do I find my IMEI?',
      category: 'IMEI',
      answerMd: 'Dial *#06#.',
      sort: 1,
    });
    await insertArticleRow(db, {
      question: 'Why was I charged VAT?',
      category: 'Payments',
      answerMd: 'EU rules.',
      sort: 2,
    });
    await insertArticleRow(db, {
      question: 'How do refunds work?',
      category: 'Payments',
      answerMd: 'Within 5 days.',
      sort: 3,
    });
    expect((await get('/store/v1/help?q=imei')).total).toBe(1);
    expect((await get('/store/v1/help?q=eu%20rules')).total).toBe(1);
    expect((await get('/store/v1/help?q=payments')).total).toBe(2);
    expect((await get('/store/v1/help?category=Payments')).total).toBe(2);
    const paged = await get('/store/v1/help?_start=1&_end=2');
    expect(paged.total).toBe(3);
    expect(paged.body).toHaveLength(1);
    expect((await get('/store/v1/help?q=nothing-matches')).body).toEqual([]);
    expect((await get('/store/v1/help?_sort=answerMd')).status).toBe(422);
  });
});

describe('GET /store/v1/help/:slug', () => {
  it('serves a published article by the slug the list sends, and by the id alone', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { question: 'How do I find my IMEI?' });
    const slug = `${article.id}-how-do-i-find-my-imei`;
    expect((await get(`/store/v1/help/${slug}`)).body).toMatchObject({
      id: article.id,
      slug,
      question: 'How do I find my IMEI?',
    });
    expect((await get(`/store/v1/help/${article.id}`)).status).toBe(200);
  });

  it('keeps an old link working after the question is edited, with the current slug in the answer', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { question: 'New wording' });
    const res = await get(`/store/v1/help/${article.id}-the-old-wording`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(`${article.id}-new-wording`);
  });

  it('answers 404 for an unpublished article, an unknown id and a slug without an id', async () => {
    const { db } = await testDb();
    const draft = await insertArticleRow(db, { isPublished: false });
    expect((await get(`/store/v1/help/${draft.id}-a-draft`)).status).toBe(404);
    expect((await get('/store/v1/help/999999-nothing')).status).toBe(404);
    const noId = await get('/store/v1/help/how-do-i-find-my-imei');
    expect(noId.status).toBe(404);
    expect(noId.body.code).toBe('NOT_FOUND');
  });
});
