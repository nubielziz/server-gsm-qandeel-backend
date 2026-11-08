// LegalDocumentAdminService: the use cases of the legal document routes (map domain H, stage 15): list, show, create a draft
// version and publish it. A version's text never changes; publishing swaps the current version of its type and language.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { LegalDocument, LegalDocumentType } from '../db/schema';
import { legalLabel, legalState } from '../domain/legal';
import { acceptedCounts } from '../infra/foreign-reads.repository';
import {
  type LegalDocumentSort,
  findVersion,
  insertVersion,
  listVersions,
  lockPublish,
  makeCurrent,
  retireCurrent,
  versionExists,
} from '../infra/legal-document.repository';

/** A version as the console reads it. */
export interface LegalDocumentView {
  readonly id: number;
  readonly type: LegalDocumentType;
  readonly version: string;
  readonly locale: string;
  readonly bodyMd: string;
  readonly effectiveFrom: string | null;
  readonly isCurrent: boolean;
  readonly requiresReacceptance: boolean;
  readonly createdAt: string;
  readonly acceptedCount: number | null;
}

/** The fields of `POST /admin/legal-documents`. */
export interface CreateLegalDocumentInput {
  readonly type: LegalDocumentType;
  readonly locale: string;
  readonly version: string;
  readonly bodyMd: string;
  readonly requiresReacceptance?: boolean | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No version has this id.' });

/** The 409 answer for a version that exists, naming the field the console highlights. */
function versionTaken(version: string): AppError {
  const message = `Version ${version} already exists for this document.`;
  return new AppError('VERSION_EXISTS', {
    detail: message,
    errors: [{ field: 'version', code: 'duplicate', message }],
  });
}

/** A version as the console reads it; `accepted` is the consent count, `null` for a version never published. */
function toView(version: LegalDocument, accepted: number | undefined): LegalDocumentView {
  return {
    id: version.id,
    type: version.type,
    version: version.version,
    locale: version.locale,
    bodyMd: version.bodyMd,
    effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
    isCurrent: version.isCurrent,
    requiresReacceptance: version.requiresReacceptance,
    createdAt: version.createdAt.toISOString(),
    acceptedCount: version.effectiveFrom === null ? null : (accepted ?? 0),
  };
}

const snapshot = (version: LegalDocument) => ({
  type: version.type,
  locale: version.locale,
  version: version.version,
  isCurrent: version.isCurrent,
  effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
});

/**
 * Manages the versions of the legal documents.
 *
 * Why: the terms, privacy, refund and cookie policies are versioned; a customer's consent points at the version in force when
 * it was given (RESOLUTIONS b2c-14), so a version is never edited, only replaced by a newer one. Publishing makes a draft the
 * one version in force for its type and language: the old one stops being current (its `effective_from` stays), the new one
 * takes effect now, in one transaction, serialised per type and language so two publishes never both become current.
 *
 * Side effects: writes `legal_documents` and `audit_logs` (entity `legal`).
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/legal-documents` sections)
 */
@Injectable()
export class LegalDocumentAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists versions with the number of consents each collected.
   *
   * @param query the parsed list request
   * @returns the page of versions and the exact total
   */
  async list(query: ParsedListQuery<LegalDocumentSort>): Promise<{ rows: LegalDocumentView[]; total: number }> {
    const { rows, total } = await listVersions(this.db.db, query);
    const counts = await acceptedCounts(
      this.db.db,
      rows.map((row) => row.id),
    );
    return { rows: rows.map((row) => toView(row, counts.get(row.id))), total };
  }

  /**
   * Shows one version.
   *
   * @param id the version id
   * @returns the version
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<LegalDocumentView> {
    const version = await findVersion(this.db.db, id);
    if (!version) throw notFound();
    const counts = await acceptedCounts(this.db.db, [id]);
    return toView(version, counts.get(id));
  }

  /**
   * Creates a draft version.
   *
   * @param input the type, language, version text and body
   * @param staffId the signed-in staff member (`created_by`)
   * @returns the new draft
   * @throws {AppError} `VERSION_EXISTS` (409 on `version`)
   */
  async create(input: CreateLegalDocumentInput, staffId: number): Promise<LegalDocumentView> {
    return this.db.runInTransaction(async ({ tx }) => {
      if (await versionExists(tx, input.type, input.locale, input.version)) throw versionTaken(input.version);
      let version;
      try {
        version = await insertVersion(tx, {
          type: input.type,
          locale: input.locale,
          version: input.version,
          bodyMd: input.bodyMd,
          requiresReacceptance: input.requiresReacceptance ?? true,
          isCurrent: false,
          effectiveFrom: null,
          createdBy: staffId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'legal_documents_version_uq')) throw versionTaken(input.version);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created legal document',
        entityType: 'legal',
        entityId: version.id,
        entityLabel: legalLabel(version),
        after: snapshot(version),
      });
      return toView(version, undefined);
    });
  }

  /**
   * Publishes a draft version: it becomes the one in force for its type and language.
   *
   * @param id the version id
   * @returns the published version
   * @throws {AppError} `NOT_FOUND` (404); `ALREADY_CURRENT` (409: it is the version in force); `NOT_A_DRAFT` (409: it was in
   *   force once and has been replaced)
   */
  async publish(id: number): Promise<LegalDocumentView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const found = await findVersion(tx, id);
      if (!found) throw notFound();
      // The publish lock first, then the row, then the state: the check below judges what the previous publish committed.
      await lockPublish(tx, found.type, found.locale);
      const draft = await findVersion(tx, id, true);
      if (!draft) throw notFound();
      const state = legalState(draft);
      if (state === 'current') {
        throw new AppError('ALREADY_CURRENT', { detail: `Version ${draft.version} is already in force.` });
      }
      if (state === 'earlier') {
        throw new AppError('NOT_A_DRAFT', {
          detail: `Version ${draft.version} was in force before and has been replaced. Create a new version instead.`,
        });
      }
      const replaced = await retireCurrent(tx, draft.type, draft.locale);
      const published = await makeCurrent(tx, id, this.clock.now());
      await this.audit.record(tx, {
        action: 'published legal document',
        entityType: 'legal',
        entityId: id,
        entityLabel: legalLabel(published),
        before: { version: replaced?.version ?? null },
        after: { version: published.version, effectiveFrom: published.effectiveFrom?.toISOString() ?? null },
      });
      return toView(published, 0);
    });
  }
}
