// HTTP controller of the merchant portal's account area (map domain A, stage 2): profile, password and two-factor sign-in. Thin: the
// rules live in the application services behind the ports (decision 064).
import { Body, Controller, Header } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantAccountService } from '../application/merchant-account.service';
import {
  merchantChangePassword,
  merchantDisableTwoFactor,
  merchantEnableTwoFactor,
  merchantSetupTwoFactor,
  merchantUpdateProfile,
} from '../contracts/merchant-account.contracts';
import { AccountOwnPassword, AccountTwoFactorSetup } from '../ports/account-auth';
import { CurrentAccount, type AccountPrincipal } from '../ports/account-principal';

/**
 * The merchant portal's account routes.
 *
 * Why: B130 to B134. A merchant manages its own profile, password and authenticator. The password and the authenticator are the use
 * cases every account shares (`AccountOwnPassword`, `AccountTwoFactorSetup`); an account without a password is refused with 409. Answers
 * that carry a secret say `Cache-Control: no-store`.
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
    private readonly passwords: AccountOwnPassword,
    private readonly twoFactor: AccountTwoFactorSetup,
  ) {}

  /**
   * Updates the profile.
   *
   * @param account the signed-in account
   * @param body the fields to change
   * @returns the account after the change
   * @route PATCH /client/profile
   */
  @Route(merchantUpdateProfile)
  updateProfile(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantUpdateProfile>,
  ): Promise<ResultOf<typeof merchantUpdateProfile>> {
    return this.account.updateProfile(account, body);
  }

  /**
   * Changes the password.
   *
   * @param account the signed-in account
   * @param body the current and the new password
   * @route POST /client/security/password
   */
  @Route(merchantChangePassword)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantChangePassword>,
  ): Promise<void> {
    await this.passwords.change(account, body);
  }

  /**
   * Starts the authenticator setup.
   *
   * @param account the signed-in account
   * @returns the secret, the `otpauth://` link and the QR code
   * @route POST /client/security/2fa/setup
   */
  @Route(merchantSetupTwoFactor)
  @Header('Cache-Control', 'no-store')
  setupTwoFactor(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof merchantSetupTwoFactor>> {
    return this.twoFactor.setup(account);
  }

  /**
   * Turns two-factor sign-in on.
   *
   * @param account the signed-in account
   * @param body the code
   * @route POST /client/security/2fa/enable
   */
  @Route(merchantEnableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async enableTwoFactor(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantEnableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.enable(account, body.code);
  }

  /**
   * Turns two-factor sign-in off.
   *
   * @param account the signed-in account
   * @param body the code
   * @route POST /client/security/2fa/disable
   */
  @Route(merchantDisableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async disableTwoFactor(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantDisableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.disable(account, body.code);
  }
}
