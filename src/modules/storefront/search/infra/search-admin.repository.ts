// Drizzle queries of the console's search tools (feature 29, plan sections 4.6 and 5.1): synonyms, pin rules, hidden terms and the daily
// report. The index state and the pushed sets are in `search-tables.repository.ts`.
import { and, eq, gte, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../../infra/db';
import {
  type NewSearchPin,
  type NewSearchSynonym,
  type SearchHiddenTerm,
  type SearchPin,
  type SearchSynonym,
  searchHiddenTerms,
  searchPins,
  searchSynonyms,
  searchTermsDaily,
} from '../../db/schema';

const SYNONYM_COLUMNS: ListColumns = {
  updatedAt: searchSynonyms.updatedAt,
  id: searchSynonyms.id,
  isEnabled: searchSynonyms.isEnabled,
  terms: sql`array_to_string(${searchSynonyms.terms}, ' ')`,
};
const PIN_COLUMNS: ListColumns = {
  updatedAt: searchPins.updatedAt,
  query: searchPins.query,
  isEnabled: searchPins.isEnabled,
};
const HIDDEN_COLUMNS: ListColumns = { createdAt: searchHiddenTerms.createdAt, term: searchHiddenTerms.term };

/**
 * Lists synonyms.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filter, search, sort, range)
 * @returns the page of rows and the exact total
 */
export async function listSynonymRows(
  db: DbExecutor,
  query: ParsedListQuery,
): Promise<{ rows: SearchSynonym[]; total: number }> {
  const where = listWhere(query, SYNONYM_COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(searchSynonyms)
      .where(where)
      .orderBy(...listOrderBy(query.sort, SYNONYM_COLUMNS, searchSynonyms.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(searchSynonyms)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads one synonym.
 *
 * @param db the database or a transaction
 * @param id the synonym id
 * @param lock true to take the row `FOR UPDATE` (a write in a transaction)
 * @returns the row, or `undefined`
 */
export async function findSynonym(db: DbExecutor, id: number, lock = false): Promise<SearchSynonym | undefined> {
  const query = db.select().from(searchSynonyms).where(eq(searchSynonyms.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/**
 * Inserts a synonym.
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 */
export async function insertSynonym(db: DbExecutor, values: NewSearchSynonym): Promise<SearchSynonym> {
  const [row] = await db.insert(searchSynonyms).values(values).returning();
  return row!;
}

/**
 * Changes a synonym.
 *
 * @param db the caller's transaction
 * @param id the synonym id
 * @param values the columns to set
 * @returns the updated row
 */
export async function updateSynonym(
  db: DbExecutor,
  id: number,
  values: Partial<NewSearchSynonym>,
): Promise<SearchSynonym> {
  const [row] = await db.update(searchSynonyms).set(values).where(eq(searchSynonyms.id, id)).returning();
  return row!;
}

/**
 * Deletes a synonym.
 *
 * @param db the caller's transaction
 * @param id the synonym id
 * @returns nothing
 */
export async function deleteSynonym(db: DbExecutor, id: number): Promise<void> {
  await db.delete(searchSynonyms).where(eq(searchSynonyms.id, id));
}

/**
 * Lists pin rules.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filter, search, sort, range)
 * @returns the page of rows and the exact total
 */
export async function listPinRows(
  db: DbExecutor,
  query: ParsedListQuery,
): Promise<{ rows: SearchPin[]; total: number }> {
  const where = listWhere(query, PIN_COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(searchPins)
      .where(where)
      .orderBy(...listOrderBy(query.sort, PIN_COLUMNS, searchPins.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(searchPins)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads one pin rule.
 *
 * @param db the database or a transaction
 * @param id the rule id
 * @param lock true to take the row `FOR UPDATE`
 * @returns the row, or `undefined`
 */
export async function findPin(db: DbExecutor, id: number, lock = false): Promise<SearchPin | undefined> {
  const query = db.select().from(searchPins).where(eq(searchPins.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/**
 * Inserts a pin rule.
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `search_pins_query_match_uq` when the query and match type exist
 */
export async function insertPin(db: DbExecutor, values: NewSearchPin): Promise<SearchPin> {
  const [row] = await db.insert(searchPins).values(values).returning();
  return row!;
}

/**
 * Changes a pin rule.
 *
 * @param db the caller's transaction
 * @param id the rule id
 * @param values the columns to set
 * @returns the updated row
 * @throws a unique violation of `search_pins_query_match_uq` when the new query and match type exist
 */
export async function updatePin(db: DbExecutor, id: number, values: Partial<NewSearchPin>): Promise<SearchPin> {
  const [row] = await db.update(searchPins).set(values).where(eq(searchPins.id, id)).returning();
  return row!;
}

/**
 * Deletes a pin rule.
 *
 * @param db the caller's transaction
 * @param id the rule id
 * @returns nothing
 */
export async function deletePin(db: DbExecutor, id: number): Promise<void> {
  await db.delete(searchPins).where(eq(searchPins.id, id));
}

/**
 * Lists hidden terms.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (search, sort, range)
 * @returns the page of rows and the exact total
 */
export async function listHiddenTermRows(
  db: DbExecutor,
  query: ParsedListQuery,
): Promise<{ rows: SearchHiddenTerm[]; total: number }> {
  const where = listWhere(query, HIDDEN_COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(searchHiddenTerms)
      .where(where)
      .orderBy(...listOrderBy(query.sort, HIDDEN_COLUMNS, searchHiddenTerms.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(searchHiddenTerms)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads one hidden term.
 *
 * @param db the database or a transaction
 * @param id the hidden term id
 * @returns the row, or `undefined`
 */
export async function findHiddenTerm(db: DbExecutor, id: number): Promise<SearchHiddenTerm | undefined> {
  const [row] = await db.select().from(searchHiddenTerms).where(eq(searchHiddenTerms.id, id)).limit(1);
  return row;
}

/**
 * Inserts a hidden term.
 *
 * @param db the caller's transaction
 * @param values the normalised term, a note and the staff member
 * @returns the stored row
 * @throws a unique violation of `search_hidden_terms_term_uq` when the term is already hidden
 */
export async function insertHiddenTerm(
  db: DbExecutor,
  values: { term: string; note: string; createdBy: number | null },
): Promise<SearchHiddenTerm> {
  const [row] = await db.insert(searchHiddenTerms).values(values).returning();
  return row!;
}

/**
 * Deletes a hidden term.
 *
 * @param db the caller's transaction
 * @param id the hidden term id
 * @returns nothing
 */
export async function deleteHiddenTerm(db: DbExecutor, id: number): Promise<void> {
  await db.delete(searchHiddenTerms).where(eq(searchHiddenTerms.id, id));
}

/** The totals of the report window. */
export interface ReportTotals {
  readonly searches: number;
  readonly zeroResults: number;
  readonly terms: number;
}

/**
 * Sums the daily counts since a day.
 *
 * @param db the database
 * @param sinceDay the first day, `yyyy-mm-dd`
 * @returns searches, searches without results and distinct terms
 */
export async function reportTotals(db: DbExecutor, sinceDay: string): Promise<ReportTotals> {
  const [row] = await db
    .select({
      searches: sql<number>`coalesce(sum(${searchTermsDaily.searches}), 0)::int`,
      zeroResults: sql<number>`coalesce(sum(${searchTermsDaily.zeroResults}), 0)::int`,
      terms: sql<number>`count(distinct ${searchTermsDaily.term})::int`,
    })
    .from(searchTermsDaily)
    .where(gte(searchTermsDaily.day, sinceDay));
  return row ?? { searches: 0, zeroResults: 0, terms: 0 };
}

/** One row of the top-terms table. */
export interface TopTermRow {
  readonly term: string;
  readonly searches: number;
  readonly visitors: number;
  readonly zeroResults: number;
}

/**
 * Reads the most searched terms since a day.
 *
 * @param db the database
 * @param sinceDay the first day, `yyyy-mm-dd`
 * @param limit at most this many terms
 * @returns the terms with their summed searches, visitors and no-result searches, most searched first
 */
export async function topTermRows(db: DbExecutor, sinceDay: string, limit: number): Promise<TopTermRow[]> {
  return db
    .select({
      term: searchTermsDaily.term,
      searches: sql<number>`sum(${searchTermsDaily.searches})::int`,
      visitors: sql<number>`sum(${searchTermsDaily.visitors})::int`,
      zeroResults: sql<number>`sum(${searchTermsDaily.zeroResults})::int`,
    })
    .from(searchTermsDaily)
    .where(gte(searchTermsDaily.day, sinceDay))
    .groupBy(searchTermsDaily.term)
    .orderBy(sql`sum(${searchTermsDaily.searches}) desc`, searchTermsDaily.term)
    .limit(limit);
}

/** One row of the no-result table: `searches` counts the searches that found nothing. */
export interface ZeroTermRow {
  readonly term: string;
  readonly searches: number;
  readonly lastSeen: Date;
}

/**
 * Reads the terms that found nothing most often since a day.
 *
 * @param db the database
 * @param sinceDay the first day, `yyyy-mm-dd`
 * @param limit at most this many terms
 * @returns the terms with their no-result searches and the last day they were searched (midnight UTC)
 */
export async function zeroResultTermRows(db: DbExecutor, sinceDay: string, limit: number): Promise<ZeroTermRow[]> {
  const rows = await db
    .select({
      term: searchTermsDaily.term,
      searches: sql<number>`sum(${searchTermsDaily.searches})::int`,
      zero: sql<number>`sum(${searchTermsDaily.zeroResults})::int`,
      lastDay: sql<string>`max(${searchTermsDaily.day})`,
    })
    .from(searchTermsDaily)
    .where(and(gte(searchTermsDaily.day, sinceDay), sql`${searchTermsDaily.zeroResults} > 0`))
    .groupBy(searchTermsDaily.term)
    .orderBy(sql`sum(${searchTermsDaily.zeroResults}) desc`, searchTermsDaily.term)
    .limit(limit);
  return rows.map((row) => ({
    term: row.term,
    searches: row.zero,
    lastSeen: new Date(`${row.lastDay}T00:00:00.000Z`),
  }));
}
