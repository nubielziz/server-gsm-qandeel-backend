// HTTP controller of the merchant portal's account area (map domain A, stage 2): profile, password, two-factor sign-in and the
// merchant's own sessions. Thin: the rules live in the application services.
import { Body, Controller, Header, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantAccountService } from '../application/merchant-account.service';
import { MerchantPasswordService } from '../application/merchant-password.service';
import { MerchantSessionsService } from '../application/merchant-sessions.service';
import { MerchantTwoFactorService } from '../application/merchant-two-factor.service';
import {
  merchantChangePassword,
  merchantDisableTwoFactor,
  merchantEnableTwoFactor,
  merchantEndSession,
  merchantListSessions,
  merchantSetupTwoFactor,
  merchantUpdateProfile,
} from '../contracts/merchant-account.contracts';
import { CurrentMerchant } from '../security/access-state';
import type { MerchantPrincipal } from '../security/principal';
import { SessionCookies } from '../security/session-cookies';
import { wireMe } from './merchant-auth.controller';

/**
 * The merchant portal's account routes.
 *
 * Why: B130 to B136. A merchant manages its own profile, password, authenticator and devices. Every route is open to a
 * merchant waiting for approval (B153). Answers that carry a secret say `Cache-Control: no-store`.
 *
 * @route PATCH /client/profile
 * @route POST /client/security/password
 * @route POST /client/security/2fa/setup
 * @route POST /client/security/2fa/enable
 * @route POST /client/security/2fa/disable
 * @route GET /client/sessions
 * @route DELETE /client/sessions/:id
 */
@Controller()
export class MerchantAccountController {
  constructor(
    private readonly account: MerchantAccountService,
    private readonly passwords: MerchantPasswordService,
    private readonly twoFactor: MerchantTwoFactorService,
    private readonly sessions: MerchantSessionsService,
    private readonly cookies: SessionCookies,
  ) {}

  /**
   * Updates the profile.
   *
   * @param merchant the signed-in merchant
   * @param body the fields to change
   * @returns the merchant after the change
   * @route PATCH /client/profile
   */
  @Route(merchantUpdateProfile)
  async updateProfile(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantUpdateProfile>,
  ): Promise<ResultOf<typeof merchantUpdateProfile>> {
    return wireMe(await this.account.updateProfile(merchant, body));
  }

  /**
   * Changes the password.
   *
   * @param merchant the signed-in merchant
   * @param body the current and the new password
   * @route POST /client/security/password
   */
  @Route(merchantChangePassword)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantChangePassword>,
  ): Promise<void> {
    await this.passwords.change(merchant, body);
  }

  /**
   * Starts the authenticator setup.
   *
   * @param merchant the signed-in merchant
   * @returns the secret, the `otpauth://` link and the QR code
   * @route POST /client/security/2fa/setup
   */
  @Route(merchantSetupTwoFactor)
  @Header('Cache-Control', 'no-store')
  setupTwoFactor(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof merchantSetupTwoFactor>> {
    return this.twoFactor.setup(merchant);
  }

  /**
   * Turns two-factor sign-in on.
   *
   * @param merchant the signed-in merchant
   * @param body the code
   * @route POST /client/security/2fa/enable
   */
  @Route(merchantEnableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async enableTwoFactor(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantEnableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.enable(merchant, body.code);
  }

  /**
   * Turns two-factor sign-in off.
   *
   * @param merchant the signed-in merchant
   * @param body the code
   * @route POST /client/security/2fa/disable
   */
  @Route(merchantDisableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async disableTwoFactor(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantDisableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.disable(merchant, body.code);
  }

  /**
   * Lists the merchant's live sessions.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed range and sort
   * @returns the rows and the exact total
   * @route GET /client/sessions
   */
  @Route(merchantListSessions)
  async listSessions(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof merchantListSessions>,
  ): Promise<ResultOf<typeof merchantListSessions>> {
    const { rows, total } = await this.sessions.list(merchant, {
      offset: query.range.start,
      limit: query.range.limit,
      sort: query.sort,
    });
    return {
      rows: rows.map((row) => ({
        ...row,
        lastSeenAt: row.lastSeenAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * Ends one session.
   *
   * @param merchant the signed-in merchant
   * @param params the session id
   * @param reply the reply, to clear the cookies when the caller ended its own session
   * @route DELETE /client/sessions/:id
   */
  @Route(merchantEndSession)
  async endSession(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof merchantEndSession>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const { current } = await this.sessions.end(merchant, params.id);
    if (current) this.cookies.clear(reply, 'client');
  }
}
