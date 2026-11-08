// Drizzle queries on `legal_documents` (the storefront module's own table): the console list and reads, the draft insert, the
// publish swap, and the version in force the public route and the checkouts read.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type LegalDocument, type LegalDocumentType, type NewLegalDocument, legalDocuments } from '../db/schema';

/** The first key of the two-key advisory lock that serialises the publishes of one type and language. */
const LEGAL_PUBLISH_LOCK = 7_215_001;

const COLUMNS: ListColumns = {
  id: legalDocuments.id,
  type: legalDocuments.type,
  version: legalDocuments.version,
  locale: legalDocuments.locale,
  isCurrent: legalDocuments.isCurrent,
  effectiveFrom: legalDocuments.effectiveFrom,
  createdAt: legalDocuments.createdAt,
};

/** The sorts the console list accepts. */
export type LegalDocumentSort = 'type' | 'version' | 'locale' | 'effectiveFrom' | 'createdAt' | 'id';

/**
 * Lists versions for `GET /admin/legal-documents`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of rows and the exact total
 */
export async function listVersions(
  db: DbExecutor,
  query: ParsedListQuery<LegalDocumentSort>,
): Promise<{ rows: LegalDocument[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(legalDocuments)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, legalDocuments.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(legalDocuments)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a version, optionally locking it for the rest of the transaction.
 *
 * @param db the database or a transaction
 * @param id the version id
 * @param lock `true` takes `FOR UPDATE`
 * @returns the version, or `undefined`
 */
export async function findVersion(db: DbExecutor, id: number, lock = false): Promise<LegalDocument | undefined> {
  const query = db.select().from(legalDocuments).where(eq(legalDocuments.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Tells whether a version text already exists for a type and language.
 *
 * @param db the database or a transaction
 * @param type the document type
 * @param locale the language
 * @param version the version text
 * @returns true when it exists
 */
export async function versionExists(
  db: DbExecutor,
  type: LegalDocumentType,
  locale: string,
  version: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: legalDocuments.id })
    .from(legalDocuments)
    .where(and(eq(legalDocuments.type, type), eq(legalDocuments.locale, locale), eq(legalDocuments.version, version)))
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a draft version.
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `legal_documents_version_uq`
 */
export async function insertVersion(db: DbExecutor, values: NewLegalDocument): Promise<LegalDocument> {
  const [row] = await db.insert(legalDocuments).values(values).returning();
  return row!;
}

/**
 * Takes the lock that serialises publishes of one type and language, held until the transaction ends.
 *
 * Why: two drafts of the same document published at once would each see the old current version, flip it, and both try to
 * become current (a violation of the one-current index). A row lock cannot cover it because the second publish does not see the
 * first one's new current row.
 *
 * @param db the caller's transaction
 * @param type the document type
 * @param locale the language
 */
export async function lockPublish(db: DbExecutor, type: LegalDocumentType, locale: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${LEGAL_PUBLISH_LOCK}, hashtext(${`${type}|${locale}`}))`);
}

/**
 * Makes the version in force for a type and language stop being current, keeping its `effective_from`.
 *
 * @param db the caller's transaction (the publish lock is held)
 * @param type the document type
 * @param locale the language
 * @returns the version that was replaced, or `undefined` when none was in force
 */
export async function retireCurrent(
  db: DbExecutor,
  type: LegalDocumentType,
  locale: string,
): Promise<LegalDocument | undefined> {
  const [row] = await db
    .update(legalDocuments)
    .set({ isCurrent: false })
    .where(and(eq(legalDocuments.type, type), eq(legalDocuments.locale, locale), eq(legalDocuments.isCurrent, true)))
    .returning();
  return row;
}

/**
 * Puts a version in force.
 *
 * @param db the caller's transaction (the old current version is already retired)
 * @param id the version id
 * @param effectiveFrom the moment it takes effect (the injected clock's now)
 * @returns the updated row
 */
export async function makeCurrent(db: DbExecutor, id: number, effectiveFrom: Date): Promise<LegalDocument> {
  const [row] = await db
    .update(legalDocuments)
    .set({ isCurrent: true, effectiveFrom })
    .where(eq(legalDocuments.id, id))
    .returning();
  return row!;
}

/**
 * Finds the version in force for a type and language.
 *
 * @param db the database or a transaction
 * @param type the document type
 * @param locale the language
 * @returns the current version, or `undefined` when none is in force
 */
export async function findCurrent(
  db: DbExecutor,
  type: LegalDocumentType,
  locale: string,
): Promise<LegalDocument | undefined> {
  const [row] = await db
    .select()
    .from(legalDocuments)
    .where(and(eq(legalDocuments.type, type), eq(legalDocuments.locale, locale), eq(legalDocuments.isCurrent, true)))
    .limit(1);
  return row;
}

/**
 * Lists the version in force of every type and language.
 *
 * @param db the database or a transaction
 * @returns the current versions by type then language
 */
export async function listCurrentVersions(db: DbExecutor): Promise<LegalDocument[]> {
  return db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.isCurrent, true))
    .orderBy(asc(legalDocuments.type), asc(legalDocuments.locale));
}
