// HTTP controller of the retired admin customer privacy routes (map domain I, /admin/customers, stage 18): block, export and anonymize.
// Since decision 064 a customer is an account of the retail rank, and the account routes (account-privacy.controller.ts) do the work for
// every rank; these three addresses answer 410 ROUTE_RETIRED and change nothing. The contract release deletes this file.
import { Controller } from '@nestjs/common';
import { Route } from '../../../common/contract';
import { routeRetired } from '../application/customer-errors';
import { anonymizeCustomer, blockCustomer, exportCustomerData } from '../contracts/customer-privacy.contracts';

/**
 * The retired block, export and anonymize routes of the customer page.
 *
 * Why: decision 064: there are no compatibility adapters; the old address stays registered during the expand release so that a client
 * that still calls it learns what to call. Nothing is read or written. The access check of the route (session, permission, CSRF token)
 * and the validation of its old contract still come first, so a request the old contract refuses is 422 and a valid one is 410.
 *
 * @route POST /admin/customers/:id/block
 * @route GET /admin/customers/:id/export
 * @route POST /admin/customers/:id/anonymize
 */
@Controller()
export class CustomerPrivacyController {
  /**
   * Answers that the block moved to the account routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/block
   */
  @Route(blockCustomer)
  block(): never {
    throw routeRetired('POST /admin/clients/:id/block');
  }

  /**
   * Answers that the export moved to the account routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route GET /admin/customers/:id/export
   */
  @Route(exportCustomerData)
  exportData(): never {
    throw routeRetired('GET /admin/clients/:id/export');
  }

  /**
   * Answers that the erasure moved to the account routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/anonymize
   */
  @Route(anonymizeCustomer)
  anonymize(): never {
    throw routeRetired('POST /admin/clients/:id/anonymize');
  }
}
