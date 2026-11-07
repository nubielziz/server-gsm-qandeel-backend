// HTTP controllers of the identity verification (KYC): the staff routes (map stage 8) and the merchant portal's (MISMATCHES B161).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { KycService } from '../application/kyc.service';
import {
  decideKycSubmission,
  getKycSubmission,
  getMyKyc,
  listKycSubmissions,
  submitMyKyc,
} from '../contracts/kyc.contracts';
import { CurrentMerchant, CurrentStaff } from '../security/access-state';
import type { MerchantPrincipal, StaffPrincipal } from '../security/principal';

/**
 * The staff routes on verification requests.
 *
 * Why: thin layer over {@link KycService}.
 *
 * @route GET /admin/kyc-submissions
 * @route GET /admin/kyc-submissions/:id
 * @route POST /admin/kyc-submissions/:id/decide
 */
@Controller()
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  /**
   * Lists the requests.
   *
   * @param query sort, range and filters
   * @returns the page of requests
   * @route GET /admin/kyc-submissions
   */
  @Route(listKycSubmissions)
  list(@Query() query: QueryOf<typeof listKycSubmissions>): Promise<ResultOf<typeof listKycSubmissions>> {
    return this.kyc.list(query);
  }

  /**
   * Reads one request.
   *
   * @param params the request id
   * @returns the request
   * @route GET /admin/kyc-submissions/:id
   */
  @Route(getKycSubmission)
  show(@Param() params: ParamsOf<typeof getKycSubmission>): Promise<ResultOf<typeof getKycSubmission>> {
    return this.kyc.get(params.id);
  }

  /**
   * Approves or rejects a request.
   *
   * @param staff the signed-in staff member
   * @param params the request id
   * @param body the decision and the note
   * @returns the request after the decision
   * @route POST /admin/kyc-submissions/:id/decide
   */
  @Route(decideKycSubmission)
  decide(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof decideKycSubmission>,
    @Body() body: BodyOf<typeof decideKycSubmission>,
  ): Promise<ResultOf<typeof decideKycSubmission>> {
    return this.kyc.decide(staff.staffId, params.id, body);
  }
}

/**
 * The merchant's own verification routes.
 *
 * Why: thin layer over {@link KycService}; a merchant waiting for approval may call both (B153).
 *
 * @route GET /client/kyc
 * @route POST /client/kyc
 */
@Controller()
export class MerchantKycController {
  constructor(private readonly kyc: KycService) {}

  /**
   * The merchant's verification status and latest request.
   *
   * @param merchant the signed-in merchant
   * @returns the status and the latest request
   * @route GET /client/kyc
   */
  @Route(getMyKyc)
  show(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof getMyKyc>> {
    return this.kyc.mine(merchant.clientId);
  }

  /**
   * Submits documents for review.
   *
   * @param merchant the signed-in merchant
   * @param body the uploaded files and an optional note
   * @returns the status and the new request
   * @route POST /client/kyc
   */
  @Route(submitMyKyc)
  submit(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof submitMyKyc>,
  ): Promise<ResultOf<typeof submitMyKyc>> {
    return this.kyc.submit(merchant.clientId, body);
  }
}
