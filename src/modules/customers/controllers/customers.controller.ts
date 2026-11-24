// HTTP controller of the retired admin customer routes (map domain I, /admin/customers, stage 14, scenario b2c-account). Since decision 064 a
// customer is an account of the retail rank: the one list, the detail, the create, the edit, the account, the password, the sessions and the
// suspension of every account are the routes of `/admin/clients` (the identity module). These nine addresses answer 410 ROUTE_RETIRED and
// change nothing. The contract release deletes this file.
import { Controller } from '@nestjs/common';
import { Route } from '../../../common/contract';
import { routeRetired } from '../application/customer-errors';
import {
  createCustomerAccount,
  reactivateCustomer,
  revokeCustomerSessions,
  setCustomerPassword,
  suspendCustomer,
} from '../contracts/customer-actions.contracts';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from '../contracts/customers.contracts';

/**
 * The retired routes of the console's Customers page.
 *
 * Why: decision 064: there are no compatibility adapters. The old address stays registered during the expand release and answers
 * `410 ROUTE_RETIRED` naming the account route to use, so a client that still calls it learns what to call; nothing is read or written.
 * The access check of the route (session, permission, CSRF token) and the validation of its old contract still come first, so a request the
 * old contract refuses is 422 and a valid one is 410.
 *
 * @route GET /admin/customers
 * @route GET /admin/customers/:id
 * @route POST /admin/customers
 * @route PATCH /admin/customers/:id
 * @route POST /admin/customers/:id/account
 * @route POST /admin/customers/:id/password
 * @route POST /admin/customers/:id/sessions/revoke
 * @route POST /admin/customers/:id/suspend
 * @route POST /admin/customers/:id/reactivate
 */
@Controller()
export class CustomersController {
  /**
   * Answers that the customer list moved to the account list.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route GET /admin/customers
   */
  @Route(listCustomers)
  list(): never {
    throw routeRetired('GET /admin/clients');
  }

  /**
   * Answers that the customer detail moved to the account detail.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route GET /admin/customers/:id
   */
  @Route(getCustomer)
  show(): never {
    throw routeRetired('GET /admin/clients/:id');
  }

  /**
   * Answers that adding a customer moved to the account create.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers
   */
  @Route(createCustomer)
  create(): never {
    throw routeRetired('POST /admin/clients');
  }

  /**
   * Answers that editing a customer moved to the account edit.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route PATCH /admin/customers/:id
   */
  @Route(updateCustomer)
  update(): never {
    throw routeRetired('PATCH /admin/clients/:id');
  }

  /**
   * Answers that making an account of a guest moved to the account routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/account
   */
  @Route(createCustomerAccount)
  account(): never {
    throw routeRetired('POST /admin/clients/:id/account');
  }

  /**
   * Answers that the password tools moved to the account security routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/password
   */
  @Route(setCustomerPassword)
  password(): never {
    throw routeRetired('POST /admin/clients/:id/password');
  }

  /**
   * Answers that ending the sessions moved to the account security routes.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/sessions/revoke
   */
  @Route(revokeCustomerSessions)
  revokeSessions(): never {
    throw routeRetired('POST /admin/clients/:id/sessions/revoke');
  }

  /**
   * Answers that a suspension moved to the status of the account edit.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/suspend
   */
  @Route(suspendCustomer)
  suspend(): never {
    throw routeRetired('PATCH /admin/clients/:id with a status');
  }

  /**
   * Answers that a reactivation moved to the status of the account edit.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/reactivate
   */
  @Route(reactivateCustomer)
  reactivate(): never {
    throw routeRetired('PATCH /admin/clients/:id with a status');
  }
}
