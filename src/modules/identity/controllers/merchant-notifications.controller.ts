// HTTP controller of the merchant portal's notification settings (map domain G, stage 12, MISMATCHES B165). It lives in the identity module
// because it needs `CurrentAccount` and the account's own columns; the platform module imports no other module (decision 032). Thin: the
// rules are in `MerchantNotificationSettings`.
import { Body, Controller } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantNotificationSettings } from '../application/merchant-notification-settings.service';
import {
  merchantGetNotificationPreferences,
  merchantPutNotificationPreferences,
} from '../contracts/merchant-notifications.contracts';
import { CurrentAccount, type AccountPrincipal } from '../ports/account-principal';

/**
 * The merchant portal's notification routes.
 *
 * Why: B165. A merchant chooses what it is told about, by email. The routes serve the merchant ranks (the rank gate refuses a retail
 * account, which reads its own notifications on the store routes).
 *
 * @route GET /client/notification-preferences
 * @route PUT /client/notification-preferences
 */
@Controller()
export class MerchantNotificationsController {
  constructor(private readonly settings: MerchantNotificationSettings) {}

  /**
   * Reads the merchant's preferences.
   *
   * @param account the signed-in account
   * @returns the preferences screen's data
   * @route GET /client/notification-preferences
   */
  @Route(merchantGetNotificationPreferences)
  get(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof merchantGetNotificationPreferences>> {
    return this.settings.get(account.accountId);
  }

  /**
   * Saves the merchant's preferences.
   *
   * @param account the signed-in account
   * @param body the threshold and the events to replace
   * @returns the preferences after the save
   * @route PUT /client/notification-preferences
   */
  @Route(merchantPutNotificationPreferences)
  put(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantPutNotificationPreferences>,
  ): Promise<ResultOf<typeof merchantPutNotificationPreferences>> {
    return this.settings.update(account.accountId, body);
  }
}
