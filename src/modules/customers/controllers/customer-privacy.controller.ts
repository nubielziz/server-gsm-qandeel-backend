// HTTP controller of the admin customer privacy routes (map domain I, /admin/customers, stage 18): block, export and anonymize. Thin:
// the use cases are in CustomerBlockService and CustomerPrivacyService.
import { Body, Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, Route } from '../../../common/contract';
import { attachmentDisposition } from '../../../infra/storage';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { CustomerBlockService } from '../application/customer-block.service';
import { CustomerPrivacyService } from '../application/customer-privacy.service';
import { anonymizeCustomer, blockCustomer, exportCustomerData } from '../contracts/customer-privacy.contracts';

/**
 * The customer page's block, export and anonymize actions.
 *
 * Why: scenario b2c-account steps 8 and 9 and the data-protection requests (B49, B50). The export is a download that is never cached.
 *
 * @route POST /admin/customers/:id/block
 * @route GET /admin/customers/:id/export
 * @route POST /admin/customers/:id/anonymize
 */
@Controller()
export class CustomerPrivacyController {
  constructor(
    private readonly blocking: CustomerBlockService,
    private readonly privacy: CustomerPrivacyService,
  ) {}

  /**
   * Blocks or unblocks a customer.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body the switch and the reason
   * @route POST /admin/customers/:id/block
   */
  @Route(blockCustomer)
  async block(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof blockCustomer>,
    @Body() body: BodyOf<typeof blockCustomer>,
  ): Promise<void> {
    await this.blocking.setBlocked(staff.staffId, params.id, body);
  }

  /**
   * Downloads everything held about a customer.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param reply the reply, for the download headers
   * @returns the JSON file
   * @route GET /admin/customers/:id/export
   */
  @Route(exportCustomerData)
  async exportData(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof exportCustomerData>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const file = await this.privacy.exportData(staff.staffId, params.id);
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', attachmentDisposition(file.filename))
      .header('cache-control', 'no-store');
    return file.bytes;
  }

  /**
   * Anonymizes a customer.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @route POST /admin/customers/:id/anonymize
   */
  @Route(anonymizeCustomer)
  async anonymize(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof anonymizeCustomer>,
  ): Promise<void> {
    await this.privacy.anonymize(staff.staffId, params.id);
  }
}
