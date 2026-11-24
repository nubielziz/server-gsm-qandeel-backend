// HTTP controller of the rank change (decision 064): the console's `POST /admin/clients/:id/rank`. Thin: it maps the inputs to the use case and
// marks a replay.
import { Body, Controller, Header, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  type BodyOf,
  ContractHeaders,
  type HeadersOf,
  type ParamsOf,
  type ResultOf,
  Route,
} from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { AccountRankChange } from '../application/account-rank-change.service';
import { changeAccountRank } from '../contracts/account-rank.contracts';

/**
 * The route of the rank change.
 *
 * Why: staff change the rank of an account in one action that also moves its balance, ends its sessions and records the change, so it is
 * one route with a required `Idempotency-Key` and an Owner check (decision 064). The answer is never cached.
 *
 * @route POST /admin/clients/:id/rank
 */
@Controller()
export class AccountRankController {
  constructor(private readonly rankChange: AccountRankChange) {}

  /**
   * Gives an account another rank.
   *
   * @param staff the signed-in staff member (only an Owner may change a rank)
   * @param params the account id
   * @param body the new rank
   * @param headers the required `Idempotency-Key`
   * @param reply the reply, for the replay marker
   * @returns the rank now held, the live wallet, the amount moved, the journal id and the counts of sessions ended and keys revoked
   * @route POST /admin/clients/:id/rank
   */
  @Route(changeAccountRank)
  @Header('Cache-Control', 'no-store')
  async change(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof changeAccountRank>,
    @Body() body: BodyOf<typeof changeAccountRank>,
    @ContractHeaders() headers: HeadersOf<typeof changeAccountRank>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof changeAccountRank>> {
    const outcome = await this.rankChange.change(staff, params.id, body.groupId, headers['idempotency-key']);
    if (outcome.replayed) reply.header('idempotency-replayed', 'true');
    return outcome.result;
  }
}
