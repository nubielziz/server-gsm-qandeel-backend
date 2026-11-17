// CurrentLegalDocuments: the one read of the legal documents other modules and the public routes use. It answers which version of
// the terms, privacy, refund and cookie policy is in force (a checkout's consent records point at it, the storefront config lists
// it, `GET /store/v1/pages/:slug` serves it) and finds a version by id (features 14a and 15, RESOLUTIONS b2c-14). English only
// (decision 039): one version is in force per type and it is English; a retired version in another language is evidence and is
// reached only by id.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { LegalDocument, LegalDocumentType } from '../db/schema';
import { findCurrent, findVersion, listCurrentVersions } from '../infra/legal-document.repository';

/** A legal document version as other modules may know it: no body, just which text it is. */
export interface LegalDocumentRef {
  /** The `legal_document_id` a consent records. */
  readonly id: number;
  readonly type: LegalDocumentType;
  readonly version: string;
  /** Always set for a version in force; `null` for a draft. */
  readonly effectiveFrom: Date | null;
  readonly isCurrent: boolean;
  readonly requiresReacceptance: boolean;
}

const toRef = (row: LegalDocument): LegalDocumentRef => ({
  id: row.id,
  type: row.type,
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
   * Finds the version in force of a document.
   *
   * Why: a consent records the version the buyer saw; the one in force is English (`legal_documents_locale_check`).
   *
   * @param db the database or the caller's transaction
   * @param type `terms`, `privacy`, `refund` or `cookies`
   * @returns the current version, or `undefined` when none is in force
   */
  async current(db: DbExecutor, type: LegalDocumentType): Promise<LegalDocumentRef | undefined> {
    const row = await findCurrent(db, type);
    return row === undefined ? undefined : toRef(row);
  }

  /**
   * Finds the version in force of a document with its text, for the public page route.
   *
   * Why: a document with no version in force is a plain 404; a retired version in another language is never served.
   *
   * @param db the database or the caller's transaction
   * @param type the document type
   * @returns the row, or `undefined` when none is in force
   */
  async currentWithBody(db: DbExecutor, type: LegalDocumentType): Promise<LegalDocument | undefined> {
    return findCurrent(db, type);
  }

  /**
   * Finds a version by id.
   *
   * @param db the database or the caller's transaction
   * @param id the version id
   * @returns the version (a draft, an earlier or a retired one too), or `undefined` when it does not exist
   */
  async find(db: DbExecutor, id: number): Promise<LegalDocumentRef | undefined> {
    const row = await findVersion(db, id);
    return row ? toRef(row) : undefined;
  }

  /**
   * Lists every current version.
   *
   * @param db the database or the caller's transaction
   * @returns the current documents by type
   */
  async listCurrent(db: DbExecutor): Promise<LegalDocumentRef[]> {
    return (await listCurrentVersions(db)).map(toRef);
  }
}
