// The export before migration 0035 (scripts/english-only-export.ts; feature 30, English only, decision 039, plan
// docs/briefs/30-english-only.md sections 4.2 and 9.2), run as the lead runs it: a child process with only the database variable
// set. The database it exports is always a scratch one at 0034 (filled by raw SQL); the level cases use databases below 0033
// and past 0035.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import { COUNTS_SQL, COUNT_KEYS, type ExportFile, TYPE_PARSERS } from '../../scripts/english-only-export';
import {
  type Filled,
  ScratchDatabases,
  fillOtherLanguages,
  guardExpression,
  normaliseSql,
  poolOn,
  runExport,
} from '../support/english-only';

// CREATE DATABASE and a migration from zero take seconds on an idle machine and far longer when several worktrees run their
// suites at once (test/tooling/db-reset.test.ts measured up to 176 s for one file).
setDefaultTimeout(180_000);

const scratch = new ScratchDatabases();
const folders: string[] = [];
const pools: Pool[] = [];

/** A new empty folder for one run. */
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'gsm-eo-out-'));
  folders.push(path);
  return path;
}

const exportFiles = (path: string) => readdirSync(path).filter((name) => name.startsWith('english-only-'));

/** The markers of a database: the job_runs rows of the export. */
async function markers(pool: Pool): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `select id, job, trigger, status, started_at, processed, result from job_runs where job = 'english_only_export' order by id`,
  );
  return rows;
}

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  await scratch.dropAll();
  for (const path of folders) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
});

describe('a database at 0034 with content in other languages', () => {
  let url = '';
  let name = '';
  let pool: Pool;
  let filled: Filled;
  let out = '';
  let file: ExportFile;
  let path = '';
  let stdout = '';

  beforeAll(async () => {
    const db = await scratch.create();
    ({ url, name } = db);
    await migrateDatabase(url, scratch.migrationsUpTo('0034_legacy_slugs'));
    pool = poolOn(url);
    pools.push(pool);
    filled = await fillOtherLanguages(pool);
  });

  it('--check prints the report and writes nothing: no file, no marker', async () => {
    const out = folder();
    const run = await runExport(url, ['--out', out, '--check']);
    expect(run.code, run.stderr).toBe(0);
    expect(exportFiles(out)).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
    expect(await markers(pool)).toEqual([]);
    expect(run.stdout).toContain('Check only:');
    expect(run.stdout).toContain(
      `#${filled.services.onlyOther} EO-2 (listed true, 0 orders, 1 open checkout sessions)`,
    );
  });

  it('writes one file (mode 0600) and one marker, and says where', async () => {
    out = folder();
    const run = await runExport(url, ['--out', out]);
    expect(run.code, run.stderr).toBe(0);
    stdout = run.stdout;
    const names = exportFiles(out);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^english-only-${name}-\\d{8}T\\d{6}Z\\.json$`));
    expect(readdirSync(out)).toEqual(names);
    path = join(out, names[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    file = JSON.parse(readFileSync(path, 'utf8')) as ExportFile;
    expect(stdout).toContain(`Wrote ${path}`);
  });

  it('keeps its keys in the fixed order and names the database, the level and the snapshot', () => {
    expect(Object.keys(file)).toEqual([
      'format',
      'feature',
      'database',
      'exportedAt',
      'migrations',
      'counts',
      'deleted',
      'changed',
      'report',
      'howToRestore',
    ]);
    expect(file).toMatchObject({ format: 1, feature: '30-english-only', database: name });
    expect(file.migrations).toEqual({ latest: '0034_legacy_slugs', applied: 35 });
    expect(path.endsWith(`${file.exportedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`)).toBe(true);
    expect(Object.keys(file.deleted)).toEqual([
      'notification_templates',
      'service_listings',
      'content_pages',
      'help_articles',
      'reply_templates',
      'legal_documents',
    ]);
    expect(Object.keys(file.changed)).toEqual([
      'customers.locale',
      'clients.locale',
      'service_categories.name_ar',
      'notification_campaigns',
      'content_pages.canonical_url',
      'legal_documents_retired',
    ]);
    expect(file.howToRestore.join(' ')).toContain('After migration 0036');
  });

  it("has exactly the guard's eleven counts as JSON integers, equal to the guard's expression on the same data", async () => {
    expect(Object.keys(file.counts)).toEqual([...COUNT_KEYS]);
    for (const key of COUNT_KEYS) expect(Number.isInteger(file.counts[key]), key).toBe(true);
    // the script's query is the guard's text, and the guard's own expression gives the same object
    expect(normaliseSql(COUNTS_SQL)).toBe(normaliseSql(`SELECT ${guardExpression()} AS counts`));
    const { rows } = await pool.query<{ live: Record<string, unknown> }>(`SELECT ${guardExpression()} AS live`);
    expect(rows[0]!.live).toEqual(file.counts);
    expect(file.counts).toEqual({
      notification_templates: 43,
      service_listings: 3,
      content_pages: 3,
      help_articles: 2,
      reply_templates: 1,
      legal_documents: 3,
      customers: 1,
      clients: 1,
      service_categories: 1,
      notification_campaigns: 9,
      canonical_urls: 2,
    });
  });

  it('holds every column of every row the migration deletes', async () => {
    const reader = new Pool({ connectionString: url, max: 1, types: TYPE_PARSERS });
    reader.on('error', () => undefined);
    try {
      const read = async (text: string) =>
        JSON.parse(JSON.stringify((await reader.query(text)).rows)) as Array<Record<string, unknown>>;
      for (const table of [
        'notification_templates',
        'service_listings',
        'content_pages',
        'help_articles',
        'reply_templates',
      ]) {
        const rows = await read(`select * from ${table} where locale <> 'en' order by id`);
        expect(rows.length, table).toBeGreaterThan(0);
        expect(file.deleted[table as keyof ExportFile['deleted']], table).toEqual(rows);
      }
      const { legal } = filled;
      const columns = await read(`select * from legal_documents where id = ${legal.privacyOtherDraft}`);
      expect(file.deleted.legal_documents).toEqual([{ ...columns[0], fate: 'deleted' }]);
      const retired = await read(
        `select * from legal_documents where id in (${legal.termsOtherConsented}, ${legal.refundOtherOldConsented}) order by id`,
      );
      expect(file.changed.legal_documents_retired).toEqual(
        retired.map((row) => ({ ...row, fate: 'retired', consents: 1 })),
      );
      // every column of a changed campaign (a cancelled one also loses its fan-out cursor), with its fate
      const campaigns = await read(
        `select * from notification_campaigns where content ? 'ar' or audience #> '{customers,locales}' is not null order by id`,
      );
      expect(campaigns).toHaveLength(9);
      expect(file.changed.notification_campaigns).toEqual(
        campaigns.map((row) => ({ ...row, fate: expect.any(String) })),
      );
    } finally {
      await reader.end();
    }
  });

  it('holds the old value of every column the migrations change or drop', () => {
    const { customers, clients, categories, pages } = filled;
    expect(file.changed['customers.locale']).toEqual([{ id: customers.other, locale: 'tr' }]);
    expect(file.changed['clients.locale']).toEqual([{ id: clients.other, locale: 'ar' }]);
    expect(file.changed['service_categories.name_ar']).toEqual([
      { id: categories.withArabicName, name: 'EO unlock', name_ar: 'EO unlock (ar)' },
    ]);
    expect(file.changed['content_pages.canonical_url']).toEqual([
      { id: pages.englishArCanonical, slug: 'about', canonical_url: '/ar/about' },
      { id: pages.englishArRoot, slug: 'contact', canonical_url: 'https://shop.example/ar' },
    ]);
  });

  it('holds each changed campaign with its audience, its content and its fate', () => {
    const { campaigns } = filled;
    const fates = Object.fromEntries(file.changed.notification_campaigns.map((row) => [row.id as number, row.fate]));
    expect(fates).toEqual({
      [campaigns.draft]: 'audience_removed',
      [campaigns.scheduled]: 'cancelled',
      [campaigns.queued]: 'cancelled',
      [campaigns.sending]: 'cancelled',
      [campaigns.sent]: 'audience_removed_finished',
      [campaigns.failed]: 'audience_removed_finished',
      [campaigns.cancelled]: 'audience_removed_finished',
      [campaigns.withEnglish]: 'filter_removed',
      [campaigns.textOnly]: 'text_only',
    });
    expect(file.changed.notification_campaigns.find((row) => row.id === campaigns.scheduled)).toMatchObject({
      id: campaigns.scheduled,
      name: 'EO scheduled for ar',
      status: 'scheduled',
      audience: { customers: { locales: ['ar'] }, staff: {} },
      content: { en: { title: 'Hello', body: 'English body' }, ar: { title: 'AR title', body: 'AR body' } },
      fate: 'cancelled',
    });
    expect(file.changed.notification_campaigns.find((row) => row.id === campaigns.sending)).toMatchObject({
      status: 'sending',
      fanout_cursor: { type: 'customer', afterId: 5 },
      fate: 'cancelled',
    });
  });

  it('reports what the lead must read before anything is deleted', () => {
    const { report } = file;
    // EO-2 has no English listing; EO-3 has one, switched off, so only its `tr` listing makes it buyable today: both lose it
    expect(report.servicesListedOnlyInAnotherLanguage).toEqual([
      { serviceId: filled.services.onlyOther, name: 'EO-2', listed: true, orders: 0, openCheckoutSessions: 1 },
      { serviceId: filled.services.slugTaken, name: 'EO-3', listed: true, orders: 0, openCheckoutSessions: 0 },
    ]);
    expect(report.templatesWithoutEnglish).toContainEqual({
      event: 'eo.test',
      channel: 'email',
      audience: 'customer',
      locales: ['tr'],
    });
    expect(report.pagesWithoutEnglish.map((row) => row.id)).toEqual([
      filled.pages.otherLive,
      filled.pages.otherSlugTaken,
    ]);
    expect(report.helpArticlesWithoutEnglish.map((row) => row.id)).toEqual([filled.help.otherPublished]);
    expect(report.legalTypesWithoutEnglishInForce).toEqual([]);
    expect(report.templatesEditedByStaff.map((row) => row.id)).toContain(filled.templates.other);
    expect(report.campaignsByFate.cancelled.map((row) => row.id)).toEqual([
      filled.campaigns.scheduled,
      filled.campaigns.queued,
      filled.campaigns.sending,
    ]);
    expect(report.campaignsByFate.audience_removed_finished.map((row) => row.status)).toEqual([
      'sent',
      'failed',
      'cancelled',
    ]);
    expect(report.searchSettingsInArabicScript.synonyms.map((row) => row.id)).toEqual([filled.search.synonym]);
    expect(report.searchSettingsInArabicScript.pins.map((row) => row.id)).toEqual([filled.search.pin]);
    expect(report.searchSettingsInArabicScript.hiddenTerms.map((row) => row.id)).toEqual([filled.search.hidden]);
    expect(report.datedAfterExport).toEqual([]);
    expect(report.byLanguage).toContainEqual({ table: 'service_listings', locale: 'tr', rows: 3 });
    expect(report.byLanguage).toContainEqual({ table: 'service_listings', locale: 'en', rows: 2 });
    expect(stdout).toContain('Campaigns, audience_removed_finished:');
  });

  it("writes the marker the guard reads: the snapshot time, the rows written, the file's name, hash and counts", async () => {
    const [marker, ...more] = await markers(pool);
    expect(more).toEqual([]);
    const rows =
      Object.values(file.deleted).reduce((sum, list) => sum + list.length, 0) +
      Object.values(file.changed).reduce((sum, list) => sum + list.length, 0);
    expect(marker).toMatchObject({
      job: 'english_only_export',
      trigger: 'manual',
      status: 'succeeded',
      processed: rows,
    });
    expect((marker!.started_at as Date).toISOString()).toBe(file.exportedAt);
    expect(marker!.result).toEqual({
      file: path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      counts: file.counts,
    });
  });

  it('writes a second file and a second marker on a second run', async () => {
    // The file name has the second of the snapshot, taken from the database's clock: wait until that clock is in a later
    // second. A sleep on this process's clock is not enough: under load the machine's wall clock can be set back a little.
    const second = `date_trunc('second', '${file.exportedAt}'::timestamptz)`;
    await pool.query(
      `DO $$ BEGIN WHILE date_trunc('second', clock_timestamp()) <= ${second} LOOP PERFORM pg_sleep(0.05); END LOOP; END $$`,
    );
    const run = await runExport(url, ['--out', out]);
    expect(run.code, run.stderr).toBe(0);
    expect(exportFiles(out)).toHaveLength(2);
    expect(await markers(pool)).toHaveLength(2);
  });

  it('refuses a missing --out, a folder that does not exist and one it cannot write: exit 1, no file, no marker', async () => {
    const before = (await markers(pool)).length;
    const missing = await runExport(url, []);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('--out is required');
    const gone = join(folder(), 'not-there');
    const absent = await runExport(url, ['--out', gone]);
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain(`The folder ${gone} does not exist`);
    expect(existsSync(gone)).toBe(false);
    if (process.getuid?.() !== 0) {
      const locked = folder();
      chmodSync(locked, 0o500);
      const refused = await runExport(url, ['--out', locked]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`The folder ${locked} cannot be written`);
      expect(readdirSync(locked)).toEqual([]);
    }
    const plainFile = join(folder(), 'a-file');
    writeFileSync(plainFile, 'x');
    expect((await runExport(url, ['--out', plainFile])).code).toBe(1);
    expect((await markers(pool)).length).toBe(before);
  });
});

describe('the level of the database', () => {
  it('exits 0 with "nothing to export" and writes no marker when nothing is in another language', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url, scratch.migrationsUpTo('0034_legacy_slugs'));
    const pool = poolOn(db.url);
    pools.push(pool);
    // the default templates in Arabic that migrations 0023, 0025 and 0027 inserted
    await pool.query(`delete from notification_templates where locale <> 'en'`);
    const out = folder();
    const run = await runExport(db.url, ['--out', out]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Nothing to export');
    expect(readdirSync(out)).toEqual([]);
    expect(await markers(pool)).toEqual([]);
  });

  it('exits 0 with "nothing to export" on a database with no migrations', async () => {
    const db = await scratch.create();
    const run = await runExport(db.url, ['--out', folder()]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Nothing to export: this database has no migrations.');
  });

  it('exits 3 below 0033 ("upgrade this database to the previous release first")', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url, scratch.migrationsUpTo('0032_support_reply_link'));
    const out = folder();
    const run = await runExport(db.url, ['--out', out]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('upgrade this database to the previous release first');
    expect(readdirSync(out)).toEqual([]);
  });

  it('exits 3 past 0035 ("already migrated")', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url);
    const out = folder();
    const run = await runExport(db.url, ['--out', out]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('already migrated');
    expect(readdirSync(out)).toEqual([]);
  });

  it('exports a database at 0033 too (the previous release)', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url, scratch.migrationsUpTo('0033_search'));
    const run = await runExport(db.url, ['--out', folder(), '--check']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('at 0033_search');
  });
});
