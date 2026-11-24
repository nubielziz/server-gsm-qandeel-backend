// HTTP controller of the admin account privacy routes (map domain I, /admin/clients, stage 18; decision 064): block, the privacy read,
// export and anonymize, for an account of any rank. Thin: the use cases are in CustomerBlockService and CustomerPrivacyService, the read is
// the `AccountPrivacyReads` port.
import { Body, Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { DbService } from '../../../infra/db';
import { attachmentDisposition } from '../../../infra/storage';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { CustomerBlockService } from '../application/customer-block.service';
import { CustomerPrivacyService } from '../application/customer-privacy.service';
import {
  anonymizeAccount,
  blockAccount,
  exportAccountData,
  readAccountPrivacy,
} from '../contracts/account-privacy.contracts';
import { AccountPrivacyReads } from '../ports/account-privacy-reads';

/**
 * The account page's block, privacy, export and anonymize actions.
 *
 * Why: scenario b2c-account steps 8 and 9 and the data-protection requests (B49, B50), for the one account type (decision 064): any rank
 * can be blocked and exported, the retail rank can be erased. The export is a download that is never cached.
 *
 * @route POST /admin/clients/:id/block
 * @route GET /admin/clients/:id/privacy
 * @route GET /admin/clients/:id/export
 * @route POST /admin/clients/:id/anonymize
 */
@Controller()
export class AccountPrivacyController {
  constructor(
    private readonly blocking: CustomerBlockService,
    private readonly privacy: CustomerPrivacyService,
    private readonly reads: AccountPrivacyReads,
    private readonly db: DbService,
  ) {}

  /**
   * Blocks or unblocks an account.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @param body the switch and the reason
   * @route POST /admin/clients/:id/block
   */
  @Route(blockAccount)
  async block(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof blockAccount>,
    @Body() body: BodyOf<typeof blockAccount>,
  ): Promise<void> {
    await this.blocking.setBlocked(staff.staffId, params.id, body);
  }

  /**
   * Reads the privacy facts of an account.
   *
   * @param params the account id
   * @returns the marketing choice, the latest consents and the risk summary
   * @route GET /admin/clients/:id/privacy
   */
  @Route(readAccountPrivacy)
  async readPrivacy(
    @Param() params: ParamsOf<typeof readAccountPrivacy>,
  ): Promise<ResultOf<typeof readAccountPrivacy>> {
    const privacy = await this.reads.privacyOf(this.db.db, params.id);
    // The port hands out read-only values; the wire type is plain.
    return {
      marketingOptIn: privacy.marketingOptIn,
      latestConsents:
        privacy.latestConsents === null
          ? null
          : {
              orderId: privacy.latestConsents.orderId,
              records: privacy.latestConsents.records.map((record) => ({ ...record })),
            },
      risk: {
        highestScore: privacy.risk.highestScore,
        signals: privacy.risk.signals.map((signal) => ({ ...signal })),
      },
    };
  }

  /**
   * Downloads everything held about an account.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @param reply the reply, for the download headers
   * @returns the JSON file
   * @route GET /admin/clients/:id/export
   */
  @Route(exportAccountData)
  async exportData(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof exportAccountData>,
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
   * Anonymizes an account of the retail rank.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @route POST /admin/clients/:id/anonymize
   */
  @Route(anonymizeAccount)
  async anonymize(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof anonymizeAccount>,
  ): Promise<void> {
    await this.privacy.anonymize(staff.staffId, params.id);
  }
}
