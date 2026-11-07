// HTTP controller of the merchant management routes (map domain A, /admin/clients, stage 2). Thin; the rules live in
// ClientAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ClientAdminService } from '../application/client-admin.service';
import { createClient, listClients, showClient, updateClient } from '../contracts/clients.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The merchant management routes.
 *
 * Why: staff invite, approve, suspend and group merchants (RULES merchants).
 *
 * @route GET /admin/clients
 * @route GET /admin/clients/:id
 * @route POST /admin/clients
 * @route PATCH /admin/clients/:id
 */
@Controller()
export class ClientsController {
  constructor(private readonly clients: ClientAdminService) {}

  /**
   * Lists merchants.
   *
   * @param caller the signed-in staff member
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/clients
   */
  @Route(listClients)
  list(
    @CurrentStaff() caller: StaffPrincipal,
    @Query() query: QueryOf<typeof listClients>,
  ): Promise<ResultOf<typeof listClients>> {
    return this.clients.list(caller, query);
  }

  /**
   * Shows a merchant.
   *
   * @param caller the signed-in staff member
   * @param params the merchant id
   * @returns the merchant
   * @route GET /admin/clients/:id
   */
  @Route(showClient)
  show(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof showClient>,
  ): Promise<ResultOf<typeof showClient>> {
    return this.clients.show(caller, params.id);
  }

  /**
   * Invites a merchant.
   *
   * @param caller the signed-in staff member
   * @param body the new merchant
   * @returns the merchant
   * @route POST /admin/clients
   */
  @Route(createClient)
  create(
    @CurrentStaff() caller: StaffPrincipal,
    @Body() body: BodyOf<typeof createClient>,
  ): Promise<ResultOf<typeof createClient>> {
    return this.clients.create(caller, body);
  }

  /**
   * Approves, suspends, reactivates or regroups a merchant.
   *
   * @param caller the signed-in staff member
   * @param params the merchant id
   * @param body the change
   * @returns the updated merchant
   * @route PATCH /admin/clients/:id
   */
  @Route(updateClient)
  update(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateClient>,
    @Body() body: BodyOf<typeof updateClient>,
  ): Promise<ResultOf<typeof updateClient>> {
    return this.clients.update(caller, params.id, body);
  }
}
