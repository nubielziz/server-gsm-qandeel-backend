// Scratch databases for the English-only data step (feature 30, plan docs/briefs/30-english-only.md section 9.2): each test makes
// its own database (the name ends in `_test`), forces the guard of migration 0035 on with ALTER DATABASE, migrates it to 0034
// from a temporary copy of drizzle/, fills it with rows in other languages by raw SQL, and runs the export script against it
// as a child process. Raw SQL only, never the Drizzle tables: those lose the language columns in migrations 0036-0039, while
// the database is always filled at 0034, where the columns exist.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { MIGRATIONS_FOLDER } from '../../src/infra/db/migrate';
import { TEST_DATABASE_URL } from './db';

const ROOT = join(import.meta.dir, '../..');

/** The test server's connection string with another database name. */
export function serverUrl(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Opens a one-connection pool (end it when done). */
export function poolOn(url: string): Pool {
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on('error', () => undefined);
  return pool;
}

/** Runs one statement on a database of the test server with a pool of its own. */
export async function sqlOn(url: string, text: string): Promise<void> {
  const pool = poolOn(url);
  try {
    await pool.query(text);
  } finally {
    await pool.end();
  }
}

/** The journal of the real migrations folder. */
export function journalEntries(): Array<{ idx: number; tag: string; when: number }> {
  return (
    JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    }
  ).entries;
}

/** The journal tags a database has applied, oldest first. */
export async function appliedTags(pool: Pool): Promise<string[]> {
  const byWhen = new Map(journalEntries().map((entry) => [entry.when, entry.tag]));
  const { rows } = await pool.query<{ created_at: string }>(
    'select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at',
  );
  return rows.map((row) => byWhen.get(Number(row.created_at)) ?? `unknown ${row.created_at}`);
}

/**
 * Scratch databases and migration folders of one test file, dropped by {@link ScratchDatabases.dropAll}.
 *
 * Why: the migration test and the export test need databases at a chosen migration with the guard forced on; the shared test
 * database (`resetDb`) can neither be held at 0034 nor be given the setting.
 */
export class ScratchDatabases {
  private readonly prefix = `gsm_eo_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  private count = 0;
  private readonly names = new Set<string>();
  private readonly folders = new Set<string>();

  /**
   * Creates an empty database whose name ends in `_test` and forces the guard of 0035 on in it.
   *
   * @returns its name and connection string
   */
  async create(): Promise<{ name: string; url: string }> {
    const name = `${this.prefix}_${++this.count}_test`;
    this.names.add(name);
    const admin = serverUrl('postgres');
    await sqlOn(admin, `create database "${name}"`);
    // A test database skips the guard unless this is set (drizzle/0035_english_only_data.sql); a new session reads it.
    await sqlOn(admin, `alter database "${name}" set gsm.english_only_guard = 'on'`);
    return { name, url: serverUrl(name) };
  }

  /**
   * A copy of drizzle/ whose journal ends at `tag`, so a database can be migrated to that point and no further.
   *
   * @param tag the last journal tag to keep, such as `0034_legacy_slugs`
   * @returns the folder to pass to `migrateDatabase(url, folder)`
   */
  migrationsUpTo(tag: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'gsm-eo-drizzle-'));
    this.folders.add(folder);
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const path = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<{ tag: string }> };
    const last = journal.entries.findIndex((entry) => entry.tag === tag);
    if (last < 0) throw new Error(`drizzle/meta/_journal.json has no ${tag}`);
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(path, JSON.stringify(journal, null, 2));
    return folder;
  }

  /** Drops every database of this file (also one whose create finished after a timeout) and removes the folders. */
  async dropAll(): Promise<void> {
    const admin = poolOn(serverUrl('postgres'));
    try {
      const { rows } = await admin.query<{ datname: string }>(
        `select datname from pg_database where datname like '${this.prefix}\\_%'`,
      );
      for (const name of new Set([...this.names, ...rows.map((row) => row.datname)])) {
        await admin.query(`drop database if exists "${name}" with (force)`);
      }
      this.names.clear();
    } finally {
      await admin.end();
    }
    for (const folder of this.folders) rmSync(folder, { recursive: true, force: true });
    this.folders.clear();
  }
}

/** One word in Arabic script, made from its code points (the guard of section 9.4 reads this file). */
export const ARABIC_WORD = String.fromCodePoint(0x0641, 0x0643, 0x0020, 0x0642, 0x0641, 0x0644);

/** A fixed past time for rows whose `updated_at` must stay as it was. */
export const KEPT_AT = '2026-01-02T03:04:05.678Z';

/** The ids of what {@link fillOtherLanguages} wrote, by role in the plan (section 9.2, case b). */
export interface Filled {
  staffId: number;
  services: { withEnglish: number; onlyOther: number; slugTaken: number };
  categories: { withArabicName: number; plain: number };
  listings: { english: number; other: number; onlyOther: number; slugTaken: number; englishOff: number };
  pages: {
    englishArCanonical: number;
    englishArRoot: number;
    englishOther: number;
    englishLookalike: number;
    otherLive: number;
    otherSlugTaken: number;
    otherDraft: number;
  };
  help: { english: number; otherPublished: number; otherHidden: number };
  replies: { english: number; other: number };
  templates: { other: number };
  legal: {
    termsEnglish: number;
    termsOtherConsented: number;
    privacyOtherDraft: number;
    privacyEnglish: number;
    refundOtherOldConsented: number;
  };
  consents: { terms: number; refund: number };
  customers: { english: number; other: number };
  clients: { english: number; other: number };
  checkoutSession: number;
  campaigns: {
    draft: number;
    scheduled: number;
    queued: number;
    sending: number;
    sent: number;
    failed: number;
    cancelled: number;
    withEnglish: number;
    textOnly: number;
    englishOnly: number;
  };
  search: { synonym: number; pin: number; hidden: number; englishSynonym: number };
}

const CONTENT = { en: { title: 'Hello', body: 'English body' }, ar: { title: 'AR title', body: 'AR body' } };
const ENGLISH_CONTENT = { en: { title: 'Only English', body: 'Only English body' } };

/**
 * Fills a database at migration 0034 with a row of each kind the data step of 0035 deletes, keeps or changes.
 *
 * Why: plan section 9.2 (case b): non-English rows in each table of section 4.1; a legal version with a consent and one
 * without; an English and another-language version both in force; a campaign of each fate (a sent, a failed and a cancelled
 * one for `['ar']` among them); a listing whose service has no English listing; a switched-on listing whose service has a
 * switched-off English one; a page with an `/ar` canonical. The "not English" rows use `tr`; `ar` only where the stored value
 * is literally that (the client CHECK allows `en` and `ar` only, the campaign key `content.ar`, a `locales` list, an `/ar`
 * address).
 *
 * @param pool a pool on the scratch database
 * @returns the ids of the rows written
 */
export async function fillOtherLanguages(pool: Pool): Promise<Filled> {
  const id = async (text: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(`${text} returning id`, params);
    return Number(rows[0]!.id);
  };
  const role = await id(`insert into roles (name) values ('EO owner')`);
  const staffId = await id(
    `insert into staff_users (email, name, role_id) values ('eo-staff@example.test', 'EO staff', $1)`,
    [role],
  );
  const group = await id(`insert into client_groups (name) values ('EO group')`);
  await pool.query(`insert into currencies (code, name) values ('USD', 'US dollar') on conflict do nothing`);

  const withArabicName = await id(
    `insert into service_categories (name, name_ar, type) values ('EO unlock', 'EO unlock (ar)', 'imei')`,
  );
  const plain = await id(`insert into service_categories (name, type) values ('EO server', 'imei')`);
  const service = (code: string, category: number) =>
    id(
      `insert into services (category_id, type, name, fulfillment, base_price, code, sla_minutes)
       values ($1, 'imei', $2, 'manual', 10, $2, 60)`,
      [category, code],
    );
  const services = {
    withEnglish: await service('EO-1', withArabicName),
    onlyOther: await service('EO-2', withArabicName),
    slugTaken: await service('EO-3', plain),
  };
  const listing = (serviceId: number, locale: string, slug: string, listed = true) =>
    id(
      `insert into service_listings (service_id, locale, slug, public_title, is_listed, listed_at)
       values ($1, $2, $3, $4, $5, case when $5 then now() end)`,
      [serviceId, locale, slug, `Listing ${slug} (${locale})`, listed],
    );
  const listings = {
    english: await listing(services.withEnglish, 'en', 'eo-one'),
    other: await listing(services.withEnglish, 'tr', 'eo-bir'),
    onlyOther: await listing(services.onlyOther, 'tr', 'eo-iki'),
    slugTaken: await listing(services.slugTaken, 'tr', 'eo-one'),
    // EO-3 is buyable today only through its `tr` listing: its English listing is switched off (review B0+B1)
    englishOff: await listing(services.slugTaken, 'en', 'eo-uc', false),
  };

  const page = (slug: string, locale: string, status: string, canonical: string | null) =>
    id(
      `insert into content_pages (kind, slug, locale, title, body_md, status, canonical_url, published_at, author_id)
       values ('static', $1, $2, $3, 'Body', $4, $5, now(), $6)`,
      [slug, locale, `Page ${slug} (${locale})`, status, canonical, staffId],
    );
  const pages = {
    englishArCanonical: await page('about', 'en', 'published', '/ar/about'),
    englishArRoot: await page('contact', 'en', 'published', 'https://shop.example/ar'),
    englishOther: await page('faq', 'en', 'published', 'https://shop.example/en/faq'),
    englishLookalike: await page('tips', 'en', 'published', '/arabic-tips'),
    otherLive: await page('hakkinda', 'tr', 'published', null),
    otherSlugTaken: await page('about', 'tr', 'noindex', null),
    otherDraft: await page('taslak', 'tr', 'draft', null),
  };

  const article = (locale: string, published: boolean) =>
    id(
      `insert into help_articles (category, question, answer_md, locale, is_published, service_id)
       values ('orders', $1, 'Answer', $2, $3, $4)`,
      [`Question (${locale}, ${published})`, locale, published, services.withEnglish],
    );
  const help = {
    english: await article('en', true),
    otherPublished: await article('tr', true),
    otherHidden: await article('tr', false),
  };

  const reply = (locale: string) =>
    id(`insert into reply_templates (title, body, locale, created_by) values ($1, 'Reply body', $2, $3)`, [
      `Reply ${locale}`,
      locale,
      staffId,
    ]);
  const replies = { english: await reply('en'), other: await reply('tr') };

  const templates = {
    other: await id(
      `insert into notification_templates (event, channel, audience, locale, subject, body, created_at, updated_at)
       values ('eo.test', 'email', 'customer', 'tr', 'Konu', 'Govde', '2026-03-01T00:00:00Z', '2026-03-05T00:00:00Z')`,
    ),
  };

  const legalDocument = (type: string, version: string, locale: string, current: boolean, updatedAt: string | null) =>
    id(
      `insert into legal_documents (type, version, locale, body_md, effective_from, is_current, requires_reacceptance, created_by, updated_at)
       values ($1, $2, $3, $4, '2026-02-01T00:00:00Z', $5, true, $6, coalesce($7::timestamptz, now()))`,
      [type, version, locale, `Text of ${type} ${version} (${locale})`, current, staffId, updatedAt],
    );
  const legal = {
    termsEnglish: await legalDocument('terms', '3.2', 'en', true, null),
    termsOtherConsented: await legalDocument('terms', '3.2', 'tr', true, KEPT_AT),
    privacyOtherDraft: await legalDocument('privacy', '1.0', 'tr', false, null),
    privacyEnglish: await legalDocument('privacy', '1.0', 'en', true, null),
    refundOtherOldConsented: await legalDocument('refund', '2.0', 'tr', false, KEPT_AT),
  };

  const customer = (email: string, locale: string) =>
    id(`insert into customers (email, name, locale, created_at, updated_at) values ($1, 'EO customer', $2, $3, $3)`, [
      email,
      locale,
      KEPT_AT,
    ]);
  const customers = {
    english: await customer('eo-en@example.test', 'en'),
    other: await customer('eo-tr@example.test', 'tr'),
  };
  const client = (username: string, locale: string) =>
    id(
      `insert into clients (username, email, name, group_id, referral_code, locale, created_at, updated_at)
       values ($1, $2, 'EO merchant', $3, $4, $5, $6, $6)`,
      [username, `${username}@example.test`, group, `REF-${username}`, locale, KEPT_AT],
    );
  const clients = { english: await client('eo-en', 'en'), other: await client('eo-ar', 'ar') };

  const consent = (documentId: number, purpose: string) =>
    id(
      `insert into consent_records (subject_type, subject_id, legal_document_id, purpose, granted, ip)
       values ('customer', $1, $2, $3, true, '127.0.0.1')`,
      [customers.other, documentId, purpose],
    );
  const consents = {
    terms: await consent(legal.termsOtherConsented, 'terms'),
    refund: await consent(legal.refundOtherOldConsented, 'refund_policy'),
  };

  const checkoutSession = await id(
    `insert into checkout_sessions (token, email, service_id, currency, net_amount, gross_amount, expires_at)
     values ('eo-token', 'eo-buyer@example.test', $1, 'USD', 10, 10, now() + interval '1 hour')`,
    [services.onlyOther],
  );

  /** One campaign; `extra` is one more column and the SQL of its value. */
  const campaign = (name: string, status: string, audience: object, content: object, extra?: [string, string]) =>
    id(
      `insert into notification_campaigns
         (name, purpose, channels, audience, content, status, created_by, created_at, updated_at${extra ? `, ${extra[0]}` : ''})
       values ($1, 'marketing', '{in_app}', $2, $3, $4, $5, $6, $6${extra ? `, ${extra[1]}` : ''})`,
      [name, JSON.stringify(audience), JSON.stringify(content), status, staffId, KEPT_AT],
    );
  const arabicReaders = { customers: { locales: ['ar'] } };
  const tomorrow: [string, string] = ['scheduled_at', `now() + interval '1 day'`];
  const campaigns = {
    draft: await campaign('EO draft for ar', 'draft', arabicReaders, CONTENT),
    scheduled: await campaign('EO scheduled for ar', 'scheduled', { ...arabicReaders, staff: {} }, CONTENT, tomorrow),
    queued: await campaign('EO queued for ar', 'queued', arabicReaders, CONTENT, ['queued_at', 'now()']),
    sending: await campaign('EO sending for ar', 'sending', arabicReaders, CONTENT, [
      'fanout_cursor',
      `'{"type":"customer","afterId":5}'::jsonb`,
    ]),
    sent: await campaign('EO sent for ar', 'sent', arabicReaders, CONTENT, ['finished_at', 'now()']),
    failed: await campaign('EO failed for ar', 'failed', arabicReaders, CONTENT, ['error', `'EO failure'`]),
    cancelled: await campaign('EO cancelled for ar', 'cancelled', arabicReaders, CONTENT, [
      'cancelled_at',
      `'2026-02-01T00:00:00Z'`,
    ]),
    withEnglish: await campaign(
      'EO scheduled for en and ar',
      'scheduled',
      { customers: { locales: ['en', 'ar'], countries: ['JO'] } },
      CONTENT,
      tomorrow,
    ),
    textOnly: await campaign('EO text only', 'draft', { merchants: {} }, CONTENT),
    englishOnly: await campaign('EO English only', 'draft', { customers: { hasAccount: true } }, ENGLISH_CONTENT),
  };

  const search = {
    synonym: await id(`insert into search_synonyms (kind, terms) values ('multi', $1)`, [[ARABIC_WORD, 'unlock']]),
    pin: await id(`insert into search_pins (query, match) values ($1, 'exact')`, [ARABIC_WORD]),
    hidden: await id(`insert into search_hidden_terms (term) values ($1)`, [ARABIC_WORD]),
    englishSynonym: await id(`insert into search_synonyms (kind, terms) values ('multi', $1)`, [
      ['frp', 'google lock'],
    ]),
  };

  return {
    staffId,
    services,
    categories: { withArabicName, plain },
    listings,
    pages,
    help,
    replies,
    templates,
    legal,
    consents,
    customers,
    clients,
    checkoutSession,
    campaigns,
    search,
  };
}

/** The ids of a table's rows by language, read at 0034 (where the column exists). */
export async function idsByLanguage(pool: Pool, table: string): Promise<{ english: number[]; other: number[] }> {
  const { rows } = await pool.query<{ id: string; locale: string }>(`select id, locale from ${table} order by id`);
  return {
    english: rows.filter((row) => row.locale === 'en').map((row) => Number(row.id)),
    other: rows.filter((row) => row.locale !== 'en').map((row) => Number(row.id)),
  };
}

/** The ids a table holds now. */
export async function idsOf(pool: Pool, table: string): Promise<number[]> {
  const { rows } = await pool.query<{ id: string }>(`select id from ${table} order by id`);
  return rows.map((row) => Number(row.id));
}

/** The guard's expression of migration 0035 (`live := …`), as it stands in the file. */
export function guardExpression(): string {
  const text = readFileSync(join(MIGRATIONS_FOLDER, '0035_english_only_data.sql'), 'utf8');
  const start = text.indexOf('live := ') + 'live := '.length;
  return text.slice(start, text.indexOf(';', start));
}

/** SQL without comments and with single spaces, to compare two texts of one expression. */
export const normaliseSql = (text: string): string =>
  text
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();

/** What a run of the export script printed and returned. */
export interface ExportRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `bun scripts/english-only-export.ts` against a database, as the lead runs it: a child process with only the database
 * variable set (no env file).
 *
 * @param url the scratch database
 * @param args the script's arguments
 * @returns the exit code and the output
 */
export async function runExport(url: string, args: string[]): Promise<ExportRun> {
  const child = Bun.spawn([process.execPath, '--no-env-file', join('scripts', 'english-only-export.ts'), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), NODE_ENV: 'test', DATABASE_URL_TEST: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * The messages of a failed promise and of every error it wraps (Drizzle wraps the Postgres error as `cause`).
 *
 * @param work a migration expected to fail
 * @returns the messages, joined
 * @throws {Error} when the promise resolves
 */
export async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    }
    return messages.join('\n');
  }
  throw new Error('Expected the migration to fail, but it succeeded.');
}
