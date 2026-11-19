// Integration tests of the public content routes (feature 15): GET /store/v1/pages/:slug (live content pages, noindex, drafts,
// the legal documents in force) and GET /store/v1/help and /help/:slug (published articles only, search, topic filter, the derived
// slug). Anonymous reads on the store surface. English only (decision 039): no page or article has a language.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertArticleRow, insertLegalRow, insertPageRow } from '../../support/storefront';

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

  it('takes no language: a ?locale= an older website still sends is ignored, and the page carries none', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about', title: 'About us' });
    expect((await get('/store/v1/pages/about')).body.title).toBe('About us');
    const old = await get('/store/v1/pages/about?locale=tr');
    expect(old.status).toBe(200);
    expect(old.body.title).toBe('About us');
    expect(old.body).not.toHaveProperty('locale');
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

  it('answers 404 for a legal slug with nothing in force (only drafts, earlier or retired versions)', async () => {
    const { db } = await testDb();
    await insertLegalRow(db, { type: 'privacy', version: '1.0' });
    await insertLegalRow(db, { type: 'refund', version: '1.0', effectiveFrom: new Date('2026-07-01T09:00:00.000Z') });
    // A retired version in another language is evidence, never a page (decision 039, section 4.4).
    await insertLegalRow(db, {
      type: 'terms',
      version: '1.0',
      locale: 'tr',
      bodyMd: '# Retired text',
      effectiveFrom: new Date('2026-07-01T09:00:00.000Z'),
    });
    await insertLegalRow(db, { type: 'cookies', version: '1.0', isCurrent: true, effectiveFrom: new Date() });
    expect((await get('/store/v1/pages/privacy')).status).toBe(404);
    expect((await get('/store/v1/pages/refund')).status).toBe(404);
    expect((await get('/store/v1/pages/terms')).status).toBe(404);
    expect((await get('/store/v1/pages/cookies')).status).toBe(200);
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
  it('lists only the published articles in the staff order, with slugs, votes and the total', async () => {
    const { db } = await testDb();
    const second = await insertArticleRow(db, {
      question: 'Can I cancel my order?',
      sort: 2,
      helpfulYes: 96,
      helpfulNo: 31,
    });
    const first = await insertArticleRow(db, { question: 'Where is my order?', sort: 1 });
    await insertArticleRow(db, { question: 'A draft', isPublished: false, sort: 3 });
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
      helpfulYes: 96,
      helpfulNo: 31,
    });
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'answerMd',
      'category',
      'helpfulNo',
      'helpfulYes',
      'id',
      'question',
      'slug',
      'sort',
      'updatedAt',
    ]);
    // The list is strict: the language is an unknown key now (the website stops sending it in the same release).
    expect((await get('/store/v1/help?locale=en')).status).toBe(422);
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

describe('GET /store/v1/pages', () => {
  it('lists the live pages without their bodies, newest publication first, and never a draft or a legal document', async () => {
    const { db } = await testDb();
    await insertPageRow(db, {
      slug: 'about',
      title: 'About us',
      kind: 'static',
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await insertPageRow(db, {
      slug: 'blog-imei',
      title: 'Find your IMEI',
      kind: 'blog',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
      seoDescription: 'Three ways.',
    });
    await insertPageRow(db, {
      slug: 'quiet',
      title: 'Quiet page',
      kind: 'static',
      status: 'noindex',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await insertPageRow(db, { slug: 'wip', title: 'Work in progress', status: 'draft', publishedAt: null });
    await insertLegalRow(db, { type: 'terms', isCurrent: true, effectiveFrom: new Date('2025-01-01T00:00:00Z') });

    const res = await get('/store/v1/pages');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.res.headers['x-total-count']).toBe('3');
    expect(res.body.map((row: { slug: string }) => row.slug)).toEqual(['blog-imei', 'about', 'quiet']);
    expect(res.body[0]).toEqual({
      kind: 'blog',
      slug: 'blog-imei',
      title: 'Find your IMEI',
      seoDescription: 'Three ways.',
      noindex: false,
      publishedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: expect.any(String),
    });
    expect(res.body[2].noindex).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('bodyMd');
    expect(res.body.map((row: { slug: string }) => row.slug)).not.toContain('terms');
  });

  it('filters by kind, searches the title, sorts, and pages with an exact total', async () => {
    const { db } = await testDb();
    for (const [index, title] of ['Zeta', 'Alpha', 'Beta', 'Gamma'].entries()) {
      await insertPageRow(db, {
        slug: title.toLowerCase(),
        title,
        kind: index % 2 === 0 ? 'blog' : 'static',
        publishedAt: new Date(Date.UTC(2026, 9, index + 1)),
      });
    }
    const titles = async (query: string) =>
      (await get(`/store/v1/pages?${query}`)).body.map((row: { title: string }) => row.title);
    // Indexes 0 and 2 are blogs (Zeta, Beta); newest publication first.
    expect(await titles('kind=blog')).toEqual(['Beta', 'Zeta']);
    expect(await titles('kind=static&_sort=title&_order=asc')).toEqual(['Alpha', 'Gamma']);
    expect(await titles('q=ta&_sort=title&_order=asc')).toEqual(['Beta', 'Zeta']);
    expect(await titles('_sort=title&_order=desc')).toEqual(['Zeta', 'Gamma', 'Beta', 'Alpha']);
    expect(await titles('_sort=publishedAt&_order=asc')).toEqual(['Zeta', 'Alpha', 'Beta', 'Gamma']);
    const paged = await get('/store/v1/pages?_sort=title&_order=asc&_start=1&_end=3');
    expect(paged.total).toBe(4);
    expect(paged.body.map((row: { title: string }) => row.title)).toEqual(['Beta', 'Gamma']);
    expect((await get('/store/v1/pages?kind=video')).status).toBe(422);
    expect((await get('/store/v1/pages?locale=en')).status).toBe(422);
    expect((await get('/store/v1/pages?_sort=body')).status).toBe(422);
    expect((await get('/store/v1/pages?_end=101')).status).toBe(422);
  });

  it('keeps the page by slug working next to the list', async () => {
    const { db } = await testDb();
    await insertPageRow(db, { slug: 'about', title: 'About us' });
    expect((await get('/store/v1/pages/about')).body.title).toBe('About us');
  });
});

describe('POST /store/v1/help/:slug/vote', () => {
  // The day limiter lives in Redis and article ids restart after every reset: addresses are random per run so an earlier run's votes
  // (same address, same id) never count against this one.
  const octets = () => Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 250));
  const address = () => `10.${octets().join('.')}`;
  /** A vote from its own address, so the day limiter of one test never meets another's. */
  async function vote(slug: string, helpful: unknown, ip = address()) {
    const res = await t.app.inject({
      method: 'POST',
      url: `/store/v1/help/${slug}/vote`,
      payload: { helpful } as never,
      remoteAddress: ip,
    });
    return { status: res.statusCode, body: res.body === '' ? undefined : JSON.parse(res.body) };
  }
  const counts = async (id: number) => {
    const { db } = await testDb();
    const row = (await db.select().from(s.helpArticles).where(eq(s.helpArticles.id, id)))[0]!;
    return { yes: row.helpfulYes, no: row.helpfulNo, updatedAt: row.updatedAt.getTime() };
  };

  it('counts a yes and a no with 204 and leaves the article updatedAt alone', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { helpfulYes: 4, helpfulNo: 1 });
    const before = await counts(article.id);
    const yes = await vote(String(article.id), true);
    expect(yes.status).toBe(204);
    expect(yes.body).toBeUndefined();
    expect((await vote(`${article.id}-how-long-does-a-carrier-unlock-take`, false)).status).toBe(204);
    expect(await counts(article.id)).toEqual({ yes: 5, no: 2, updatedAt: before.updatedAt });
    const shown = await get(`/store/v1/help/${article.id}`);
    expect(shown.body).toMatchObject({ helpfulYes: 5, helpfulNo: 2 });
  });

  it('counts one vote per visitor address and article per day: a repeat is accepted, ignored and answered the same', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db);
    const other = await insertArticleRow(db, { question: 'Another question' });
    const ip = address();
    expect((await vote(String(article.id), true, ip)).status).toBe(204);
    expect((await vote(String(article.id), true, ip)).status).toBe(204);
    expect((await vote(String(article.id), false, ip)).status).toBe(204);
    expect(await counts(article.id)).toMatchObject({ yes: 1, no: 0 });
    // Another article from the same address, and the same article from another address, still count.
    expect((await vote(String(other.id), false, ip)).status).toBe(204);
    expect((await vote(String(article.id), false, address())).status).toBe(204);
    expect(await counts(other.id)).toMatchObject({ yes: 0, no: 1 });
    expect(await counts(article.id)).toMatchObject({ yes: 1, no: 1 });
  });

  it('answers 404 for an unpublished or unknown article and a slug without an id, and 422 for a body that is not a vote', async () => {
    const { db } = await testDb();
    const draft = await insertArticleRow(db, { isPublished: false });
    expect((await vote(String(draft.id), true)).status).toBe(404);
    expect(await counts(draft.id)).toMatchObject({ yes: 0, no: 0 });
    expect((await vote('999999', true)).status).toBe(404);
    expect((await vote('how-do-i', true)).status).toBe(404);
    const published = await insertArticleRow(db);
    for (const bad of ['yes', 1, null, undefined]) {
      const res = await vote(String(published.id), bad);
      expect(res.status, String(bad)).toBe(422);
    }
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/store/v1/help/${published.id}/vote`,
          payload: {} as never,
          remoteAddress: address(),
        })
      ).statusCode,
    ).toBe(422);
    expect(await counts(published.id)).toMatchObject({ yes: 0, no: 0 });
  });

  it('counts parallel votes from different visitors without losing one', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => vote(String(article.id), index % 3 !== 0, address())),
    );
    expect(results.every((r) => r.status === 204)).toBe(true);
    expect(await counts(article.id)).toMatchObject({ yes: 8, no: 4 });
  });
});
