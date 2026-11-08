// HTTP controller of the merchant portal's commission routes (map domain F, stage 11, MISMATCHES B164): the referral page and the
// merchant's own commissions. Thin: the rules live in ClientReferrals and AccrualReader.
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentMerchant, type MerchantPrincipal } from '../../identity';
import { AccrualReader } from '../application/accrual-reader.service';
import { ClientReferrals } from '../application/client-referrals.service';
import { getMyReferrals, listMyCommissions } from '../contracts/client-commissions.contracts';

/**
 * The merchant portal commission routes.
 *
 * Why: an agent follows its referral link and the commissions it earns; a merchant never reaches another merchant's records, so
 * both routes answer for the signed-in merchant only. A pending merchant is refused by the guard (B153).
 *
 * @route GET /client/referrals
 * @route GET /client/commissions
 */
@Controller()
export class ClientCommissionsController {
  constructor(
    private readonly referrals: ClientReferrals,
    private readonly accruals: AccrualReader,
  ) {}

  /**
   * The merchant's referral page.
   *
   * @param merchant the signed-in merchant
   * @returns the code, the link, the plan and the referred merchants
   * @route GET /client/referrals
   */
  @Route(getMyReferrals)
  mine(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof getMyReferrals>> {
    return this.referrals.of(merchant.clientId);
  }

  /**
   * The merchant's own commissions.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /client/commissions
   */
  @Route(listMyCommissions)
  commissions(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof listMyCommissions>,
  ): Promise<ResultOf<typeof listMyCommissions>> {
    return this.accruals.listOwn(merchant.clientId, query);
  }
}
