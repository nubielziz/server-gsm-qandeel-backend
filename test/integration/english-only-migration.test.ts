// Migration 0035, the data step of English only (feature 30, decision 039, plan docs/briefs/30-english-only.md sections 4.3-4.6
// and 9.2): the guard and every data change, on scratch databases whose name ends in `_test` with the guard forced on. Each
// database is filled at 0034 (from a temporary copy of drizzle/) and migrated to the newest file; after the migration every
// assertion goes by id, never by a language column, because migrations 0036-0039 drop those columns and this file must keep
// passing (slices B1, B2, B3 and B5 run it).
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrateDatabase } from '../../src/infra/db/migrate';
import {
  ARABIC_WORD,
  type Filled,
  KEPT_AT,
  ScratchDatabases,
  appliedTags,
  failureOf,
  fillOtherLanguages,
  idsByLanguage,
  idsOf,
  journalEntries,
  poolOn,
  runExport,
} from '../support/english-only';

// CREATE DATABASE and a migration from zero take seconds on an idle machine and far longer when several worktrees run their
// suites at once (test/integration/db-reset.test.ts measured up to 176 s for one file).
setDefaultTimeout(180_000);

const NEWEST = journalEntries().at(-1)!.tag;
const scratch = new ScratchDatabases();
const folders: string[] = [];
const pools: Pool[] = [];

/** A database at 0034 with the rows of case (b), and the ids the template rows of the applied migrations got before the fill. */
async function filledAt0034(): Promise<{ url: string; pool: Pool; filled: Filled }> {
  const db = await scratch.create();
  await migrateDatabase(db.url, scratch.migrationsUpTo('0034_legacy_slugs'));
  const pool = poolOn(db.url);
  pools.push(pool);
  return { url: db.url, pool, filled: await fillOtherLanguages(pool) };
}

/** Runs the export script into a new folder and expects it to succeed. */
async function exportOf(url: string): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'gsm-eo-out-'));
  folders.push(out);
  const run = await runExport(url, ['--out', out]);
  expect(run.code, run.stderr).toBe(0);
}

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  await scratch.dropAll();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** Rows of a table by id, as plain JSON (timestamps as ISO text). */
async function rowsById(pool: Pool, table: string): Promise<Map<number, Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, unknown>>(`select * from ${table} order by id`);
  return new Map(
    (JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>).map((row) => [Number(row.id), row]),
  );
}

describe('a database with content in other languages, filled at 0034 (case b)', () => {
  let url = '';
  let pool: Pool;
  let filled: Filled;
  let templates: { english: number[]; other: number[] };
  let legalBefore: Map<number, Record<string, unknown>>;
  let consentsBefore: Map<number, Record<string, unknown>>;
  let campaignsBefore: Map<number, Record<string, unknown>>;
  let listingIds: number[] = [];

  beforeAll(async () => {
    ({ url, pool, filled } = await filledAt0034());
    templates = await idsByLanguage(pool, 'notification_templates');
    legalBefore = await rowsById(pool, 'legal_documents');
    consentsBefore = await rowsById(pool, 'consent_records');
    campaignsBefore = await rowsById(pool, 'notification_campaigns');
    listingIds = await idsOf(pool, 'service_listings');
  });

  it('gives a new session the forced guard setting (ALTER DATABASE reaches the migrator)', async () => {
    const { rows } = await pool.query<{ value: string }>(
      `select current_setting('gsm.english_only_guard', true) as value`,
    );
    expect(rows[0]?.value).toBe('on');
  });

  it('refuses without an export, names the script and changes nothing', async () => {
    const message = await failureOf(migrateDatabase(url));
    expect(message).toContain('English only (0035): this database holds content the migration deletes');
    expect(message).toContain('Run "bun scripts/english-only-export.ts" first (docs/OPERATIONS.md, release 30).');
    expect((await appliedTags(pool)).at(-1)).toBe('0034_legacy_slugs');
    expect(await idsOf(pool, 'service_listings')).toEqual(listingIds);
    expect(await idsOf(pool, 'notification_templates')).toEqual(
      [...templates.english, ...templates.other].sort((a, b) => a - b),
    );
    expect(await idsOf(pool, 'legacy_slugs')).toEqual([]);
  });

  describe('after the export, the migration to the newest file', () => {
    beforeAll(async () => {
      await exportOf(url);
      await migrateDatabase(url);
    });

    it('applies every file', async () => {
      expect((await appliedTags(pool)).at(-1)).toBe(NEWEST);
    });

    it('deletes every template in another language (those of the applied migrations too) and keeps the English ones', async () => {
      expect(templates.other).toContain(filled.templates.other);
      // migrations 0023, 0025 and 0027 insert 42 default templates in Arabic (fact 7)
      expect(templates.other.length).toBe(43);
      const left = await idsOf(pool, 'notification_templates');
      expect(left).toEqual(expect.arrayContaining(templates.english));
      for (const id of templates.other) expect(left).not.toContain(id);
    });

    it('deletes the listings, pages, help articles and reply templates in another language', async () => {
      expect(await idsOf(pool, 'service_listings')).toEqual(
        [filled.listings.english, filled.listings.englishOff].sort((a, b) => a - b),
      );
      const { pages, help, replies } = filled;
      expect(await idsOf(pool, 'content_pages')).toEqual(
        [pages.englishArCanonical, pages.englishArRoot, pages.englishOther, pages.englishLookalike].sort(
          (a, b) => a - b,
        ),
      );
      expect(await idsOf(pool, 'help_articles')).toEqual([help.english]);
      expect(await idsOf(pool, 'reply_templates')).toEqual([replies.english]);
    });

    it('clears an English canonical address that points at /ar, and only that', async () => {
      const { rows } = await pool.query<{ id: string; canonical_url: string | null }>(
        'select id, canonical_url from content_pages order by id',
      );
      const canonical = new Map(rows.map((row) => [Number(row.id), row.canonical_url]));
      expect(canonical.get(filled.pages.englishArCanonical)).toBeNull();
      expect(canonical.get(filled.pages.englishArRoot)).toBeNull();
      expect(canonical.get(filled.pages.englishOther)).toBe('https://shop.example/en/faq');
      expect(canonical.get(filled.pages.englishLookalike)).toBe('/arabic-tips');
    });

    it('remembers the old addresses no English row uses: services (with the service), live pages, published help articles', async () => {
      const { rows } = await pool.query<{ kind: string; slug: string; service_id: string | null }>(
        'select kind, slug, service_id from legacy_slugs order by kind, slug',
      );
      expect(rows.map((row) => [row.kind, row.slug, row.service_id === null ? null : Number(row.service_id)])).toEqual([
        ['help', String(filled.help.otherPublished), null],
        ['page', 'hakkinda', null],
        ['service', 'eo-bir', filled.services.withEnglish],
        ['service', 'eo-iki', filled.services.onlyOther],
      ]);
    });

    it('retires a legal version a consent references, keeps it as it was otherwise, and deletes the one nobody accepted', async () => {
      const { legal } = filled;
      const after = await rowsById(pool, 'legal_documents');
      expect([...after.keys()]).toEqual(
        [legal.termsEnglish, legal.termsOtherConsented, legal.privacyEnglish, legal.refundOtherOldConsented].sort(
          (a, b) => a - b,
        ),
      );
      const retired = after.get(legal.termsOtherConsented)!;
      const was = legalBefore.get(legal.termsOtherConsented)!;
      expect(was.is_current).toBe(true);
      expect(retired.is_current).toBe(false);
      expect(Date.parse(retired.updated_at as string)).toBeGreaterThan(Date.parse(KEPT_AT));
      const { is_current: _c, updated_at: _u, ...unchanged } = was;
      expect(retired).toMatchObject(unchanged);
      // already out of force before the migration: not touched at all
      for (const id of [legal.refundOtherOldConsented, legal.termsEnglish, legal.privacyEnglish]) {
        expect(legalBefore.get(id), String(id)).toBeDefined();
        expect(after.get(id), String(id)).toEqual(legalBefore.get(id));
      }
      expect(await rowsById(pool, 'consent_records')).toEqual(consentsBefore);
    });

    it('writes one system audit row per legal version kept as history', async () => {
      const { legal } = filled;
      const { rows } = await pool.query<Record<string, unknown>>(
        `select actor_type, actor_id, actor_name, action, entity_id, entity_label, before, after from audit_logs
          where entity_type = 'legal' order by entity_id`,
      );
      expect(rows.map((row): Record<string, unknown> => ({ ...row, entity_id: Number(row.entity_id) }))).toEqual([
        {
          actor_type: 'system',
          actor_id: null,
          actor_name: '',
          action: 'retired legal document (English only)',
          entity_id: legal.termsOtherConsented,
          entity_label: 'terms 3.2',
          before: { isCurrent: true, locale: 'tr' },
          after: { isCurrent: false, locale: 'tr' },
        },
        {
          actor_type: 'system',
          actor_id: null,
          actor_name: '',
          action: 'retired legal document (English only)',
          entity_id: legal.refundOtherOldConsented,
          entity_label: 'refund 2.0',
          before: { isCurrent: false, locale: 'tr' },
          after: { isCurrent: false, locale: 'tr' },
        },
      ]);
    });

    it('removes the customer audience of every campaign for other languages only, whatever its status, and cancels the running ones', async () => {
      const { campaigns } = filled;
      const after = await rowsById(pool, 'notification_campaigns');
      const text = { title: 'Hello', body: 'English body' };
      for (const id of [campaigns.scheduled, campaigns.queued, campaigns.sending]) {
        const row = after.get(id)!;
        expect(row.status, String(id)).toBe('cancelled');
        expect(row.cancelled_at, String(id)).not.toBeNull();
        expect(row.cancelled_by, String(id)).toBeNull();
        expect(row.fanout_cursor, String(id)).toBeNull();
        expect(row.audience, String(id)).not.toHaveProperty('customers');
      }
      expect(campaignsBefore.get(campaigns.sending)!.fanout_cursor).toEqual({ type: 'customer', afterId: 5 });
      expect(after.get(campaigns.scheduled)!.audience).toEqual({ staff: {} });
      // a draft stays a draft; a finished one keeps its status (and a cancelled one its cancel time)
      for (const [id, status] of [
        [campaigns.draft, 'draft'],
        [campaigns.sent, 'sent'],
        [campaigns.failed, 'failed'],
        [campaigns.cancelled, 'cancelled'],
      ] as const) {
        const row = after.get(id)!;
        expect(row.status, status).toBe(status);
        expect(row.audience, status).toEqual({});
        expect(row.fanout_cursor, status).toBeNull();
      }
      expect(after.get(campaigns.cancelled)!.cancelled_at).toBe(campaignsBefore.get(campaigns.cancelled)!.cancelled_at);
      expect(after.get(campaigns.draft)!.cancelled_at).toBeNull();
      for (const id of [
        campaigns.draft,
        campaigns.scheduled,
        campaigns.queued,
        campaigns.sending,
        campaigns.sent,
        campaigns.failed,
        campaigns.cancelled,
      ]) {
        expect(after.get(id)!.content, String(id)).toEqual(text);
        expect(Date.parse(after.get(id)!.updated_at as string), String(id)).toBeGreaterThan(Date.parse(KEPT_AT));
      }
    });

    it('takes only the language filter from a campaign that listed English, and makes every content one title and one body', async () => {
      const { campaigns } = filled;
      const after = await rowsById(pool, 'notification_campaigns');
      expect(after.get(campaigns.withEnglish)).toMatchObject({
        status: 'scheduled',
        audience: { customers: { countries: ['JO'] } },
        content: { title: 'Hello', body: 'English body' },
      });
      expect(after.get(campaigns.textOnly)).toMatchObject({
        status: 'draft',
        audience: { merchants: {} },
        content: { title: 'Hello', body: 'English body' },
      });
      expect(after.get(campaigns.englishOnly)).toMatchObject({
        status: 'draft',
        audience: { customers: { hasAccount: true } },
        content: { title: 'Only English', body: 'Only English body' },
      });
    });

    it('writes one system audit row per campaign that lost its customer audience, with the audience before and after', async () => {
      const { campaigns } = filled;
      const { rows } = await pool.query<Record<string, unknown>>(
        `select actor_type, actor_id, actor_name, action, entity_id, entity_label, before, after from audit_logs
          where entity_type = 'notification_campaign' order by entity_id`,
      );
      const running = new Set<number>([campaigns.scheduled, campaigns.queued, campaigns.sending]);
      const hit = [
        campaigns.draft,
        campaigns.scheduled,
        campaigns.queued,
        campaigns.sending,
        campaigns.sent,
        campaigns.failed,
        campaigns.cancelled,
      ].sort((a, b) => a - b);
      expect(rows.map((row) => Number(row.entity_id))).toEqual(hit);
      for (const row of rows) {
        const id = Number(row.entity_id);
        const was = campaignsBefore.get(id)!;
        const { customers: _gone, ...left } = was.audience as Record<string, unknown>;
        expect(row).toEqual({
          actor_type: 'system',
          actor_id: null,
          actor_name: '',
          action: running.has(id)
            ? 'cancelled campaign (English only)'
            : 'removed the customer audience (English only)',
          entity_id: row.entity_id,
          entity_label: was.name,
          before: { status: was.status, audience: was.audience },
          after: { status: running.has(id) ? 'cancelled' : was.status, audience: left },
        });
      }
    });

    it('leaves the people rows, the categories and the search settings as they were', async () => {
      for (const table of ['customers', 'clients']) {
        const { rows } = await pool.query<{ id: string; updated_at: Date }>(
          `select id, updated_at from ${table} order by id`,
        );
        const ids = table === 'customers' ? filled.customers : filled.clients;
        expect(
          rows.map((row) => Number(row.id)),
          table,
        ).toEqual([ids.english, ids.other]);
        for (const row of rows) expect(row.updated_at.toISOString(), table).toBe(KEPT_AT);
      }
      expect(await idsOf(pool, 'service_categories')).toEqual(
        expect.arrayContaining([filled.categories.withArabicName, filled.categories.plain]),
      );
      // migration 0033 inserts the owner's five synonyms first
      expect(await idsOf(pool, 'search_synonyms')).toEqual(
        expect.arrayContaining([filled.search.synonym, filled.search.englishSynonym]),
      );
      const { rows } = await pool.query<{ query: string }>('select query from search_pins');
      expect(rows.map((row) => row.query)).toEqual([ARABIC_WORD]);
    });
  });
});

describe('an export that is no longer fresh, and a document type with no English version in force (cases c and d)', () => {
  let url = '';
  let pool: Pool;
  let filled: Filled;

  beforeAll(async () => {
    ({ url, pool, filled } = await filledAt0034());
    await exportOf(url);
  });

  const expectNothingChanged = async () => {
    expect((await appliedTags(pool)).at(-1)).toBe('0034_legacy_slugs');
    expect(await idsOf(pool, 'legacy_slugs')).toEqual([]);
    expect(await idsOf(pool, 'service_listings')).toContain(filled.listings.onlyOther);
  };

  it('refuses a row added after the export: "out of date"', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into reply_templates (title, body, locale) values ('Added later', 'Body', 'tr') returning id`,
    );
    const message = await failureOf(migrateDatabase(url));
    expect(message).toContain('English only (0035): the export is out of date');
    await expectNothingChanged();
    await pool.query('delete from reply_templates where id = $1', [rows[0]!.id]);
  });

  it('refuses a row edited after the export with the same counts: "changed after the export"', async () => {
    await pool.query(`update reply_templates set body = 'Edited', updated_at = now() where id = $1`, [
      filled.replies.other,
    ]);
    const message = await failureOf(migrateDatabase(url));
    expect(message).toContain('English only (0035): content changed after the export. Run it again.');
    await expectNothingChanged();
  });

  it('refuses an Arabic category name or an /ar canonical address edited after a fresh export: "changed after the export"', async () => {
    for (const edit of [
      `update service_categories set name_ar = 'EO unlock (ar, edited)', updated_at = now() where id = ${filled.categories.withArabicName}`,
      `update content_pages set canonical_url = '/ar/about-us', updated_at = now() where id = ${filled.pages.englishArCanonical}`,
    ]) {
      await exportOf(url); // fresh again: the earlier edits are older than this export
      await pool.query(edit);
      const message = await failureOf(migrateDatabase(url));
      expect(message, edit).toContain('English only (0035): content changed after the export. Run it again.');
      await expectNothingChanged();
    }
  });

  it('refuses to retire the only version in force of a document type, naming the type', async () => {
    await pool.query(
      `insert into legal_documents (type, version, locale, body_md, is_current) values ('cookies', '1.0', 'tr', 'Text', true)`,
    );
    const message = await failureOf(migrateDatabase(url));
    expect(message).toContain('English only (0035): publish an English version of these documents first: cookies');
    await expectNothingChanged();
  });
});

describe('a fresh database (case a)', () => {
  it('migrates from zero to the newest file in one run, passes the guard with no marker and keeps no template in another language', async () => {
    // The template rows of the applied migrations get the same ids on every fresh database: one run inserts them in order.
    const at0034 = await scratch.create();
    await migrateDatabase(at0034.url, scratch.migrationsUpTo('0034_legacy_slugs'));
    const before = poolOn(at0034.url);
    pools.push(before);
    const templates = await idsByLanguage(before, 'notification_templates');
    expect(templates.other.length).toBe(42);

    const fresh = await scratch.create();
    await migrateDatabase(fresh.url);
    const pool = poolOn(fresh.url);
    pools.push(pool);
    expect((await appliedTags(pool)).at(-1)).toBe(NEWEST);
    const { rows } = await pool.query<{ markers: number }>(
      `select count(*)::int as markers from job_runs where job = 'english_only_export'`,
    );
    expect(rows[0]?.markers).toBe(0);
    const left = await idsOf(pool, 'notification_templates');
    expect(left).toEqual(expect.arrayContaining(templates.english));
    for (const id of templates.other) expect(left).not.toContain(id);
  });
});
