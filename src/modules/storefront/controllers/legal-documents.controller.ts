// HTTP controller of the legal document routes (map domain H, /admin/legal-documents, stage 15). Thin: the rules live in
// LegalDocumentAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { LegalDocumentAdminService } from '../application/legal-document-admin.service';
import {
  createLegalDocument,
  listLegalDocuments,
  publishLegalDocument,
  showLegalDocument,
} from '../contracts/legal-documents.contracts';

/**
 * The legal document routes.
 *
 * Why: staff version and approve the terms, privacy, refund and cookie policies customers consent to.
 *
 * @route GET /admin/legal-documents
 * @route GET /admin/legal-documents/:id
 * @route POST /admin/legal-documents
 * @route POST /admin/legal-documents/:id/publish
 */
@Controller()
export class LegalDocumentsController {
  constructor(private readonly documents: LegalDocumentAdminService) {}

  /**
   * Lists versions.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/legal-documents
   */
  @Route(listLegalDocuments)
  list(@Query() query: QueryOf<typeof listLegalDocuments>): Promise<ResultOf<typeof listLegalDocuments>> {
    return this.documents.list(query);
  }

  /**
   * Shows a version.
   *
   * @param params the version id
   * @returns the version
   * @route GET /admin/legal-documents/:id
   */
  @Route(showLegalDocument)
  show(@Param() params: ParamsOf<typeof showLegalDocument>): Promise<ResultOf<typeof showLegalDocument>> {
    return this.documents.show(params.id);
  }

  /**
   * Creates a draft version.
   *
   * @param staff the signed-in staff member (`created_by`)
   * @param body the type, language, version text and body
   * @returns the new draft
   * @route POST /admin/legal-documents
   */
  @Route(createLegalDocument)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createLegalDocument>,
  ): Promise<ResultOf<typeof createLegalDocument>> {
    return this.documents.create(body, staff.staffId);
  }

  /**
   * Publishes a draft version.
   *
   * @param params the version id
   * @returns the published version
   * @route POST /admin/legal-documents/:id/publish
   */
  @Route(publishLegalDocument)
  publish(@Param() params: ParamsOf<typeof publishLegalDocument>): Promise<ResultOf<typeof publishLegalDocument>> {
    return this.documents.publish(params.id);
  }
}
