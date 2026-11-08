// The channels of the notifications: the mail transport and the Telegram client, with the driver each uses (decision 033). Needs only the
// configuration and the outbound HTTP service, so an app built without a database still has them.
import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { OutboundHttp } from '../../../infra/http';
import { InMemoryMailDriver, type MailDriver, SmtpMailDriver } from './mail-driver';
import { MAIL_DRIVER, MailTransport } from './mail-transport';
import { TELEGRAM_DRIVER, TelegramClient } from './telegram-client';
import { HttpTelegramDriver, InMemoryTelegramDriver, type TelegramDriver } from './telegram-driver';

/**
 * Provides {@link MailTransport} and {@link TelegramClient}.
 *
 * Why: decision 033: SMTP through nodemailer and the Telegram Bot API through `OutboundHttp`, with in-memory drivers under `NODE_ENV=test`
 * so no test opens a connection to a mail server or calls Telegram (the same isolation the test databases and Redis have). Feature 9's `mail`
 * health check calls `MailTransport.verify()`.
 */
@Module({
  providers: [
    {
      provide: MAIL_DRIVER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MailDriver =>
        config.env === 'test' ? new InMemoryMailDriver() : new SmtpMailDriver(config.mail.smtpUrl),
    },
    {
      provide: TELEGRAM_DRIVER,
      inject: [APP_CONFIG, OutboundHttp],
      useFactory: (config: AppConfig, http: OutboundHttp): TelegramDriver | undefined => {
        if (config.telegram.botToken === undefined) return undefined;
        return config.env === 'test'
          ? new InMemoryTelegramDriver()
          : new HttpTelegramDriver(http, config.telegram.botToken);
      },
    },
    MailTransport,
    TelegramClient,
  ],
  exports: [MailTransport, TelegramClient, MAIL_DRIVER, TELEGRAM_DRIVER],
})
export class NotificationTransportModule {}
