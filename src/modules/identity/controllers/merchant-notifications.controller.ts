// HTTP controller of the merchant portal's notification settings and of Telegram's update webhook (map domain G, stage 12, MISMATCHES
// B165). It lives in the identity module because it needs `CurrentMerchant` and the merchant's own columns; the platform module imports no
// other module (decision 032). Thin: the rules are in `MerchantNotificationSettings` and `TelegramLinking`.
import { Body, Controller, Header, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantNotificationSettings } from '../application/merchant-notification-settings.service';
import { TelegramLinking } from '../application/telegram-linking.service';
import {
  merchantCreateTelegramLink,
  merchantGetNotificationPreferences,
  merchantPutNotificationPreferences,
  telegramWebhook,
} from '../contracts/merchant-notifications.contracts';
import { CurrentMerchant } from '../security/access-state';
import type { MerchantPrincipal } from '../security/principal';

/**
 * The merchant portal's notification routes and the Telegram webhook.
 *
 * Why: B165. A merchant chooses what it is told about and connects a Telegram chat; Telegram's bot calls the webhook with the updates of that chat.
 *
 * @route GET /client/notification-preferences
 * @route PUT /client/notification-preferences
 * @route POST /client/telegram/link
 * @route POST /webhooks/telegram/:secret
 */
@Controller()
export class MerchantNotificationsController {
  constructor(
    private readonly settings: MerchantNotificationSettings,
    private readonly telegram: TelegramLinking,
  ) {}

  /**
   * Reads the merchant's preferences.
   *
   * @param merchant the signed-in merchant
   * @returns the preferences screen's data
   * @route GET /client/notification-preferences
   */
  @Route(merchantGetNotificationPreferences)
  get(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof merchantGetNotificationPreferences>> {
    return this.settings.get(merchant.clientId);
  }

  /**
   * Saves the merchant's preferences.
   *
   * @param merchant the signed-in merchant
   * @param body the threshold and the events to replace
   * @returns the preferences after the save
   * @route PUT /client/notification-preferences
   */
  @Route(merchantPutNotificationPreferences)
  put(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantPutNotificationPreferences>,
  ): Promise<ResultOf<typeof merchantPutNotificationPreferences>> {
    return this.settings.update(merchant.clientId, body);
  }

  /**
   * Makes a one-time link to connect Telegram.
   *
   * @param merchant the signed-in merchant
   * @returns the link and its expiry
   * @route POST /client/telegram/link
   */
  @Route(merchantCreateTelegramLink)
  @Header('Cache-Control', 'no-store')
  link(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof merchantCreateTelegramLink>> {
    return this.telegram.createLink(merchant.clientId, merchant.ip);
  }

  /**
   * Handles a Telegram update.
   *
   * @param _params the path secret (checked by the guard before this runs)
   * @param body the update
   * @returns an empty object: Telegram needs a quick 200
   * @route POST /webhooks/telegram/:secret
   */
  @Route(telegramWebhook)
  async webhook(
    @Param() _params: ParamsOf<typeof telegramWebhook>,
    @Body() body: BodyOf<typeof telegramWebhook>,
  ): Promise<ResultOf<typeof telegramWebhook>> {
    await this.telegram.handleUpdate(body);
    return {};
  }
}
