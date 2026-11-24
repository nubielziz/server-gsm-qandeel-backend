// Drizzle queries of the storefront search tables (feature 29, plan section 4.6): the index state row, the enabled synonyms and the daily
// term counts. The tables `search_pins` and `search_hidden_terms` are retired by decision 068: nothing reads them.
import { asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../../infra/db';
import { type SearchIndexState, searchIndexState, searchSynonyms, searchTermsDaily } from '../../db/schema';
import type { SynonymRow } from '../domain/set-conversion';
import type { PopularCandidate } from '../domain/terms';
import { POPULAR_MIN_DAYS, POPULAR_MIN_VISITORS } from '../domain/terms';

/** The columns of the index state a writer may set. */
export type IndexStatePatch = Partial<
  Pick<
    SearchIndexState,
    | 'schemaVersion'
    | 'servicesCollection'
    | 'termsCollection'
    | 'documents'
    | 'engineVersion'
    | 'memoryBytes'
    | 'lastSyncAt'
    | 'lastReconcileAt'
    | 'lastRebuildAt'
    | 'lastTermsBuildAt'
    | 'lastError'
  >
>;

/**
 * Reads the index state row.
 *
 * @param db the database or a transaction
 * @returns the row, or `undefined` before the worker wrote it
 */
export async function readIndexState(db: DbExecutor): Promise<SearchIndexState | undefined> {
  const [row] = await db.select().from(searchIndexState).where(eq(searchIndexState.singleton, true)).limit(1);
  return row;
}

/**
 * Writes some columns of the index state row (created on first use).
 *
 * @param db the database or a transaction
 * @param patch the columns to set
 * @param now the clock's time (`updated_at`)
 */
export async function writeIndexState(db: DbExecutor, patch: IndexStatePatch, now: Date): Promise<void> {
  await db
    .insert(searchIndexState)
    .values({ singleton: true, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: searchIndexState.singleton, set: { ...patch, updatedAt: now } });
}

/**
 * Reads every enabled synonym.
 *
 * @param db the database or a transaction
 * @returns the rows in id order
 */
export async function enabledSynonyms(db: DbExecutor): Promise<SynonymRow[]> {
  const rows = await db
    .select({
      id: searchSynonyms.id,
      kind: searchSynonyms.kind,
      root: searchSynonyms.root,
      terms: searchSynonyms.terms,
      isEnabled: searchSynonyms.isEnabled,
    })
    .from(searchSynonyms)
    .where(eq(searchSynonyms.isEnabled, true))
    .orderBy(asc(searchSynonyms.id));
  return rows;
}

/**
 * Reads the terms that had at least 5 distinct visitors on at least 3 days since a day, with their figures.
 *
 * Why: plan section 4.4: the busy-days rule is applied in SQL so only candidates leave the database; the vocabulary and the zero-result
 * share are checked by `isPopularQuery`.
 *
 * @param db the database or a transaction
 * @param sinceDay the first day counted, `yyyy-mm-dd`
 * @returns the candidates, by visitors (most first)
 */
export async function popularCandidates(db: DbExecutor, sinceDay: string): Promise<PopularCandidate[]> {
  const busy = sql<number>`count(*) filter (where ${searchTermsDaily.visitors} >= ${POPULAR_MIN_VISITORS})::int`;
  return db
    .select({
      term: searchTermsDaily.term,
      visitors: sql<number>`sum(${searchTermsDaily.visitors})::int`,
      busyDays: busy,
      searches: sql<number>`sum(${searchTermsDaily.searches})::int`,
      zeroResults: sql<number>`sum(${searchTermsDaily.zeroResults})::int`,
    })
    .from(searchTermsDaily)
    .where(gte(searchTermsDaily.day, sinceDay))
    .groupBy(searchTermsDaily.term)
    .having(sql`${busy} >= ${POPULAR_MIN_DAYS}`)
    .orderBy(sql`sum(${searchTermsDaily.visitors}) desc`, asc(searchTermsDaily.term));
}

/** One day's figures of one term. */
export interface TermsDayRow {
  /** `yyyy-mm-dd` */
  readonly day: string;
  readonly term: string;
  readonly searches: number;
  readonly zeroResults: number;
  readonly visitors: number;
}

const UPSERT_SLICE = 500;

/**
 * Writes the day's figures of some terms as absolute values.
 *
 * Why: plan section 5.6: the flush reads the whole day from Redis each time and SETs the numbers (never adds), so a retry or a
 * second run gives the same rows.
 *
 * @param db the database or a transaction
 * @param rows the figures
 * @param now the clock's time (`updated_at`)
 * @returns how many rows were written
 */
export async function upsertTermsDays(db: DbExecutor, rows: readonly TermsDayRow[], now: Date): Promise<number> {
  for (let start = 0; start < rows.length; start += UPSERT_SLICE) {
    const slice = rows.slice(start, start + UPSERT_SLICE).map((row) => ({
      day: row.day,
      term: row.term,
      searches: row.searches,
      zeroResults: Math.min(row.zeroResults, row.searches),
      visitors: row.visitors,
      updatedAt: now,
    }));
    await db
      .insert(searchTermsDaily)
      .values(slice)
      .onConflictDoUpdate({
        target: [searchTermsDaily.day, searchTermsDaily.term],
        set: {
          searches: sql`excluded.searches`,
          zeroResults: sql`excluded.zero_results`,
          visitors: sql`excluded.visitors`,
          updatedAt: now,
        },
      });
  }
  return rows.length;
}

/**
 * Deletes the daily figures before a day.
 *
 * @param db the database or a transaction
 * @param beforeDay the first day kept, `yyyy-mm-dd`
 * @returns how many rows were deleted
 */
export async function purgeTermsDays(db: DbExecutor, beforeDay: string): Promise<number> {
  const deleted = await db
    .delete(searchTermsDaily)
    .where(lt(searchTermsDaily.day, beforeDay))
    .returning({ id: searchTermsDaily.id });
  return deleted.length;
}
