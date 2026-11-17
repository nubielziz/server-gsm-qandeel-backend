// Drizzle queries on `legal_documents` (the storefront module's own table): the console list and reads, the draft insert, the
// publish swap, and the version in force the public route and the checkouts read.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type LegalDocument, type LegalDocumentType, type NewLegalDocument, legalDocuments } from '../db/schema';

/** The first key of the two-key advisory lock that serialises the publishes of one type. */
const LEGAL_PUBLISH_LOCK = 7_215_001;

/** The archive tag of every version that can be created or published (decision 039: the other values are retired history). */
const ENGLISH_TAG = 'en';

const COLUMNS: ListColumns = {
  id: legalDocuments.id,
  type: legalDocuments.type,
  version: legalDocuments.version,
  isCurrent: legalDocuments.isCurrent,
  effectiveFrom: legalDocuments.effectiveFrom,
  createdAt: legalDocuments.createdAt,
};

/** The sorts the console list accepts. */
export type LegalDocumentSort = 'type' | 'version' | 'effectiveFrom' | 'createdAt' | 'id';

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
 * Tells whether an English version text already exists for a type.
 *
 * Why: a new version is always English, and `legal_documents_version_uq` is `(type, locale, version)`: a retired version of another
 * language may carry the same text (`3.2`, decision 039, section 4.4) and does not make the text taken.
 *
 * @param db the database or a transaction
 * @param type the document type
 * @param version the version text
 * @returns true when it exists
 */
export async function versionExists(db: DbExecutor, type: LegalDocumentType, version: string): Promise<boolean> {
  const [row] = await db
    .select({ id: legalDocuments.id })
    .from(legalDocuments)
    .where(
      and(eq(legalDocuments.type, type), eq(legalDocuments.locale, ENGLISH_TAG), eq(legalDocuments.version, version)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a draft version, tagged English: no version in another language can be created any more (decision 039).
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `legal_documents_version_uq`
 */
export async function insertVersion(db: DbExecutor, values: Omit<NewLegalDocument, 'locale'>): Promise<LegalDocument> {
  const [row] = await db
    .insert(legalDocuments)
    .values({ ...values, locale: ENGLISH_TAG })
    .returning();
  return row!;
}

/**
 * Takes the lock that serialises publishes of one type, held until the transaction ends.
 *
 * Why: two drafts of the same document published at once would each see the old current version, flip it, and both try to
 * become current (a violation of the one-current index). A row lock cannot cover it because the second publish does not see the
 * first one's new current row.
 *
 * @param db the caller's transaction
 * @param type the document type
 */
export async function lockPublish(db: DbExecutor, type: LegalDocumentType): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${LEGAL_PUBLISH_LOCK}, hashtext(${type}))`);
}

/**
 * Makes the version in force for a type stop being current, keeping its `effective_from`.
 *
 * @param db the caller's transaction (the publish lock is held)
 * @param type the document type
 * @returns the version that was replaced, or `undefined` when none was in force
 */
export async function retireCurrent(db: DbExecutor, type: LegalDocumentType): Promise<LegalDocument | undefined> {
  const [row] = await db
    .update(legalDocuments)
    .set({ isCurrent: false })
    .where(and(eq(legalDocuments.type, type), eq(legalDocuments.isCurrent, true)))
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
 * Finds the version in force for a type.
 *
 * Why: one version is in force per type (`legal_documents_current_uq`), and it is English (`legal_documents_locale_check`).
 *
 * @param db the database or a transaction
 * @param type the document type
 * @returns the current version, or `undefined` when none is in force
 */
export async function findCurrent(db: DbExecutor, type: LegalDocumentType): Promise<LegalDocument | undefined> {
  const [row] = await db
    .select()
    .from(legalDocuments)
    .where(and(eq(legalDocuments.type, type), eq(legalDocuments.isCurrent, true)))
    .limit(1);
  return row;
}

/**
 * Lists the version in force of every type.
 *
 * @param db the database or a transaction
 * @returns the current versions by type
 */
export async function listCurrentVersions(db: DbExecutor): Promise<LegalDocument[]> {
  return db.select().from(legalDocuments).where(eq(legalDocuments.isCurrent, true)).orderBy(asc(legalDocuments.type));
}
