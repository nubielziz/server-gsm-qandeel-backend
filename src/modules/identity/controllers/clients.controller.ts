// HTTP controller of the account routes of the staff console (map domain A, /admin/clients). Thin: the reads are ClientAdminService and
// AccountCountsService, the writes are ClientWriteService.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { AccountCountsService } from '../application/account-counts.service';
import { ClientAdminService } from '../application/client-admin.service';
import { ClientWriteService } from '../application/client-write.service';
import { countClients, createClient, listClients, showClient, updateClient } from '../contracts/clients.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The account routes.
 *
 * Why: staff look at every account, whatever its rank, make accounts and change their status and details (RULES merchants, decision 064).
 *
 * @route GET /admin/clients
 * @route GET /admin/clients/counts
 * @route GET /admin/clients/:id
 * @route POST /admin/clients
 * @route PATCH /admin/clients/:id
 */
@Controller()
export class ClientsController {
  constructor(
    private readonly clients: ClientAdminService,
    private readonly counts: AccountCountsService,
    private readonly writes: ClientWriteService,
  ) {}

  /**
   * Lists accounts of every rank.
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
   * Counts the accounts.
   *
   * @returns the numbers of the chips and the header sentence
   * @route GET /admin/clients/counts
   */
  @Route(countClients)
  count(): Promise<ResultOf<typeof countClients>> {
    return this.counts.counts();
  }

  /**
   * Shows an account.
   *
   * @param caller the signed-in staff member
   * @param params the account id
   * @returns the account
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
   * Makes an account. The answer is never cached: it may carry a temporary password.
   *
   * @param caller the signed-in staff member
   * @param body the new account
   * @returns the account, and the temporary password once when staff chose that mode
   * @route POST /admin/clients
   */
  @Route(createClient)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentStaff() caller: StaffPrincipal,
    @Body() body: BodyOf<typeof createClient>,
  ): Promise<ResultOf<typeof createClient>> {
    // The write answers the id (and the temporary password once); the row is read again after its commit, as the detail shows it.
    const created = await this.writes.create(caller, body);
    const account = await this.clients.show(caller, created.id);
    return created.temporaryPassword === undefined
      ? account
      : { ...account, temporaryPassword: created.temporaryPassword };
  }

  /**
   * Changes the status or the details of an account.
   *
   * @param caller the signed-in staff member
   * @param params the account id
   * @param body the change
   * @returns the updated account
   * @throws {AppError} `VALIDATION_FAILED` (422, field `groupId`, code `use_rank_route`) when the body names a rank: ranks change through
   *   `POST /admin/clients/:id/rank`
   * @route PATCH /admin/clients/:id
   */
  @Route(updateClient)
  async update(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateClient>,
    @Body() body: BodyOf<typeof updateClient>,
  ): Promise<ResultOf<typeof updateClient>> {
    const { groupId, ...change } = body;
    if (groupId !== undefined) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            field: 'groupId',
            code: 'use_rank_route',
            message: 'Change the rank with the rank route, not with an edit.',
          },
        ],
      });
    }
    await this.writes.update(caller, params.id, change);
    return this.clients.show(caller, params.id);
  }
}
