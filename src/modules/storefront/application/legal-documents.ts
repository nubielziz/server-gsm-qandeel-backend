// CurrentLegalDocuments: which version of the terms, the privacy policy, the refund policy and the cookie policy is in force.
// The storefront config lists them and a checkout's consent records point at them (feature 14a, RESOLUTIONS b2c-14).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { LegalDocumentType } from '../db/schema';
import { findCurrentLegalDocument, listCurrentLegalDocuments } from '../infra/legal.repository';

/** A legal document version as other modules may know it: no body, just which text it is. */
export interface LegalDocumentRef {
  readonly id: number;
  readonly type: LegalDocumentType;
  readonly version: string;
  readonly locale: string;
  /** When the version took effect; `null` is not possible for a current version in practice but the column allows it. */
  readonly effectiveFrom: Date | null;
}

/** The language every document exists in; the fallback when the buyer's language has no current version. */
export const FALLBACK_LOCALE = 'en';

/**
 * Reads the legal documents in force.
 *
 * Why: B2C consent is proof (scenario b2c-paid, RESOLUTIONS b2c-14): every consent record stores the version of the text the
 * buyer saw, so the checkout asks which version is current at that moment. The storefront module owns `legal_documents`; the
 * customers module asks this class (decision 016).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class CurrentLegalDocuments {
  /**
   * Finds the current version of a document for a language, falling back to English.
   *
   * @param db the database or a transaction
   * @param type the document type
   * @param locale the buyer's language
   * @returns the current version, or `undefined` when neither the language nor English has one
   */
  async current(db: DbExecutor, type: LegalDocumentType, locale: string): Promise<LegalDocumentRef | undefined> {
    const row =
      (await findCurrentLegalDocument(db, type, locale)) ??
      (locale === FALLBACK_LOCALE ? undefined : await findCurrentLegalDocument(db, type, FALLBACK_LOCALE));
    return row === undefined ? undefined : toRef(row);
  }

  /**
   * Lists every current version.
   *
   * @param db the database or a transaction
   * @returns the current documents by type then language
   */
  async listCurrent(db: DbExecutor): Promise<LegalDocumentRef[]> {
    return (await listCurrentLegalDocuments(db)).map(toRef);
  }
}

function toRef(row: {
  id: number;
  type: LegalDocumentType;
  version: string;
  locale: string;
  effectiveFrom: Date | null;
}): LegalDocumentRef {
  return { id: row.id, type: row.type, version: row.version, locale: row.locale, effectiveFrom: row.effectiveFrom };
}
