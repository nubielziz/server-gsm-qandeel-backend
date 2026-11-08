// The mail check of the System health page (feature 9's `mail` component, decision 033): asks the SMTP server whether it answers.
import { Global, Injectable, Module } from '@nestjs/common';
import { MailTransport } from './mail-transport';
import { NotificationTransportModule } from './notification-transport.module';

/**
 * The injection token feature 9's `ComponentChecker` reads (`MAIL_PROBE` in the health module). It is a global symbol, so the
 * platform provides it without importing the health module (the two sit on opposite sides of decision 032's late imports).
 */
export const MAIL_PROBE_TOKEN = Symbol.for('gsm.MAIL_PROBE');

/** What the probe reports, in the shape of the health module's `ProbeResult`. */
export interface MailProbeResult {
  readonly status: 'ok' | 'down';
  readonly detail?: string | null;
}

/**
 * Checks the mail relay.
 *
 * Why: the brief of 12a: the `mail` component check of feature 9 calls the transport's verify. The SMTP driver's own timeouts
 * (10 s to connect and to greet) bound the call, and a failure is reported without the server's address or any credential.
 */
@Injectable()
export class MailHealthProbe {
  constructor(private readonly mail: MailTransport) {}

  /**
   * Asks the mail server whether it answers.
   *
   * @returns `ok`, or `down` with a short English text
   */
  async check(): Promise<MailProbeResult> {
    try {
      await this.mail.verify();
      return { status: 'ok' };
    } catch {
      return { status: 'down', detail: 'The mail server did not answer.' };
    }
  }
}

/**
 * Provides the mail probe to the whole worker.
 *
 * Why: the health jobs run in the worker and inject the probe as optional; a global module makes it visible there without a module
 * import from health to platform.
 */
@Global()
@Module({
  imports: [NotificationTransportModule],
  providers: [MailHealthProbe, { provide: MAIL_PROBE_TOKEN, useExisting: MailHealthProbe }],
  exports: [MAIL_PROBE_TOKEN],
})
export class MailHealthProbeModule {}
