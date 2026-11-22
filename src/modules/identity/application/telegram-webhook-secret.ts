// Registers the secret of `POST /webhooks/telegram/:secret` with the URL secret guard (identity module, feature 12a, MISMATCHES B165, decision 054).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { hashToken } from '../../../infra/crypto';
import { type StoredUrlSecret, UrlSecretVerifiers } from '../security/machine/url-secrets';

/** The manifest key of the webhook. */
export const TELEGRAM_WEBHOOK_KEY = 'POST /webhooks/telegram/:secret';
/** The header Telegram repeats its secret value in (`setWebhook`'s `secret_token`), lower case. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
/** The labels the two webhook values are derived with (decision 054). */
export const TELEGRAM_PATH_LABEL = 'telegram-webhook-path';
/** The label of the header value (decision 054). */
export const TELEGRAM_HEADER_LABEL = 'telegram-webhook-header';

/**
 * The path segment of `POST /webhooks/telegram/:secret`.
 *
 * Why: decision 054: the path and the header are two values derived from the configured secret, so an address read from a log is not
 * enough to call the webhook, and the secret itself never travels; `scripts/telegram-webhook.ts` registers both with Telegram.
 *
 * @param secret `TELEGRAM_WEBHOOK_SECRET`
 * @returns HMAC-SHA256 of the path label keyed with the secret, 64 hex characters
 */
export function telegramWebhookPath(secret: string): string {
  return hashToken(secret, TELEGRAM_PATH_LABEL);
}

/**
 * The `X-Telegram-Bot-Api-Secret-Token` value.
 *
 * Why: decision 054, as {@link telegramWebhookPath}: a different value from the path's, derived with its own label.
 *
 * @param secret `TELEGRAM_WEBHOOK_SECRET`
 * @returns HMAC-SHA256 of the header label keyed with the secret, 64 hex characters (Telegram's `secret_token` allows them)
 */
export function telegramWebhookHeader(secret: string): string {
  return hashToken(secret, TELEGRAM_HEADER_LABEL);
}

/**
 * Tells the guard where the Telegram webhook's secret comes from.
 *
 * Why: the `url-secret` access kind compares the path segment in constant time; this source gives it the two values derived from
 * `TELEGRAM_WEBHOOK_SECRET` (decision 054), asks it to compare the `X-Telegram-Bot-Api-Secret-Token` header against its own value as
 * well (both must match), and to answer `404` when either does not, so the route does not show itself to a scanner. With no secret
 * configured every call is refused.
 *
 * Side effects: registers one source with `UrlSecretVerifiers` at boot; derives the two values once.
 */
@Injectable()
export class TelegramWebhookSecret implements OnModuleInit {
  private stored: StoredUrlSecret | null = null;

  constructor(
    private readonly sources: UrlSecretVerifiers,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Derives the stored form once and registers the source. */
  onModuleInit(): void {
    const secret = this.config.telegram.webhookSecret;
    this.stored =
      secret === undefined
        ? null
        : { form: 'secret', value: telegramWebhookPath(secret), header: telegramWebhookHeader(secret) };
    this.sources.register({
      routeKey: TELEGRAM_WEBHOOK_KEY,
      header: TELEGRAM_SECRET_HEADER,
      refusal: 'not_found',
      load: () => this.stored,
    });
  }
}
