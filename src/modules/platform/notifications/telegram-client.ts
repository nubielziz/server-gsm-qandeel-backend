// TelegramClient: the one door of the platform to Telegram (decision 033). Without a bot token every send fails with a clear reason and
// nothing is called.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { DeliveryError } from './delivery-error';
import type { TelegramDriver } from './telegram-driver';

/** The Nest token of the {@link TelegramDriver} behind {@link TelegramClient}; `MailModule` picks the HTTP or the in-memory driver. */
export const TELEGRAM_DRIVER = Symbol('TELEGRAM_DRIVER');

/** The reason recorded when Telegram is not set up (decision 033). */
export const TELEGRAM_NOT_CONFIGURED = 'Telegram is not configured.';

/**
 * Sends Telegram messages.
 *
 * Why: decision 033: `sendMessage` to a linked chat through the Bot API. With no `TELEGRAM_BOT_TOKEN` (development) a send is recorded
 * as `failed` with the reason "Telegram is not configured." and nothing is called.
 *
 * Side effects: one Bot API call per message (never under `NODE_ENV=test`, where the driver is in memory).
 */
@Injectable()
export class TelegramClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(TELEGRAM_DRIVER) private readonly driver?: TelegramDriver,
  ) {}

  /** True when a bot token is configured. */
  get configured(): boolean {
    return this.config.telegram.botToken !== undefined && this.driver !== undefined;
  }

  /**
   * Sends a message to a chat.
   *
   * @param chatId the Telegram chat id
   * @param text the message, plain text
   * @returns nothing: it resolves when Telegram accepted the message
   * @throws {DeliveryError} `permanent` with "Telegram is not configured." when there is no bot token; otherwise what the driver reports
   */
  sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.driver || this.config.telegram.botToken === undefined) {
      return Promise.reject(new DeliveryError(TELEGRAM_NOT_CONFIGURED, { permanent: true }));
    }
    return this.driver.sendMessage(chatId, text);
  }
}
