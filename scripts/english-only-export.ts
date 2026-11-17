// `bun scripts/english-only-export.ts --out <dir> [--check]`: before migration 0035 (feature 30, English only, decision 039), writes
// one JSON file per database with every row and value that migrations 0035-0039 delete or change, reads it back, and only then
// writes the marker the guard of 0035 looks for (plan docs/briefs/30-english-only.md section 4.2). `--check` prints the report
// and writes nothing. The runbook is docs/OPERATIONS.md, "Release 30".
//
// It imports only `pg` and Node built-ins (no src/**, no scripts/lib/**): the production image runs it through the `migrate`
// service without the rest of the configuration, and the image's verify stage imports it without running it (Dockerfile).
// Shell: DATABASE_URL, or DATABASE_URL_TEST under NODE_ENV=test (the rule of databaseUrlFor, decision 014); no default.
// Exit codes: 0 written and verified, or nothing to export; 3 the database is not at migration 0033 or 0034; 1 any other error.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, types } from 'pg';

/** The job name of the marker row in `job_runs` (the guard of migration 0035 reads the newest succeeded one). */
export const MARKER_JOB = 'english_only_export';

/** The exit codes of the script (plan section 4.2, point 5). */
export const EXIT = { ok: 0, error: 1, wrongLevel: 3 } as const;

/**
 * The eleven counts of the guard of migration 0035, in its order.
 *
 * Why: plan section 4.3: the guard compares the marker's `counts` with the same expression on the live data, as jsonb.
 */
export const COUNT_KEYS = [
  'notification_templates',
  'service_listings',
  'content_pages',
  'help_articles',
  'reply_templates',
  'legal_documents',
  'customers',
  'clients',
  'service_categories',
  'notification_campaigns',
  'canonical_urls',
] as const;

/** One key of {@link COUNT_KEYS}. */
export type CountKey = (typeof COUNT_KEYS)[number];

/** The counts of the guard: whole numbers, never strings. */
export type Counts = Record<CountKey, number>;

/**
 * The guard's expression of migration 0035, word for word (`live := jsonb_build_object(…)`), as one select.
 *
 * Why: plan section 4.2, point 1: node-postgres returns this jsonb as an object with numbers, so the marker's `counts` equal the
 * guard's `live` exactly; a bare `count(*)` would come back as a string and never be equal. A test compares the two texts.
 */
export const COUNTS_SQL = String.raw`SELECT jsonb_build_object(
    'notification_templates', (SELECT count(*) FROM notification_templates WHERE locale <> 'en'
                                 AND created_at < date_trunc('milliseconds', transaction_timestamp())),
    'service_listings',       (SELECT count(*) FROM service_listings   WHERE locale <> 'en'),
    'content_pages',          (SELECT count(*) FROM content_pages      WHERE locale <> 'en'),
    'help_articles',          (SELECT count(*) FROM help_articles      WHERE locale <> 'en'),
    'reply_templates',        (SELECT count(*) FROM reply_templates    WHERE locale <> 'en'),
    'legal_documents',        (SELECT count(*) FROM legal_documents    WHERE locale <> 'en'),
    'customers',              (SELECT count(*) FROM customers          WHERE locale <> 'en'),
    'clients',                (SELECT count(*) FROM clients            WHERE locale <> 'en'),
    'service_categories',     (SELECT count(*) FROM service_categories WHERE name_ar <> ''),
    'notification_campaigns', (SELECT count(*) FROM notification_campaigns
                                WHERE content ? 'ar' OR audience #> '{customers,locales}' IS NOT NULL),
    'canonical_urls',         (SELECT count(*) FROM content_pages
                                WHERE locale = 'en' AND canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)')) AS counts`;

// The predicates below repeat the ones of migration 0035 (each section holds exactly the rows its statement deletes or changes).
const ADDRESS_IN_OTHER_LANGUAGE = String.raw`canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)'`;
const CAMPAIGN_TOUCHED = `content ? 'ar' OR audience #> '{customers,locales}' IS NOT NULL`;
const NO_ENGLISH_READER = `jsonb_typeof(audience #> '{customers,locales}') = 'array' AND NOT (audience #> '{customers,locales}') ? 'en'`;
const CONSENTED = 'EXISTS (SELECT 1 FROM consent_records c WHERE c.legal_document_id = d.id)';
// Arabic script (the ranges the guard script of section 9.4 reads), as regular-expression escapes: search settings typed in it.
const ARABIC_SCRIPT = String.raw`'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]'`;

/** The whole rows the migration deletes, per table, in the file's order. */
const DELETED_SQL = {
  notification_templates: `SELECT * FROM notification_templates WHERE locale <> 'en'
    AND created_at < date_trunc('milliseconds', transaction_timestamp()) ORDER BY id`,
  service_listings: `SELECT * FROM service_listings WHERE locale <> 'en' ORDER BY id`,
  content_pages: `SELECT * FROM content_pages WHERE locale <> 'en' ORDER BY id`,
  help_articles: `SELECT * FROM help_articles WHERE locale <> 'en' ORDER BY id`,
  reply_templates: `SELECT * FROM reply_templates WHERE locale <> 'en' ORDER BY id`,
  legal_documents: `SELECT d.*, 'deleted' AS fate FROM legal_documents d WHERE d.locale <> 'en' AND NOT ${CONSENTED} ORDER BY d.id`,
} as const;

/** The values the migrations change or drop, per section, in the file's order. */
const CHANGED_SQL = {
  'customers.locale': `SELECT id, locale FROM customers WHERE locale <> 'en' ORDER BY id`,
  'clients.locale': `SELECT id, locale FROM clients WHERE locale <> 'en' ORDER BY id`,
  'service_categories.name_ar': `SELECT id, name, name_ar FROM service_categories WHERE name_ar <> '' ORDER BY id`,
  // Every column, not only id, name, status, audience and content: a cancelled one also loses its fan-out cursor.
  notification_campaigns: `SELECT *,
      CASE WHEN ${NO_ENGLISH_READER} THEN
             CASE WHEN status IN ('scheduled', 'queued', 'sending') THEN 'cancelled'
                  WHEN status = 'draft' THEN 'audience_removed'
                  ELSE 'audience_removed_finished' END
           WHEN audience #> '{customers,locales}' IS NOT NULL THEN 'filter_removed'
           ELSE 'text_only' END AS fate
    FROM notification_campaigns WHERE ${CAMPAIGN_TOUCHED} ORDER BY id`,
  'content_pages.canonical_url': `SELECT id, slug, canonical_url FROM content_pages
    WHERE locale = 'en' AND ${ADDRESS_IN_OTHER_LANGUAGE} ORDER BY id`,
  legal_documents_retired: `SELECT d.*, 'retired' AS fate,
      (SELECT count(*)::int FROM consent_records c WHERE c.legal_document_id = d.id) AS consents
    FROM legal_documents d WHERE d.locale <> 'en' AND ${CONSENTED} ORDER BY d.id`,
} as const;

/** The fates of a campaign in the file and the report (plan section 4.2, point 2). */
export const CAMPAIGN_FATES = [
  'cancelled',
  'audience_removed',
  'audience_removed_finished',
  'filter_removed',
  'text_only',
] as const;

/** A row as the file holds it: every column by name (jsonb as JSON, timestamps as ISO text, numerics as strings). */
export type ExportRow = Record<string, unknown>;

/** The file one run writes (plan section 4.2, point 2); keys in this order. */
export interface ExportFile {
  format: 1;
  feature: '30-english-only';
  database: string;
  exportedAt: string;
  migrations: { latest: string; applied: number };
  counts: Counts;
  deleted: Record<keyof typeof DELETED_SQL, ExportRow[]>;
  changed: Record<keyof typeof CHANGED_SQL, ExportRow[]>;
  report: Report;
  howToRestore: string[];
}

/** What the lead reads before anything is deleted (plan section 4.2, point 1; L3 and L8 of section 11). */
export interface Report {
  /** rows per table and language (`service_categories` counts the filled Arabic names under `ar`) */
  byLanguage: Array<{ table: string; locale: string; rows: number }>;
  /**
   * services switched on only in another language, or with no English listing (every service with a listing in another
   * language and no switched-on English one); `listed` is true when one of those listings is switched on, so the service
   * is buyable today (fact 10) and loses its public page; an open checkout session stays payable
   */
  servicesListedOnlyInAnotherLanguage: Array<{
    serviceId: number;
    name: string;
    listed: boolean;
    orders: number;
    openCheckoutSessions: number;
  }>;
  /** event, channel and audience with no English template: after the deletion that event sends nothing on that channel */
  templatesWithoutEnglish: Array<{ event: string; channel: string; audience: string; locales: string[] }>;
  /** live content pages in another language (no English twin is stored for any of them) */
  pagesWithoutEnglish: Array<{ id: number; slug: string; locale: string; title: string; status: string }>;
  /** published help articles in another language */
  helpArticlesWithoutEnglish: Array<{ id: number; locale: string; question: string }>;
  /** legal document types with a version in force in another language and none in English: migration 0035 refuses them */
  legalTypesWithoutEnglishInForce: string[];
  /** templates in another language that staff edited after they were created */
  templatesEditedByStaff: Array<{ id: number; event: string; channel: string; audience: string; locale: string }>;
  /** the campaigns the migration changes, by fate */
  campaignsByFate: Record<(typeof CAMPAIGN_FATES)[number], Array<{ id: number; name: string; status: string }>>;
  /** search settings that contain Arabic script: left as they are (staff remove them in the console) */
  searchSettingsInArabicScript: {
    synonyms: Array<{ id: number; root: string | null; terms: string[] }>;
    pins: Array<{ id: number; query: string }>;
    hiddenTerms: Array<{ id: number; term: string }>;
  };
  /** rows the guard reads whose `updated_at` is after this export's snapshot time: the guard says "changed after the export" */
  datedAfterExport: Array<{ table: string; id: number; updatedAt: string }>;
}

/** What a run was asked to do. */
interface Options {
  out: string;
  check: boolean;
}

/** A refusal with its exit code and one sentence for the operator. */
class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const USAGE = 'Usage: bun scripts/english-only-export.ts --out <folder> [--check]';

/** Reads `--out <dir>` (or `--out=<dir>`) and `--check`; anything else stops the run. */
function parseArgs(argv: readonly string[]): Options {
  let out: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') check = true;
    else if (arg === '--out') out = argv[++i];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else throw new Stop(EXIT.error, `Unknown argument "${arg}". ${USAGE}`);
  }
  if (!out) throw new Stop(EXIT.error, `--out is required (no default, in every environment). ${USAGE}`);
  return { out: resolve(out), check };
}

/** Writes and removes a probe file in the folder, so a missing or read-only folder stops the run before anything is read. */
function probeFolder(folder: string): void {
  const kind = statSync(folder, { throwIfNoEntry: false });
  if (!kind?.isDirectory()) throw new Stop(EXIT.error, `The folder ${folder} does not exist: create it first.`);
  const probe = join(folder, `.english-only-probe-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    unlinkSync(probe);
  } catch (error) {
    rmSync(probe, { force: true });
    const reason = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Stop(
      EXIT.error,
      `The folder ${folder} cannot be written by this user (${reason}): give --out a folder it can write.`,
    );
  }
}

/** The database URL of decision 014: DATABASE_URL, or DATABASE_URL_TEST under NODE_ENV=test. */
function databaseUrl(env: Record<string, string | undefined>): string {
  const name = env.NODE_ENV === 'test' ? 'DATABASE_URL_TEST' : 'DATABASE_URL';
  const url = env[name];
  if (!url) throw new Stop(EXIT.error, `Set ${name} to the database to export (there is no default).`);
  return url;
}

/** An id as a number when it fits, else as text (no bigint id is that large today). */
function parseInt8(value: string): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

/** node-postgres's own parser of a type (its typing returns `any`). */
const builtInParser = types.getTypeParser as (oid: number, format?: 'text' | 'binary') => (value: string) => unknown;

/**
 * The column parsers of this script's connection: ids as numbers, everything else as node-postgres reads it (jsonb as JSON,
 * timestamps as dates, which JSON writes as ISO text, numerics as strings).
 *
 * Why: plan section 4.2, point 2 (the row format of the file); the export test reads the database with the same parsers to
 * prove that the file holds every column of every row.
 */
export const TYPE_PARSERS = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary'): ((value: string) => unknown) => {
    if (oid === 20) return parseInt8; // int8
    if (oid === 1016) {
      // int8[] (service_categories.allowed_group_ids)
      const parseList = builtInParser(1016, 'text');
      return (value: string) =>
        (parseList(value) as Array<string | null> | null)?.map((item) => (item === null ? null : parseInt8(item)));
    }
    return builtInParser(oid, format);
  }) as typeof types.getTypeParser,
};

/** Where the database stands: the journal tag of its newest applied migration. */
interface Level {
  latest: string;
  applied: number;
}

/** The journal of this checkout's migrations (`drizzle/meta/_journal.json`, next to this script in the image too). */
function journal(): Array<{ tag: string; when: number }> {
  const path = new URL('../drizzle/meta/_journal.json', import.meta.url);
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<{ tag: string; when: number }> }).entries;
}

/**
 * Decides whether this database may be exported: its newest migration must be 0033 or 0034 (plan section 4.2, point 0).
 *
 * @returns the level, or null when the database has no migrations at all (nothing to export)
 * @throws {Stop} exit 3 below 0033 or at/after 0035
 */
async function readLevel(client: Client): Promise<Level | null> {
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!table.rows[0]?.present) return null;
  const { rows } = await client.query<{ newest: string | null; applied: number }>(
    'SELECT max(created_at)::text AS newest, count(*)::int AS applied FROM drizzle.__drizzle_migrations',
  );
  const newest = rows[0]?.newest == null ? null : Number(rows[0].newest);
  if (newest === null) return null;
  const entries = journal();
  const when = (tag: string) => entries.find((entry) => entry.tag === tag)?.when;
  const first = when('0033_search');
  const done = when('0035_english_only_data');
  if (first === undefined) throw new Stop(EXIT.error, 'drizzle/meta/_journal.json has no 0033_search: wrong checkout.');
  if (newest < first) {
    throw new Stop(
      EXIT.wrongLevel,
      'This database is older than migration 0033_search: upgrade this database to the previous release first.',
    );
  }
  if (done !== undefined && newest >= done) {
    throw new Stop(
      EXIT.wrongLevel,
      'This database is already migrated (0035_english_only_data has run): nothing to export.',
    );
  }
  const tag = entries.find((entry) => entry.when === newest)?.tag;
  if (tag !== '0033_search' && tag !== '0034_legacy_slugs') {
    throw new Stop(
      EXIT.wrongLevel,
      `The newest migration of this database (${tag ?? `unknown, ${newest}`}) is not 0033_search or 0034_legacy_slugs.`,
    );
  }
  return { latest: tag, applied: rows[0]!.applied };
}

/** Rows of a query, as plain JSON values (dates become ISO text, as in the file). */
async function rowsOf(client: Client, text: string, params: unknown[] = []): Promise<ExportRow[]> {
  const { rows } = await client.query<ExportRow>(text, params);
  return JSON.parse(JSON.stringify(rows)) as ExportRow[];
}

/** Reads the report of plan section 4.2, point 1, inside the export's snapshot. */
async function readReport(client: Client, campaigns: ExportRow[], snapshotAt: string): Promise<Report> {
  const byLanguage = await rowsOf(
    client,
    [
      'notification_templates',
      'service_listings',
      'content_pages',
      'help_articles',
      'reply_templates',
      'legal_documents',
      'customers',
      'clients',
    ]
      .map((table) => `SELECT '${table}' AS "table", locale, count(*)::int AS "rows" FROM ${table} GROUP BY locale`)
      .concat(`SELECT 'service_categories.name_ar', 'ar', count(*)::int FROM service_categories WHERE name_ar <> ''`)
      .join(' UNION ALL ')
      .concat(' ORDER BY 1, 2'),
  );
  const services = await rowsOf(
    client,
    `SELECT l.service_id AS "serviceId", s.name, bool_or(l.is_listed) AS listed,
            (SELECT count(*)::int FROM orders o WHERE o.service_id = l.service_id) AS orders,
            (SELECT count(*)::int FROM checkout_sessions c WHERE c.service_id = l.service_id AND c.status = 'open')
              AS "openCheckoutSessions"
       FROM service_listings l JOIN services s ON s.id = l.service_id
      WHERE l.locale <> 'en'
        AND NOT EXISTS (SELECT 1 FROM service_listings e
                         WHERE e.service_id = l.service_id AND e.locale = 'en' AND e.is_listed)
      GROUP BY l.service_id, s.name ORDER BY l.service_id`,
  );
  const templates = await rowsOf(
    client,
    `SELECT event, channel, audience, array_agg(DISTINCT locale ORDER BY locale) AS locales FROM notification_templates t
      WHERE locale <> 'en' AND NOT EXISTS (SELECT 1 FROM notification_templates e WHERE e.locale = 'en'
        AND e.event = t.event AND e.channel = t.channel AND e.audience = t.audience)
      GROUP BY event, channel, audience ORDER BY event, channel, audience`,
  );
  const pages = await rowsOf(
    client,
    `SELECT id, slug, locale, title, status FROM content_pages
      WHERE locale <> 'en' AND status IN ('published', 'noindex') ORDER BY id`,
  );
  const help = await rowsOf(
    client,
    `SELECT id, locale, question FROM help_articles WHERE locale <> 'en' AND is_published ORDER BY id`,
  );
  const legal = await client.query<{ type: string }>(
    `SELECT DISTINCT d.type FROM legal_documents d WHERE d.is_current AND d.locale <> 'en'
        AND NOT EXISTS (SELECT 1 FROM legal_documents e WHERE e.type = d.type AND e.locale = 'en' AND e.is_current)
      ORDER BY d.type`,
  );
  const edited = await rowsOf(
    client,
    `SELECT id, event, channel, audience, locale FROM notification_templates
      WHERE locale <> 'en' AND updated_at > created_at ORDER BY id`,
  );
  const synonyms = await rowsOf(
    client,
    `SELECT id, root, terms FROM search_synonyms
      WHERE coalesce(root, '') ~ ${ARABIC_SCRIPT} OR array_to_string(terms, ' ') ~ ${ARABIC_SCRIPT} ORDER BY id`,
  );
  const pins = await rowsOf(client, `SELECT id, query FROM search_pins WHERE query ~ ${ARABIC_SCRIPT} ORDER BY id`);
  const hiddenTerms = await rowsOf(
    client,
    `SELECT id, term FROM search_hidden_terms WHERE term ~ ${ARABIC_SCRIPT} ORDER BY id`,
  );
  const dated = await rowsOf(
    client,
    [
      'notification_templates',
      'service_listings',
      'content_pages',
      'help_articles',
      'reply_templates',
      'legal_documents',
    ]
      .map(
        (table) =>
          `SELECT '${table}' AS "table", id, updated_at AS "updatedAt" FROM ${table} WHERE locale <> 'en' AND updated_at > $1::timestamptz`,
      )
      .concat(
        `SELECT 'notification_campaigns', id, updated_at FROM notification_campaigns WHERE (${CAMPAIGN_TOUCHED}) AND updated_at > $1::timestamptz`,
        `SELECT 'service_categories', id, updated_at FROM service_categories WHERE name_ar <> '' AND updated_at > $1::timestamptz`,
        `SELECT 'content_pages', id, updated_at FROM content_pages WHERE locale = 'en' AND ${ADDRESS_IN_OTHER_LANGUAGE} AND updated_at > $1::timestamptz`,
      )
      .join(' UNION ALL ')
      .concat(' ORDER BY 1, 2'),
    [snapshotAt],
  );
  const campaignsByFate = Object.fromEntries(
    CAMPAIGN_FATES.map((fate) => [fate, [] as Report['campaignsByFate'][typeof fate]]),
  ) as Report['campaignsByFate'];
  for (const row of campaigns) {
    campaignsByFate[row.fate as (typeof CAMPAIGN_FATES)[number]].push({
      id: row.id as number,
      name: row.name as string,
      status: row.status as string,
    });
  }
  return {
    byLanguage: byLanguage as Report['byLanguage'],
    servicesListedOnlyInAnotherLanguage: services as Report['servicesListedOnlyInAnotherLanguage'],
    templatesWithoutEnglish: templates as Report['templatesWithoutEnglish'],
    pagesWithoutEnglish: pages as Report['pagesWithoutEnglish'],
    helpArticlesWithoutEnglish: help as Report['helpArticlesWithoutEnglish'],
    legalTypesWithoutEnglishInForce: legal.rows.map((row) => row.type),
    templatesEditedByStaff: edited as Report['templatesEditedByStaff'],
    campaignsByFate,
    searchSettingsInArabicScript: {
      synonyms: synonyms as Report['searchSettingsInArabicScript']['synonyms'],
      pins: pins as Report['searchSettingsInArabicScript']['pins'],
      hiddenTerms: hiddenTerms as Report['searchSettingsInArabicScript']['hiddenTerms'],
    },
    datedAfterExport: dated as Report['datedAfterExport'],
  };
}

/** The plain-words restore note of the file (plan section 4.2, point 2). */
const HOW_TO_RESTORE = [
  'This file is the only copy of the content migration 0035 deleted besides the regular database dumps. Keep it with the backups.',
  'deleted.<table> holds whole rows of that table (every column by name) as they were before migration 0035 deleted them: notification_templates, service_listings, content_pages, help_articles and reply_templates in another language than English, and legal_documents in another language that no consent references.',
  'changed."customers.locale" and changed."clients.locale" hold the id and the saved language of each merchant and customer that did not read English (the columns are dropped by migration 0039); changed."service_categories.name_ar" holds the id, the name and the Arabic name of each category (the column is dropped by migration 0036).',
  'changed.notification_campaigns holds every column of each campaign before migration 0035 rewrote it (its audience, its content in both languages, its status and fan-out cursor), with its fate: cancelled (it was scheduled or running for readers of other languages only; audit_logs has a system row), audience_removed (a draft of that kind), audience_removed_finished (sent, failed or cancelled of that kind), filter_removed (its language list contained en) or text_only (it only lost content.ar).',
  'changed."content_pages.canonical_url" holds the id, slug and old canonical address of each English page whose canonical address pointed at /ar (set to NULL). changed.legal_documents_retired holds whole rows of the legal versions in another language that consents reference: they stay in legal_documents as history (is_current = false), with the number of consents.',
  'Until migration 0036 runs, a row can be put back by SQL: INSERT INTO <table> (<columns>) OVERRIDING SYSTEM VALUE VALUES (<the values of the row>).',
  'After migration 0036 the language columns no longer exist: type the content again in the console, or restore the dump of the same day into a new database (docs/OPERATIONS.md, section 4) and copy what you need from there by SQL.',
];

/** Prints the report in plain lines. */
function printReport(file: Pick<ExportFile, 'database' | 'exportedAt' | 'migrations' | 'counts' | 'report'>): void {
  const { report } = file;
  const list = <T>(title: string, items: readonly T[], line: (item: T) => string) => {
    console.log(`${title}: ${items.length === 0 ? 'none' : ''}`);
    for (const item of items) console.log(`  - ${line(item)}`);
  };
  console.log(
    `Database ${file.database} at ${file.migrations.latest} (${file.migrations.applied} migrations), snapshot ${file.exportedAt}`,
  );
  console.log(`Counts of the guard: ${COUNT_KEYS.map((key) => `${key} ${file.counts[key]}`).join(', ')}`);
  list('Rows per table and language', report.byLanguage, (row) => `${row.table} ${row.locale}: ${row.rows}`);
  list(
    'Services switched on only in another language, or with no English listing (listed true: buyable today, loses its page; open checkout sessions stay payable)',
    report.servicesListedOnlyInAnotherLanguage,
    (row) =>
      `#${row.serviceId} ${row.name} (listed ${row.listed}, ${row.orders} orders, ${row.openCheckoutSessions} open checkout sessions)`,
  );
  list(
    'Templates with no English row (that event then sends nothing on that channel)',
    report.templatesWithoutEnglish,
    (row) => `${row.event} ${row.channel} ${row.audience} (${row.locales.join(', ')})`,
  );
  list(
    'Live content pages in another language',
    report.pagesWithoutEnglish,
    (row) => `#${row.id} ${row.locale} /${row.slug}: ${row.title} (${row.status})`,
  );
  list(
    'Published help articles in another language',
    report.helpArticlesWithoutEnglish,
    (row) => `#${row.id} ${row.locale}: ${row.question}`,
  );
  list(
    'Legal types in force in another language with no English version in force (migration 0035 refuses)',
    report.legalTypesWithoutEnglishInForce,
    (type) => type,
  );
  list(
    'Templates in another language staff edited',
    report.templatesEditedByStaff,
    (row) => `#${row.id} ${row.event} ${row.channel} ${row.audience} ${row.locale}`,
  );
  for (const fate of CAMPAIGN_FATES) {
    list(`Campaigns, ${fate}`, report.campaignsByFate[fate], (row) => `#${row.id} ${row.name} (${row.status})`);
  }
  const search = report.searchSettingsInArabicScript;
  list(
    'Search synonyms in Arabic script (left as they are)',
    search.synonyms,
    (row) => `#${row.id} ${row.root ?? ''} ${row.terms.join(', ')}`,
  );
  list('Search pins in Arabic script (left as they are)', search.pins, (row) => `#${row.id} ${row.query}`);
  list(
    'Hidden search terms in Arabic script (left as they are)',
    search.hiddenTerms,
    (row) => `#${row.id} ${row.term}`,
  );
  list(
    'Rows dated after this export (the guard says "changed after the export" until then)',
    report.datedAfterExport,
    (row) => `${row.table} #${row.id} ${row.updatedAt}`,
  );
}

/** `yyyymmddThhmmssZ` of a time, in UTC. */
const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * The guard's counts in the order of {@link COUNT_KEYS} (jsonb keeps its keys in an order of its own); every value a whole number.
 *
 * @throws {Stop} when a key is missing or extra, or a value is not a whole number
 */
function countsOf(raw: Record<string, unknown>): Counts {
  const keys = Object.keys(raw);
  if (keys.length !== COUNT_KEYS.length || COUNT_KEYS.some((key) => !Number.isSafeInteger(raw[key]))) {
    throw new Stop(EXIT.error, `The guard's counts came back in an unexpected shape: ${JSON.stringify(raw)}.`);
  }
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, raw[key]])) as Counts;
}

/** Fails when a section does not hold exactly the rows its count of the guard reads. */
function assertComplete(counts: Counts, deleted: ExportFile['deleted'], changed: ExportFile['changed']): void {
  const held: Counts = {
    notification_templates: deleted.notification_templates.length,
    service_listings: deleted.service_listings.length,
    content_pages: deleted.content_pages.length,
    help_articles: deleted.help_articles.length,
    reply_templates: deleted.reply_templates.length,
    legal_documents: deleted.legal_documents.length + changed.legal_documents_retired.length,
    customers: changed['customers.locale'].length,
    clients: changed['clients.locale'].length,
    service_categories: changed['service_categories.name_ar'].length,
    notification_campaigns: changed.notification_campaigns.length,
    canonical_urls: changed['content_pages.canonical_url'].length,
  };
  const wrong = COUNT_KEYS.filter((key) => held[key] !== counts[key]);
  if (wrong.length > 0) {
    throw new Stop(
      EXIT.error,
      `The export does not hold every row the guard counts (${wrong.join(', ')}): nothing written.`,
    );
  }
}

/**
 * Exports, per database, every row and value migrations 0035-0039 delete or change, and writes the marker the guard of 0035
 * needs.
 *
 * Why: decision 039 and plan 30 section 4.2: Arabic content is deleted for good after a backup file, and migration 0035 refuses to
 * delete content that existed before its run without a fresh export. One `REPEATABLE READ, READ ONLY` transaction reads the
 * rows, the guard's counts and the report from one snapshot; the file is written to `*.tmp`, renamed, read back and hashed; only
 * then a second short transaction writes the marker.
 *
 * Side effects: without `--check`, writes `<out>/english-only-<database>-<yyyymmddThhmmssZ>.json` (mode 0600) and one `job_runs`
 * row (`job = 'english_only_export'`, `trigger = 'manual'`, `status = 'succeeded'`, `result = { file, sha256, counts }`).
 * Nothing at all on a database with nothing to export, with `--check`, or when it stops early.
 *
 * @param argv the command-line arguments after the script name
 * @param env the environment (`DATABASE_URL`, or `DATABASE_URL_TEST` under `NODE_ENV=test`)
 * @returns the exit code: 0 written and verified (or nothing to export), 3 a database not at 0033 or 0034, 1 any other error
 * @see docs/briefs/30-english-only.md section 4.2; docs/OPERATIONS.md, release 30
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let client: Client | undefined;
  // A file not yet renamed, and one renamed but not yet verified: both are removed when the run stops. A verified file stays,
  // even when the marker then fails (a COMMIT that fails on the way back may still have written the marker).
  let temporary: string | undefined;
  let unverified: string | undefined;
  try {
    const options = parseArgs(argv);
    probeFolder(options.out);
    const url = databaseUrl(env);
    const target = new URL(url);
    console.log(
      `English-only export of ${target.hostname}:${target.port || '5432'}${target.pathname}${options.check ? ' (check only)' : ''}`,
    );

    client = new Client({
      connectionString: url,
      types: TYPE_PARSERS,
      application_name: 'english-only-export',
      connectionTimeoutMillis: 10_000,
    });
    client.on('error', () => undefined);
    await client.connect();

    // One snapshot: the level, the rows, the counts and the report.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // The snapshot time, cut (never rounded up) to the milliseconds a timestamptz(3) column holds: the marker's started_at,
    // exportedAt and the report's "dated after" all use it, so a change in the next millisecond is already "after the export".
    const head = await client.query<{ database: string; snapshotAt: Date; snapshotText: string }>(
      `SELECT current_database() AS database, date_trunc('milliseconds', transaction_timestamp()) AS "snapshotAt",
              date_trunc('milliseconds', transaction_timestamp())::text AS "snapshotText"`,
    );
    const { database, snapshotAt, snapshotText } = head.rows[0]!;
    const level = await readLevel(client);
    if (!level) {
      await client.query('ROLLBACK');
      console.log('Nothing to export: this database has no migrations.');
      return EXIT.ok;
    }
    const counts = countsOf((await client.query<{ counts: Record<string, unknown> }>(COUNTS_SQL)).rows[0]!.counts);
    const deleted = {} as ExportFile['deleted'];
    for (const [table, text] of Object.entries(DELETED_SQL))
      deleted[table as keyof typeof DELETED_SQL] = await rowsOf(client, text);
    const changed = {} as ExportFile['changed'];
    for (const [section, text] of Object.entries(CHANGED_SQL))
      changed[section as keyof typeof CHANGED_SQL] = await rowsOf(client, text);
    const report = await readReport(client, changed.notification_campaigns, snapshotText);
    await client.query('COMMIT');

    assertComplete(counts, deleted, changed);
    const file: ExportFile = {
      format: 1,
      feature: '30-english-only',
      database,
      exportedAt: snapshotAt.toISOString(),
      migrations: level,
      counts,
      deleted,
      changed,
      report,
      howToRestore: HOW_TO_RESTORE,
    };
    printReport(file);
    const processed = [...Object.values(deleted), ...Object.values(changed)].reduce(
      (sum, rows) => sum + rows.length,
      0,
    );
    if (COUNT_KEYS.every((key) => counts[key] === 0)) {
      console.log('Nothing to export: this database holds no content in another language. No file, no marker.');
      return EXIT.ok;
    }
    if (options.check) {
      console.log(`Check only: ${processed} rows would be exported. Nothing written.`);
      return EXIT.ok;
    }

    const path = join(
      options.out,
      `english-only-${database.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp(snapshotAt)}.json`,
    );
    if (existsSync(path)) throw new Stop(EXIT.error, `${path} exists already: wait a second and run the export again.`);
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
    const partial = `${path}.tmp`;
    try {
      writeFileSync(partial, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      // wx: an existing file is another run's and stays; a write that failed half-way (a full disk) is removed
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(partial, { force: true });
      throw error;
    }
    temporary = partial;
    renameSync(partial, path);
    unverified = path;
    temporary = undefined;

    // Read back: the bytes and the counts must be what was written before the guard may trust the file.
    const written = sha256(bytes);
    const readBack = readFileSync(path);
    const parsed = JSON.parse(readBack.toString('utf8')) as ExportFile;
    if (sha256(readBack) !== written || COUNT_KEYS.some((key) => parsed.counts[key] !== counts[key])) {
      throw new Stop(
        EXIT.error,
        `${path} does not read back as written: removed, no marker. Check the disk and run the export again.`,
      );
    }
    unverified = undefined;

    await client.query('BEGIN');
    const marker = await client.query<{ id: number }>(
      `INSERT INTO job_runs (job, trigger, status, started_at, finished_at, duration_ms, processed, result)
       VALUES ($1, 'manual', 'succeeded', $2::timestamptz, now(),
               greatest(0, floor(extract(epoch FROM (clock_timestamp() - $2::timestamptz)) * 1000))::int, $3, $4::jsonb)
       RETURNING id`,
      [MARKER_JOB, snapshotText, processed, JSON.stringify({ file: path, sha256: written, counts })],
    );
    await client.query('COMMIT');
    console.log(`Wrote ${path}: ${processed} rows, sha256 ${written}. Marker: job_runs #${marker.rows[0]!.id}.`);
    return EXIT.ok;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    for (const leftover of [temporary, unverified]) if (leftover) rmSync(leftover, { force: true });
    if (error instanceof Stop) {
      console.error(error.message);
      return error.code;
    }
    console.error(`The English-only export failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.error;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (import.meta.main) process.exit(await main());
