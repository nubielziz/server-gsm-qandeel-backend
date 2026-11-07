// Drizzle queries on legal_documents for the storefront (feature 14a): the current version of each document. Read only; the
// admin routes that create and publish versions arrive with feature 15.
import { and, asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type LegalDocument, type LegalDocumentType, legalDocuments } from '../db/schema';

/**
 * Reads the current version of a document in a language.
 *
 * @param db the database or a transaction
 * @param type the document type
 * @param locale the language
 * @returns the current version, or `undefined` when none is published in that language
 */
export async function findCurrentLegalDocument(
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
 * Reads every current document, in every language.
 *
 * @param db the database or a transaction
 * @returns the current versions by type then language
 */
export async function listCurrentLegalDocuments(db: DbExecutor): Promise<LegalDocument[]> {
  return db
    .select()
    .from(legalDocuments)
    .where(eq(legalDocuments.isCurrent, true))
    .orderBy(asc(legalDocuments.type), asc(legalDocuments.locale));
}
