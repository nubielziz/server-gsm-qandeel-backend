// HTTP controller of the lookup of old merchant and customer numbers (decision 064). Thin; the rule lives in ClientAdminService.
import { Controller, Param } from '@nestjs/common';
import { type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { ClientAdminService } from '../application/client-admin.service';
import { findLegacyAccount } from '../contracts/legacy-accounts.contracts';

/**
 * The legacy lookup route.
 *
 * Why: an old customer number is never an account id, so every reader of an old number (bookmarks, history, links) asks which account it
 * belongs to instead of guessing (decision 064).
 *
 * @route GET /admin/legacy-accounts/:type/:id
 */
@Controller()
export class LegacyAccountsController {
  constructor(private readonly clients: ClientAdminService) {}

  /**
   * Finds the account of an old number.
   *
   * @param params the old kind of number and the number
   * @returns the account id
   * @route GET /admin/legacy-accounts/:type/:id
   */
  @Route(findLegacyAccount)
  find(@Param() params: ParamsOf<typeof findLegacyAccount>): Promise<ResultOf<typeof findLegacyAccount>> {
    return this.clients.legacyAccount(params.type, params.id);
  }
}
