// HTTP controller of the code inventory routes (map domain B, stage 5). Thin: the rules live in InventoryAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { InventoryAdminService } from '../application/inventory-admin.service';
import { importInventoryCodes, listInventoryCodes, voidInventoryCodes } from '../contracts/inventory.contracts';

/**
 * The code inventory routes.
 *
 * Why: staff stock, import and void the digital codes that some services deliver.
 *
 * @route GET /admin/inventory-codes
 * @route POST /admin/services/:id/inventory/import
 * @route POST /admin/inventory-codes/void
 */
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryAdminService) {}

  /**
   * Lists stocked codes, masked.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/inventory-codes
   */
  @Route(listInventoryCodes)
  list(@Query() query: QueryOf<typeof listInventoryCodes>): Promise<ResultOf<typeof listInventoryCodes>> {
    return this.inventory.list(query);
  }

  /**
   * Imports codes into a service.
   *
   * @param staff the caller
   * @param params the service id
   * @param body the pasted lines and an optional batch reference
   * @returns the counts and the batch reference
   * @route POST /admin/services/:id/inventory/import
   */
  @Route(importInventoryCodes)
  import(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof importInventoryCodes>,
    @Body() body: BodyOf<typeof importInventoryCodes>,
  ): Promise<ResultOf<typeof importInventoryCodes>> {
    return this.inventory.import(staff.staffId, params.id, body);
  }

  /**
   * Voids unsold codes.
   *
   * @param body the code ids
   * @returns how many were voided and skipped
   * @route POST /admin/inventory-codes/void
   */
  @Route(voidInventoryCodes)
  void(@Body() body: BodyOf<typeof voidInventoryCodes>): Promise<ResultOf<typeof voidInventoryCodes>> {
    return this.inventory.void(body.ids);
  }
}
