// HTTP controller of the console's search tools (feature 29, plan sections 5.1 and 6): synonyms, pin rules, hidden terms, the report, the
// preview and the index. Thin: the rules live in SearchAdminService and SearchReportService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../../identity';
import { SearchAdminService } from '../application/search-admin.service';
import { SearchReportService } from '../application/search-report.service';
import {
  createHiddenSearchTerm,
  createSearchPin,
  createSearchSynonym,
  deleteHiddenSearchTerm,
  deleteSearchPin,
  deleteSearchSynonym,
  getSearchIndex,
  getSearchReport,
  listHiddenSearchTerms,
  listSearchPins,
  listSearchSynonyms,
  previewSearch,
  rebuildSearchIndex,
  updateSearchPin,
  updateSearchSynonym,
} from '../contracts/admin-search.contracts';

/**
 * The staff routes of the shop search.
 *
 * Why: staff own the synonyms, the pinned and hidden results and the hidden popular terms, read what visitors searched for and watch the
 * index (owner question 5); reading needs `storefront:read`, writing `storefront:update`, a rebuild `storefront:publish`.
 *
 * @route GET /admin/search/synonyms
 * @route POST /admin/search/synonyms
 * @route PATCH /admin/search/synonyms/:id
 * @route DELETE /admin/search/synonyms/:id
 * @route GET /admin/search/pins
 * @route POST /admin/search/pins
 * @route PATCH /admin/search/pins/:id
 * @route DELETE /admin/search/pins/:id
 * @route GET /admin/search/hidden-terms
 * @route POST /admin/search/hidden-terms
 * @route DELETE /admin/search/hidden-terms/:id
 * @route GET /admin/search/report
 * @route GET /admin/search/preview
 * @route GET /admin/search/index
 * @route POST /admin/search/index/rebuild
 */
@Controller()
export class AdminSearchController {
  constructor(
    private readonly admin: SearchAdminService,
    private readonly report: SearchReportService,
  ) {}

  /**
   * Lists synonyms.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/search/synonyms
   */
  @Route(listSearchSynonyms)
  listSynonyms(@Query() query: QueryOf<typeof listSearchSynonyms>): Promise<ResultOf<typeof listSearchSynonyms>> {
    return this.admin.listSynonyms(query);
  }

  /**
   * Creates a synonym.
   *
   * @param body kind, root, terms, switch and note
   * @param staff the signed-in staff member
   * @returns the synonym
   * @route POST /admin/search/synonyms
   */
  @Route(createSearchSynonym)
  createSynonym(
    @Body() body: BodyOf<typeof createSearchSynonym>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof createSearchSynonym>> {
    return this.admin.createSynonym(body, staff.staffId);
  }

  /**
   * Changes a synonym.
   *
   * @param params the synonym id
   * @param body the keys to change
   * @returns the synonym
   * @route PATCH /admin/search/synonyms/:id
   */
  @Route(updateSearchSynonym)
  updateSynonym(
    @Param() params: ParamsOf<typeof updateSearchSynonym>,
    @Body() body: BodyOf<typeof updateSearchSynonym>,
  ): Promise<ResultOf<typeof updateSearchSynonym>> {
    return this.admin.updateSynonym(params.id, body);
  }

  /**
   * Deletes a synonym.
   *
   * @param params the synonym id
   * @returns nothing (`204`)
   * @route DELETE /admin/search/synonyms/:id
   */
  @Route(deleteSearchSynonym)
  deleteSynonym(@Param() params: ParamsOf<typeof deleteSearchSynonym>): Promise<void> {
    return this.admin.deleteSynonym(params.id);
  }

  /**
   * Lists pin rules.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/search/pins
   */
  @Route(listSearchPins)
  listPins(@Query() query: QueryOf<typeof listSearchPins>): Promise<ResultOf<typeof listSearchPins>> {
    return this.admin.listPins(query);
  }

  /**
   * Creates a pin rule.
   *
   * @param body query, match, pinned and hidden services, window, switch and note
   * @param staff the signed-in staff member
   * @returns the rule
   * @route POST /admin/search/pins
   */
  @Route(createSearchPin)
  createPin(
    @Body() body: BodyOf<typeof createSearchPin>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof createSearchPin>> {
    return this.admin.createPin(body, staff.staffId);
  }

  /**
   * Changes a pin rule.
   *
   * @param params the rule id
   * @param body the keys to change
   * @returns the rule
   * @route PATCH /admin/search/pins/:id
   */
  @Route(updateSearchPin)
  updatePin(
    @Param() params: ParamsOf<typeof updateSearchPin>,
    @Body() body: BodyOf<typeof updateSearchPin>,
  ): Promise<ResultOf<typeof updateSearchPin>> {
    return this.admin.updatePin(params.id, body);
  }

  /**
   * Deletes a pin rule.
   *
   * @param params the rule id
   * @returns nothing (`204`)
   * @route DELETE /admin/search/pins/:id
   */
  @Route(deleteSearchPin)
  deletePin(@Param() params: ParamsOf<typeof deleteSearchPin>): Promise<void> {
    return this.admin.deletePin(params.id);
  }

  /**
   * Lists the hidden popular terms.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/search/hidden-terms
   */
  @Route(listHiddenSearchTerms)
  listHiddenTerms(
    @Query() query: QueryOf<typeof listHiddenSearchTerms>,
  ): Promise<ResultOf<typeof listHiddenSearchTerms>> {
    return this.admin.listHiddenTerms(query);
  }

  /**
   * Hides a term from the popular searches.
   *
   * @param body the term and a note
   * @param staff the signed-in staff member
   * @returns the hidden term
   * @route POST /admin/search/hidden-terms
   */
  @Route(createHiddenSearchTerm)
  hideTerm(
    @Body() body: BodyOf<typeof createHiddenSearchTerm>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof createHiddenSearchTerm>> {
    return this.admin.hideTerm(body, staff.staffId);
  }

  /**
   * Shows a hidden term again.
   *
   * @param params the hidden term id
   * @returns nothing (`204`)
   * @route DELETE /admin/search/hidden-terms/:id
   */
  @Route(deleteHiddenSearchTerm)
  showTerm(@Param() params: ParamsOf<typeof deleteHiddenSearchTerm>): Promise<void> {
    return this.admin.showTerm(params.id);
  }

  /**
   * Reads the search report.
   *
   * @param query the window in days
   * @returns the totals, the top terms and the no-result terms
   * @route GET /admin/search/report
   */
  @Route(getSearchReport)
  getReport(@Query() query: QueryOf<typeof getSearchReport>): Promise<ResultOf<typeof getSearchReport>> {
    return this.report.report(query.days);
  }

  /**
   * Previews a search with the rules applied.
   *
   * @param query the query to test
   * @returns the first 10 services and the hidden ids
   * @route GET /admin/search/preview
   */
  @Route(previewSearch)
  preview(@Query() query: QueryOf<typeof previewSearch>): Promise<ResultOf<typeof previewSearch>> {
    return this.admin.preview(query.q);
  }

  /**
   * Reads the index status.
   *
   * @returns the engine state, the counts, the jobs and the last error
   * @route GET /admin/search/index
   */
  @Route(getSearchIndex)
  index(): Promise<ResultOf<typeof getSearchIndex>> {
    return this.admin.indexStatus();
  }

  /**
   * Asks for a rebuild of the index.
   *
   * @param staff the signed-in staff member
   * @returns the running rebuild (`202`)
   * @route POST /admin/search/index/rebuild
   */
  @Route(rebuildSearchIndex)
  rebuild(@CurrentStaff() staff: StaffPrincipal): Promise<ResultOf<typeof rebuildSearchIndex>> {
    return this.admin.requestRebuild(staff.staffId);
  }
}
