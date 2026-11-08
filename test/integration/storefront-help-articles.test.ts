// Integration tests of the help article routes (feature 15): list with the publish, topic and language filters and search, show,
// create (last in the order, no votes), change and the publish switch (PATCH isPublished under storefront:update), audit and permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertArticleRow } from '../support/storefront';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
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

describe('GET /admin/help-articles', () => {
  it('lists the full rows in the staff order with the votes', async () => {
    const { db } = await testDb();
    await insertArticleRow(db, { question: 'Second?', sort: 2, helpfulYes: 5, helpfulNo: 1 });
    await insertArticleRow(db, { question: 'First?', sort: 1, answerMd: 'The **full** answer.' });
    const res = await admin.get('/admin/help-articles');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((a: { question: string }) => a.question)).toEqual(['First?', 'Second?']);
    expect(res.body[0]).toMatchObject({
      answerMd: 'The **full** answer.',
      category: 'Orders',
      locale: 'en',
      isPublished: true,
      helpfulYes: 0,
      helpfulNo: 0,
      sort: 1,
    });
    expect(res.body[1]).toMatchObject({ helpfulYes: 5, helpfulNo: 1 });
  });

  it('filters by isPublished, topic and language, counts with _start=0&_end=1, and searches question and topic', async () => {
    const { db } = await testDb();
    await insertArticleRow(db, { question: 'Where is my order?', category: 'Orders' });
    await insertArticleRow(db, { question: 'Why was I charged VAT?', category: 'Payments', isPublished: false });
    await insertArticleRow(db, { question: 'كيف أدفع؟', category: 'Payments', locale: 'ar' });
    expect((await admin.get('/admin/help-articles?isPublished=true&_start=0&_end=1')).total).toBe(2);
    expect((await admin.get('/admin/help-articles?isPublished=false&_start=0&_end=1')).total).toBe(1);
    expect((await admin.get('/admin/help-articles?category=Payments')).total).toBe(2);
    expect((await admin.get('/admin/help-articles?locale=ar')).total).toBe(1);
    expect((await admin.get('/admin/help-articles?q=vat')).total).toBe(1);
    expect((await admin.get('/admin/help-articles?q=payments')).total).toBe(2);
    expect((await admin.get('/admin/help-articles?_sort=question&_order=asc')).status).toBe(200);
    expect((await admin.get('/admin/help-articles?_sort=answerMd')).status).toBe(422);
  });

  it('needs storefront:read', async () => {
    const other = await adminWith(t, ['legal:*']);
    expect((await other.get('/admin/help-articles')).status).toBe(403);
  });
});

describe('GET /admin/help-articles/:id', () => {
  it('shows one article and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db);
    expect((await admin.get(`/admin/help-articles/${article.id}`)).body).toMatchObject({ id: article.id });
    expect((await admin.get('/admin/help-articles/999999')).status).toBe(404);
  });
});

describe('POST /admin/help-articles', () => {
  it('creates an unpublished article last in the order with no votes, keeps the answer as typed and audits it', async () => {
    const { db } = await testDb();
    await insertArticleRow(db, { sort: 7 });
    const answer = 'Dial `*#06#`.\n\n  - keep the spaces';
    const res = await admin.post('/admin/help-articles', {
      category: ' IMEI ',
      question: ' How do I find my IMEI? ',
      answerMd: answer,
      locale: 'en',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      category: 'IMEI',
      question: 'How do I find my IMEI?',
      answerMd: answer,
      locale: 'en',
      isPublished: false,
      helpfulYes: 0,
      helpfulNo: 0,
      sort: 8,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created help article',
      entityType: 'help_article',
      entityId: res.body.id,
      entityLabel: 'How do I find my IMEI?',
    });
    const published = await admin.post('/admin/help-articles', {
      category: 'IMEI',
      question: 'Q2',
      answerMd: 'A2',
      locale: 'en',
      isPublished: true,
    });
    expect(published.body).toMatchObject({ isPublished: true, sort: 9 });
  });

  it('puts every parallel create at the end and loses none of them', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        admin.post('/admin/help-articles', { category: 'Orders', question: `Q${i}`, answerMd: 'A', locale: 'en' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    // The sort is not unique by design (staff may reorder), and two creates in the same instant may pick the same place, so
    // only "at or past the end of an empty list" and "four distinct articles" are promised.
    expect(results.every((r) => r.body.sort >= 1)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(4);
    expect((await admin.get('/admin/help-articles?_start=0&_end=10')).total).toBe(4);
  });

  it('refuses a blank topic, question and answer, and an unknown language, on the field', async () => {
    const res = await admin.post('/admin/help-articles', {
      category: ' ',
      question: '',
      answerMd: '   ',
      locale: 'de',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'answerMd',
      'category',
      'locale',
      'question',
    ]);
  });

  it('needs storefront:create', async () => {
    const reader = await adminWith(t, ['storefront:read', 'storefront:update']);
    expect(
      (await reader.post('/admin/help-articles', { category: 'a', question: 'b', answerMd: 'c', locale: 'en' })).status,
    ).toBe(403);
  });
});

describe('PATCH /admin/help-articles/:id', () => {
  it('changes the fields sent and audits an edit', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { question: 'Old?' });
    const res = await admin.patch(`/admin/help-articles/${article.id}`, { question: ' New? ', answerMd: 'New answer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ question: 'New?', answerMd: 'New answer', isPublished: true });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'edited help article',
      entityType: 'help_article',
      entityId: article.id,
      entityLabel: 'New?',
    });
    expect(audit?.before).toMatchObject({ question: 'Old?' });
  });

  it('switches the publish state with only isPublished (storefront:update) and audits the demo phrases', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { isPublished: false, question: 'Where is my order?' });
    const switcher = await adminWith(t, ['storefront:update']);
    expect((await switcher.patch(`/admin/help-articles/${article.id}`, { isPublished: true })).body.isPublished).toBe(
      true,
    );
    expect((await admin.patch(`/admin/help-articles/${article.id}`, { isPublished: false })).body.isPublished).toBe(
      false,
    );
    const audit = await auditRows();
    expect(audit.map((a) => [a.action, a.entityType, a.entityLabel])).toEqual([
      ['published help article', 'help_article', 'Where is my order?'],
      ['unpublished help article', 'help_article', 'Where is my order?'],
    ]);
    expect(audit[0]?.before).toEqual({ isPublished: false });
    expect(audit[0]?.after).toEqual({ isPublished: true });
  });

  it('writes an edit entry and a switch entry when one request does both', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db, { isPublished: false });
    await admin.patch(`/admin/help-articles/${article.id}`, { answerMd: 'Better', isPublished: true });
    expect((await auditRows()).map((a) => a.action)).toEqual(['edited help article', 'published help article']);
  });

  it('refuses an empty topic, question or answer, an empty body and an unknown id', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db);
    for (const field of ['category', 'question', 'answerMd']) {
      const res = await admin.patch(`/admin/help-articles/${article.id}`, { [field]: '  ' });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe(field);
    }
    expect((await admin.patch(`/admin/help-articles/${article.id}`, {})).status).toBe(422);
    expect((await admin.patch('/admin/help-articles/999999', { isPublished: true })).status).toBe(404);
  });

  it('needs storefront:update', async () => {
    const { db } = await testDb();
    const article = await insertArticleRow(db);
    const reader = await adminWith(t, ['storefront:read', 'storefront:publish']);
    expect((await reader.patch(`/admin/help-articles/${article.id}`, { isPublished: false })).status).toBe(403);
  });
});
