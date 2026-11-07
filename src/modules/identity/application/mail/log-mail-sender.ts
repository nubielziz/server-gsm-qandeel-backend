// LogMailSender: the development MailSender. It delivers nothing; it writes one redacted log line per mail.
import { Injectable, Logger } from '@nestjs/common';
import type { MailSender, MerchantMail } from './mail-sender';

/**
 * Hides most of an email address in a log line.
 *
 * Why: logs are read by more people than mailboxes are (CLAUDE.md security: redaction); the first letter and the domain are
 * enough to tell which mail a line is about.
 *
 * @param email an email address
 * @returns for example `a***@example.com`; `***` when it is not an address
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

/**
 * Logs the mail instead of sending it.
 *
 * Why: no mail transport exists yet (feature 12a adds templates and real delivery); the jobs, retries and outbox rows can
 * still be built and tested. The line names the kind, the merchant id, the redacted address and the link row, never a token.
 *
 * Side effects: one log line per mail.
 */
@Injectable()
export class LogMailSender implements MailSender {
  private readonly logger = new Logger('MerchantMail');

  /**
   * Writes the log line.
   *
   * @param mail what would be sent
   * @returns a promise that is already resolved: nothing leaves the process
   */
  send(mail: MerchantMail): Promise<void> {
    this.logger.log(
      `Mail merchant.${mail.kind} for client ${mail.clientId} (${redactEmail(mail.email)}), link ${mail.tokenId} valid until ${mail.expiresAt.toISOString()}; not sent: no mail transport yet`,
    );
    return Promise.resolve();
  }
}
