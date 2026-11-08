// MailTransport: the one door of the platform to email (decision 033). `send` is used by the delivery job; `verify` is what feature 9's
// `mail` health check calls.
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import type { MailDriver } from './mail-driver';

/** The Nest token of the {@link MailDriver} behind {@link MailTransport}; `MailModule` picks SMTP or the in-memory driver. */
export const MAIL_DRIVER = Symbol('MAIL_DRIVER');

/** A message as the delivery job builds it: the sender is added from the configuration. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly messageId: string;
}

/**
 * Sends email.
 *
 * Why: decision 033: one `MailTransport` wraps the driver, so the rest of the platform neither knows nor cares whether mail goes out
 * by SMTP or into a test's list. Messages carry a text part always and an HTML part when the template has one.
 *
 * Side effects: `send` hands one message to the SMTP server (never under `NODE_ENV=test`); `verify` opens a connection to it.
 *
 * @see docs/decisions/033-mail-delivery.md
 */
@Injectable()
export class MailTransport implements OnApplicationShutdown {
  constructor(
    @Inject(MAIL_DRIVER) private readonly driver: MailDriver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The sender every message carries (`MAIL_FROM`). */
  get from(): string {
    return this.config.mail.from;
  }

  /**
   * Sends one message.
   *
   * @param message the recipient, subject, text, optional HTML and the message id
   * @returns nothing: it resolves when the provider accepted the message
   * @throws {DeliveryError} when the provider refused it (`permanent` tells whether a retry can help)
   */
  send(message: MailMessage): Promise<void> {
    return this.driver.send({ from: this.config.mail.from, ...message });
  }

  /**
   * Checks that the mail server answers and accepts the credentials.
   *
   * Why: the `mail` component of the System health page (feature 9) calls this.
   *
   * @returns nothing: it resolves when the server answers
   * @throws {Error} when the server cannot be reached or refuses the login
   */
  verify(): Promise<void> {
    return this.driver.verify();
  }

  /** Closes the SMTP connections. */
  onApplicationShutdown(): void {
    this.driver.close?.();
  }
}
