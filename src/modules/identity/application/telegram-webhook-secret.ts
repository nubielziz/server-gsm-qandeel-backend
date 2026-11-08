// Registers the secret of `POST /webhooks/telegram/:secret` with the URL secret guard (identity module, feature 12a, MISMATCHES B165).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { UrlSecretVerifiers } from '../security/machine/url-secrets';

/** The manifest key of the webhook. */
export const TELEGRAM_WEBHOOK_KEY = 'POST /webhooks/telegram/:secret';
/** The header Telegram repeats the secret in (`setWebhook`'s `secret_token`), lower case. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Tells the guard where the Telegram webhook's secret comes from.
 *
 * Why: the `url-secret` access kind compares the path secret in constant time; this source gives it `TELEGRAM_WEBHOOK_SECRET`, asks it to
 * compare the `X-Telegram-Bot-Api-Secret-Token` header as well (both must match), and to answer `404` when either does not, so the route
 * does not show itself to a scanner. With no secret configured every call is refused.
 *
 * Side effects: registers one source with `UrlSecretVerifiers` at boot.
 */
@Injectable()
export class TelegramWebhookSecret implements OnModuleInit {
  constructor(
    private readonly sources: UrlSecretVerifiers,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Registers the source. */
  onModuleInit(): void {
    this.sources.register({
      routeKey: TELEGRAM_WEBHOOK_KEY,
      header: TELEGRAM_SECRET_HEADER,
      refusal: 'not_found',
      load: () => {
        const secret = this.config.telegram.webhookSecret;
        return secret === undefined ? null : { form: 'secret', value: secret };
      },
    });
  }
}
