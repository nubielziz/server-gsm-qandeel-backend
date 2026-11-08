// The mail drivers (platform module, decision 033): SMTP through nodemailer for real delivery, and an in-memory one that records what
// would be sent, which is what every test (NODE_ENV=test) uses so no test ever opens a connection to an SMTP server.
import { createTransport } from 'nodemailer';
import { DeliveryError } from './delivery-error';
import { redactAddresses } from './masking';

/** One message handed to a driver. */
export interface OutgoingMail {
  /** The sender, from `MAIL_FROM`. */
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** The text part: every message has one. */
  readonly text: string;
  /** The HTML part, when the template has one. */
  readonly html?: string;
  /** The `Message-ID` header: derived from the notification row, so a provider that dedupes sees a repeat as the same message. */
  readonly messageId: string;
}

/** What `MailTransport` needs from a way of sending mail. */
export interface MailDriver {
  /**
   * Sends one message.
   *
   * @param mail the message
   * @throws {DeliveryError} when the provider did not accept it (`permanent` says whether a retry can help)
   */
  send(mail: OutgoingMail): Promise<void>;
  /**
   * Checks that the server answers and accepts the credentials.
   *
   * @throws {Error} when it does not
   */
  verify(): Promise<void>;
  /** Closes connections; called on shutdown. */
  close?(): void;
}

/** The part of a nodemailer transporter the SMTP driver uses; tests pass a fake. */
export interface MailTransporter {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
  verify(): Promise<unknown>;
  close(): void;
}

/** Makes a transporter from the options the driver builds. */
export type TransporterFactory = (options: Record<string, unknown>) => MailTransporter;

const defaultFactory: TransporterFactory = (options) => createTransport(options);

/**
 * Turns an SMTP URL into nodemailer options with explicit timeouts.
 *
 * @param smtpUrl `smtp://` or `smtps://`, with `user:password@` when the server needs it
 * @returns the options: host, port, TLS mode, credentials and the timeouts
 */
export function smtpOptions(smtpUrl: string): Record<string, unknown> {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: url.port === '' ? (secure ? 465 : 587) : Number(url.port),
    secure,
    ...(url.username === ''
      ? {}
      : { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }),
    // A send never holds a worker longer than this: decision 023 wants an explicit timeout on every outbound call.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 3,
  };
}

/** nodemailer error codes that mean the message itself or its address is refused for good. */
const PERMANENT_CODES = new Set(['EENVELOPE', 'EMESSAGE']);

/**
 * Decides what a nodemailer failure means.
 *
 * Why: an SMTP 5xx answer (a mailbox that does not exist, a refused sender) will not change on a retry; a 4xx answer, a timeout and a
 * dropped connection will. The text is cleaned of addresses before it is stored.
 *
 * @param error whatever the transporter threw
 * @returns a {@link DeliveryError} with a safe reason
 */
export function classifyMailError(error: unknown): DeliveryError {
  const info = (error ?? {}) as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown };
  const responseCode = typeof info.responseCode === 'number' ? info.responseCode : undefined;
  const code = typeof info.code === 'string' ? info.code : undefined;
  const raw =
    typeof info.response === 'string'
      ? info.response
      : typeof info.message === 'string'
        ? info.message
        : 'The mail server refused the message.';
  const reason = redactAddresses(raw);
  const permanent =
    (responseCode !== undefined && responseCode >= 500) || (code !== undefined && PERMANENT_CODES.has(code));
  return new DeliveryError(reason, { permanent, cause: error });
}

/**
 * Sends mail over SMTP with nodemailer.
 *
 * Why: decision 033: SMTP works with any provider, so there is no vendor lock-in and no provider SDK. The transporter is made on the
 * first use, so building the application never connects.
 *
 * Side effects: opens (and pools) SMTP connections to the configured server.
 */
export class SmtpMailDriver implements MailDriver {
  private transporter: MailTransporter | undefined;

  constructor(
    private readonly smtpUrl: string,
    private readonly factory: TransporterFactory = defaultFactory,
  ) {}

  /** @inheritdoc */
  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.connection().sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        messageId: mail.messageId,
      });
    } catch (error) {
      throw classifyMailError(error);
    }
  }

  /** @inheritdoc */
  async verify(): Promise<void> {
    await this.connection().verify();
  }

  /** @inheritdoc */
  close(): void {
    this.transporter?.close();
    this.transporter = undefined;
  }

  private connection(): MailTransporter {
    this.transporter ??= this.factory(smtpOptions(this.smtpUrl));
    return this.transporter;
  }
}

/**
 * Records the mail instead of sending it.
 *
 * Why: decision 033: tests replace the transport with an in-memory one. A test reads `sent`, and scripts a refusal with `failNext`
 * or a broken server with `verifyError`.
 */
export class InMemoryMailDriver implements MailDriver {
  /** Every message accepted, in order. */
  readonly sent: OutgoingMail[] = [];
  /** What `verify` throws, or `undefined` for a server that answers. */
  verifyError: Error | undefined;
  private readonly failures: DeliveryError[] = [];

  /**
   * Makes the next `send` fail.
   *
   * @param error the failure to throw once
   */
  failNext(error: DeliveryError): void {
    this.failures.push(error);
  }

  /** Forgets what was sent and what was scripted. */
  reset(): void {
    this.sent.length = 0;
    this.failures.length = 0;
    this.verifyError = undefined;
  }

  /** @inheritdoc */
  send(mail: OutgoingMail): Promise<void> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(mail);
    return Promise.resolve();
  }

  /** @inheritdoc */
  verify(): Promise<void> {
    return this.verifyError ? Promise.reject(this.verifyError) : Promise.resolve();
  }
}
