// HTTP controller of the price changes (feature 31, decision 040, spec B230, /admin/retail-price-changes). Thin: the rules live in
// RetailPriceChangesService.
import { Body, Controller, Query } from '@nestjs/common';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { RetailPriceChangesService } from '../application/retail-price-changes.service';
import { listRetailPriceChanges, resolveRetailPriceChanges } from '../contracts/retail-price-changes.contracts';

/**
 * The price changes routes.
 *
 * Why: decision 040: following prices move without a staff action, so staff read every move here and answer the ones that wait.
 *
 * @route GET /admin/retail-price-changes
 * @route POST /admin/retail-price-changes/resolve
 */
@Controller()
export class RetailPriceChangesController {
  constructor(private readonly changes: RetailPriceChangesService) {}

  /**
   * Lists the price changes.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/retail-price-changes
   */
  @Route(listRetailPriceChanges)
  list(@Query() query: QueryOf<typeof listRetailPriceChanges>): Promise<ResultOf<typeof listRetailPriceChanges>> {
    return this.changes.list(query);
  }

  /**
   * Answers proposals.
   *
   * @param staff the signed-in staff member
   * @param body the proposals, the answer and, to approve, the figures the list showed
   * @returns how many were applied and kept, and what was skipped
   * @route POST /admin/retail-price-changes/resolve
   */
  @Route(resolveRetailPriceChanges)
  resolve(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof resolveRetailPriceChanges>,
  ): Promise<ResultOf<typeof resolveRetailPriceChanges>> {
    return this.changes.resolve(staff.staffId, body);
  }
}
