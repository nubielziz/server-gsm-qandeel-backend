// HTTP controller of the three order routes that involve a supplier (dispatch, fetch, change-supplier; stage 6). Thin: it maps the staff
// member and the inputs to OrderSupplierActions.
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { OrderSupplierActions } from '../application/order-supplier-actions.service';
import { changeOrderSupplier, dispatchOrder, fetchOrder } from '../contracts/order-supplier.contracts';

/**
 * The supplier actions on one order.
 *
 * Why: scenario timeout step 10 and the order drawer's Retry and Reroute: staff send an order to its supplier, fetch the supplier's
 * result or change the supplier. The routes are the order engine's; the use cases live in the suppliers module (they read the links).
 *
 * @route POST /admin/orders/:id/dispatch
 * @route POST /admin/orders/:id/fetch
 * @route POST /admin/orders/:id/change-supplier
 */
@Controller()
export class OrderSupplierController {
  constructor(private readonly actions: OrderSupplierActions) {}

  /**
   * Sends an order to its supplier now.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/dispatch
   */
  @Route(dispatchOrder)
  dispatch(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof dispatchOrder>): Promise<void> {
    return this.actions.dispatch(staff.staffId, params.id);
  }

  /**
   * Fetches the supplier's result now.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/fetch
   */
  @Route(fetchOrder)
  fetch(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof fetchOrder>): Promise<void> {
    return this.actions.fetch(staff.staffId, params.id);
  }

  /**
   * Changes the supplier of an order.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the target supplier, the reference reset and the dispatch flag
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/change-supplier
   */
  @Route(changeOrderSupplier)
  changeSupplier(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof changeOrderSupplier>,
    @Body() body: BodyOf<typeof changeOrderSupplier>,
  ): Promise<void> {
    return this.actions.changeSupplier(staff.staffId, params.id, body);
  }
}
