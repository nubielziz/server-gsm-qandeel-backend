// HTTP controller of the admin customer routes (map domain I, /admin/customers, stage 14, scenario b2c-account). Thin: the use
// cases are in CustomerAdminService and CustomerAccountAdminService.
import { Body, Controller, Header, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal, requestMetaOf } from '../../identity';
import { CustomerAccountAdminService } from '../application/customer-account-admin.service';
import { CustomerAdminService } from '../application/customer-admin.service';
import {
  createCustomerAccount,
  reactivateCustomer,
  revokeCustomerSessions,
  setCustomerPassword,
  suspendCustomer,
} from '../contracts/customer-actions.contracts';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from '../contracts/customers.contracts';

/**
 * The customer routes of the console's Customers page.
 *
 * Why: staff look customers up, add one with an account, edit the details, manage the password and the sessions, and suspend or
 * reactivate an account (scenario b2c-account). A response that carries a temporary password is never cached.
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
  constructor(
    private readonly customers: CustomerAdminService,
    private readonly actions: CustomerAccountAdminService,
  ) {}

  /**
   * Lists customers.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/customers
   */
  @Route(listCustomers)
  list(@Query() query: QueryOf<typeof listCustomers>): Promise<ResultOf<typeof listCustomers>> {
    return this.customers.list(query);
  }

  /**
   * Reads one customer with the detail figures.
   *
   * @param params the customer id
   * @returns the detail
   * @route GET /admin/customers/:id
   */
  @Route(getCustomer)
  show(@Param() params: ParamsOf<typeof getCustomer>): Promise<ResultOf<typeof getCustomer>> {
    return this.customers.get(params.id);
  }

  /**
   * Adds a customer with an account.
   *
   * @param staff the signed-in staff member
   * @param body the new customer
   * @param request the request (its address goes into the invitation record)
   * @returns the customer, and the temporary password in that mode
   * @route POST /admin/customers
   */
  @Route(createCustomer)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createCustomer>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof createCustomer>> {
    const { password, ...fields } = body;
    const created = await this.customers.create(staff, { ...fields, mode: password.mode }, requestMetaOf(request).ip);
    return {
      ...created.customer,
      ...(created.temporaryPassword === undefined ? {} : { temporaryPassword: created.temporaryPassword }),
    };
  }

  /**
   * Edits a customer.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body the fields to change
   * @param request the request (its address goes into a verification-link record)
   * @returns the customer after the edit
   * @route PATCH /admin/customers/:id
   */
  @Route(updateCustomer)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateCustomer>,
    @Body() body: BodyOf<typeof updateCustomer>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof updateCustomer>> {
    return this.customers.update(staff, params.id, body, requestMetaOf(request).ip);
  }

  /**
   * Creates an account for a guest.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body how the customer gets a password
   * @param request the request (its address goes into the invitation record)
   * @returns the temporary password in that mode
   * @route POST /admin/customers/:id/account
   */
  @Route(createCustomerAccount)
  @Header('Cache-Control', 'no-store')
  account(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof createCustomerAccount>,
    @Body() body: BodyOf<typeof createCustomerAccount>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof createCustomerAccount>> {
    return this.actions.createAccount(staff, params.id, body.mode, requestMetaOf(request).ip);
  }

  /**
   * Sends a password link or sets a temporary password.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body the mode and whether to end the sessions
   * @param request the request (its address goes into the link record)
   * @returns the temporary password in that mode
   * @route POST /admin/customers/:id/password
   */
  @Route(setCustomerPassword)
  @Header('Cache-Control', 'no-store')
  password(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof setCustomerPassword>,
    @Body() body: BodyOf<typeof setCustomerPassword>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof setCustomerPassword>> {
    return this.actions.setPassword(staff, params.id, body, requestMetaOf(request).ip);
  }

  /**
   * Signs the customer out of every device.
   *
   * @param params the customer id
   * @route POST /admin/customers/:id/sessions/revoke
   */
  @Route(revokeCustomerSessions)
  async revokeSessions(@Param() params: ParamsOf<typeof revokeCustomerSessions>): Promise<void> {
    await this.actions.revokeSessions(params.id);
  }

  /**
   * Suspends an active customer.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body the reason and note
   * @route POST /admin/customers/:id/suspend
   */
  @Route(suspendCustomer)
  async suspend(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof suspendCustomer>,
    @Body() body: BodyOf<typeof suspendCustomer>,
  ): Promise<void> {
    await this.actions.suspend(staff, params.id, body);
  }

  /**
   * Reactivates a suspended customer.
   *
   * @param params the customer id
   * @route POST /admin/customers/:id/reactivate
   */
  @Route(reactivateCustomer)
  async reactivate(@Param() params: ParamsOf<typeof reactivateCustomer>): Promise<void> {
    await this.actions.reactivate(params.id);
  }
}
