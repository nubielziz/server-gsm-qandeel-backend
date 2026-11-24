// HTTP controller of the merchant portal's account area (map domain A, stage 2): profile, password and two-factor sign-in. Thin: the
// rules live in the application services.
import { Body, Controller, Header } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantAccountService } from '../application/merchant-account.service';
import { MerchantPasswordService } from '../application/merchant-password.service';
import { MerchantTwoFactorService } from '../application/merchant-two-factor.service';
import {
  merchantChangePassword,
  merchantDisableTwoFactor,
  merchantEnableTwoFactor,
  merchantSetupTwoFactor,
  merchantUpdateProfile,
} from '../contracts/merchant-account.contracts';
import { CurrentMerchant } from '../security/access-state';
import type { MerchantPrincipal } from '../security/principal';
import { wireMe } from './merchant-auth.controller';

/**
 * The merchant portal's account routes.
 *
 * Why: B130 to B134. A merchant manages its own profile, password and authenticator. Every route is open to a
 * merchant waiting for approval (B153). Answers that carry a secret say `Cache-Control: no-store`.
 *
 * @route PATCH /client/profile
 * @route POST /client/security/password
 * @route POST /client/security/2fa/setup
 * @route POST /client/security/2fa/enable
 * @route POST /client/security/2fa/disable
 */
@Controller()
export class MerchantAccountController {
  constructor(
    private readonly account: MerchantAccountService,
    private readonly passwords: MerchantPasswordService,
    private readonly twoFactor: MerchantTwoFactorService,
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
}
