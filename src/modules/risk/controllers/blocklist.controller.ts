// HTTP controller of the blocklist routes (map domain K, stage 18). Thin: the rules live in BlocklistAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { BlocklistAdminService } from '../application/blocklist-admin.service';
import {
  createBlocklistEntry,
  deleteBlocklistEntry,
  getBlocklistEntry,
  listBlocklist,
} from '../contracts/blocklist.contracts';

/**
 * The console's Blocklist tab.
 *
 * Why: staff block an email, domain, IMEI or card by hand and lift a block (scenarios b2c-chargeback and b2c-account).
 *
 * @route GET /admin/blocklist
 * @route GET /admin/blocklist/:id
 * @route POST /admin/blocklist
 * @route DELETE /admin/blocklist/:id
 */
@Controller()
export class BlocklistController {
  constructor(private readonly blocklist: BlocklistAdminService) {}

  /**
   * Lists the entries.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/blocklist
   */
  @Route(listBlocklist)
  list(@Query() query: QueryOf<typeof listBlocklist>): Promise<ResultOf<typeof listBlocklist>> {
    return this.blocklist.list(query);
  }

  /**
   * Reads one entry.
   *
   * @param params the entry id
   * @returns the entry
   * @route GET /admin/blocklist/:id
   */
  @Route(getBlocklistEntry)
  show(@Param() params: ParamsOf<typeof getBlocklistEntry>): Promise<ResultOf<typeof getBlocklistEntry>> {
    return this.blocklist.get(params.id);
  }

  /**
   * Adds an entry.
   *
   * @param staff the signed-in staff member
   * @param body the kind, the value and the reason
   * @returns the new entry
   * @route POST /admin/blocklist
   */
  @Route(createBlocklistEntry)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createBlocklistEntry>,
  ): Promise<ResultOf<typeof createBlocklistEntry>> {
    return this.blocklist.create(staff.staffId, body);
  }

  /**
   * Removes an entry.
   *
   * @param params the entry id
   * @route DELETE /admin/blocklist/:id
   */
  @Route(deleteBlocklistEntry)
  async remove(@Param() params: ParamsOf<typeof deleteBlocklistEntry>): Promise<void> {
    await this.blocklist.remove(params.id);
  }
}
