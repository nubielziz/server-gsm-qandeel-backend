// HTTP controller of the two-step sign-in routes of a retail account (decision 064; routes beyond the map, scripts/map-additions/48-accounts.mjs).
// Thin: the three routes call the same port as `/client/security/2fa/*`, so the authenticator setup is one use case for every account with a password.
import { Body, Controller, Header } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { type AccountPrincipal, AccountTwoFactorSetup, CurrentAccount } from '../../identity';
import {
  storeDisableTwoFactor,
  storeEnableTwoFactor,
  storeSetupTwoFactor,
} from '../contracts/store-two-factor.contracts';

/**
 * The shop's two-step sign-in routes.
 *
 * Why: two-step sign-in is for every account with a password, of any rank (decision 064); a retail account manages it on the `/store/v1`
 * family, a merchant rank on `/client/security/2fa/*`, and both run `AccountTwoFactorSetup`. An account without a password is refused with
 * 409 by the use case. Answers that carry a secret say `Cache-Control: no-store`.
 *
 * @route POST /store/v1/me/2fa/setup
 * @route POST /store/v1/me/2fa/enable
 * @route POST /store/v1/me/2fa/disable
 */
@Controller()
export class StoreTwoFactorController {
  constructor(private readonly twoFactor: AccountTwoFactorSetup) {}

  /**
   * Starts the authenticator setup.
   *
   * @param account the signed-in retail account
   * @returns the secret, the `otpauth://` link and the QR code
   * @route POST /store/v1/me/2fa/setup
   */
  @Route(storeSetupTwoFactor)
  @Header('Cache-Control', 'no-store')
  setup(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof storeSetupTwoFactor>> {
    return this.twoFactor.setup(account);
  }

  /**
   * Turns two-step sign-in on.
   *
   * @param account the signed-in retail account
   * @param body the code
   * @route POST /store/v1/me/2fa/enable
   */
  @Route(storeEnableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async enable(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof storeEnableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.enable(account, body.code);
  }

  /**
   * Turns two-step sign-in off.
   *
   * @param account the signed-in retail account
   * @param body the code
   * @route POST /store/v1/me/2fa/disable
   */
  @Route(storeDisableTwoFactor)
  @Header('Cache-Control', 'no-store')
  async disable(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof storeDisableTwoFactor>,
  ): Promise<void> {
    await this.twoFactor.disable(account, body.code);
  }
}
