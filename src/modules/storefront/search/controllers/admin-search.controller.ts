// HTTP controller of the console's search index tools (feature 29, plan sections 5.1 and 6): the index status and "Rebuild index". Thin:
// the rules live in SearchAdminService. Decision 068 retired the synonym, pin, hidden-term, report and preview routes.
import { Controller } from '@nestjs/common';
import { type ResultOf, Route } from '../../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../../identity';
import { SearchAdminService } from '../application/search-admin.service';
import { getSearchIndex, rebuildSearchIndex } from '../contracts/admin-search.contracts';

/**
 * The staff routes of the shop search index.
 *
 * Why: staff watch the index and start a rebuild (owner question 5; the Search tab keeps only the index panel, decision 068); reading
 * needs `storefront:read`, a rebuild `storefront:publish`.
 *
 * @route GET /admin/search/index
 * @route POST /admin/search/index/rebuild
 */
@Controller()
export class AdminSearchController {
  constructor(private readonly admin: SearchAdminService) {}

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
