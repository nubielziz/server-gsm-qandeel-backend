// HTTP controllers of the data-subject requests (map domain K, stage 18): the staff list and the customer's own two requests. Thin: the
// rules live in DataRequestService.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { DataRequestService } from '../application/data-request.service';
import {
  getDataRequest,
  listDataRequests,
  requestMyDataErasure,
  requestMyDataExport,
  updateDataRequest,
} from '../contracts/data-requests.contracts';
import { CurrentStoreCustomer, type StoreCustomer } from './store-customer';

/**
 * The console's data requests tab.
 *
 * Why: the privacy law gives a customer a right to a copy of their data and to its erasure, and the shop 30 days to answer.
 *
 * @route GET /admin/data-requests
 * @route GET /admin/data-requests/:id
 * @route PATCH /admin/data-requests/:id
 */
@Controller()
export class DataRequestsController {
  constructor(private readonly requests: DataRequestService) {}

  /**
   * Lists the requests.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/data-requests
   */
  @Route(listDataRequests)
  list(@Query() query: QueryOf<typeof listDataRequests>): Promise<ResultOf<typeof listDataRequests>> {
    return this.requests.list(query);
  }

  /**
   * Reads one request.
   *
   * @param params the request id
   * @returns the request
   * @route GET /admin/data-requests/:id
   */
  @Route(getDataRequest)
  show(@Param() params: ParamsOf<typeof getDataRequest>): Promise<ResultOf<typeof getDataRequest>> {
    return this.requests.get(params.id);
  }

  /**
   * Moves a request.
   *
   * @param staff the signed-in staff member
   * @param params the request id
   * @param body the new status and the note
   * @returns the request after the move
   * @route PATCH /admin/data-requests/:id
   */
  @Route(updateDataRequest)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateDataRequest>,
    @Body() body: BodyOf<typeof updateDataRequest>,
  ): Promise<ResultOf<typeof updateDataRequest>> {
    return this.requests.move(staff.staffId, params.id, body);
  }
}

/**
 * The storefront account's privacy buttons.
 *
 * Why: the customer asks for a copy of their data or for anonymization; the shop answers within 30 days (RESOLUTIONS b2c-13).
 *
 * @route POST /store/v1/me/data-export
 * @route POST /store/v1/me/data-delete
 */
@Controller()
export class StorePrivacyController {
  constructor(private readonly requests: DataRequestService) {}

  /**
   * Asks for a copy of the customer's data.
   *
   * @param customer the session's customer
   * @returns the request
   * @route POST /store/v1/me/data-export
   */
  @Route(requestMyDataExport)
  @Header('Cache-Control', 'no-store')
  requestExport(@CurrentStoreCustomer() customer: StoreCustomer): Promise<ResultOf<typeof requestMyDataExport>> {
    return this.requests.request(customer.customerId, 'export');
  }

  /**
   * Asks to be anonymized.
   *
   * @param customer the session's customer
   * @returns the request
   * @route POST /store/v1/me/data-delete
   */
  @Route(requestMyDataErasure)
  @Header('Cache-Control', 'no-store')
  requestErasure(@CurrentStoreCustomer() customer: StoreCustomer): Promise<ResultOf<typeof requestMyDataErasure>> {
    return this.requests.request(customer.customerId, 'erasure');
  }
}
