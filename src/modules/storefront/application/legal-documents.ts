// CurrentLegalDocuments: the one read of the legal documents other modules and the public routes use. It answers which version of
// the terms, privacy, refund and cookie policy is in force (a checkout's consent records point at it, the storefront config lists
// it, `GET /store/v1/pages/:slug` serves it) and finds a version by id (features 14a and 15, RESOLUTIONS b2c-14).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { LegalDocument, LegalDocumentType } from '../db/schema';
import { findCurrent, findVersion, listCurrentVersions } from '../infra/legal-document.repository';

/** A legal document version as other modules may know it: no body, just which text it is. */
export interface LegalDocumentRef {
  /** The `legal_document_id` a consent records. */
  readonly id: number;
  readonly type: LegalDocumentType;
  readonly locale: string;
  readonly version: string;
  /** Always set for a version in force; `null` for a draft. */
  readonly effectiveFrom: Date | null;
  readonly isCurrent: boolean;
  readonly requiresReacceptance: boolean;
}

/** The language every document exists in; the fallback when the buyer's language has no current version. */
export const FALLBACK_LOCALE = 'en';

const toRef = (row: LegalDocument): LegalDocumentRef => ({
  id: row.id,
  type: row.type,
  locale: row.locale,
  version: row.version,
  effectiveFrom: row.effectiveFrom,
  isCurrent: row.isCurrent,
  requiresReacceptance: row.requiresReacceptance,
});

/**
 * Reads the legal documents in force.
 *
 * Why: B2C consent is proof (scenario b2c-paid, RESOLUTIONS b2c-14: "publishing makes it the version new consents reference"):
 * every consent record stores the version of the text the buyer saw, so the checkout asks which version is current at that
 * moment, and it must be the very version the console's Legal page shows as current. The storefront module owns
 * `legal_documents`; the customers module asks this class (decision 016). It holds no connection: every method takes the
 * caller's database handle or transaction.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class CurrentLegalDocuments {
  /**
   * Finds the version in force of a document for a language, falling back to English.
   *
   * @param db the database or the caller's transaction
   * @param type `terms`, `privacy`, `refund` or `cookies`
   * @param locale the buyer's language
   * @returns the current version, or `undefined` when neither the language nor English has one in force
   */
  async current(db: DbExecutor, type: LegalDocumentType, locale: string): Promise<LegalDocumentRef | undefined> {
    const row =
      (await findCurrent(db, type, locale)) ??
      (locale === FALLBACK_LOCALE ? undefined : await findCurrent(db, type, FALLBACK_LOCALE));
    return row === undefined ? undefined : toRef(row);
  }

  /**
   * Finds the version in force of a document in exactly one language, with its text, for the public page route.
   *
   * Why: a page in a language that has no version in force is a plain 404; it is never shown in another language.
   *
   * @param db the database or the caller's transaction
   * @param type the document type
   * @param locale the language
   * @returns the row, or `undefined` when none is in force in that language
   */
  async currentWithBody(db: DbExecutor, type: LegalDocumentType, locale: string): Promise<LegalDocument | undefined> {
    return findCurrent(db, type, locale);
  }

  /**
   * Finds a version by id.
   *
   * @param db the database or the caller's transaction
   * @param id the version id
   * @returns the version (a draft or an earlier one too), or `undefined` when it does not exist
   */
  async find(db: DbExecutor, id: number): Promise<LegalDocumentRef | undefined> {
    const row = await findVersion(db, id);
    return row ? toRef(row) : undefined;
  }

  /**
   * Lists every current version.
   *
   * @param db the database or the caller's transaction
   * @returns the current documents by type then language
   */
  async listCurrent(db: DbExecutor): Promise<LegalDocumentRef[]> {
    return (await listCurrentVersions(db)).map(toRef);
  }
}
