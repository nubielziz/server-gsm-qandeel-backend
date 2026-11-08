// The Telegram drivers (platform module, decision 033): the Bot API over OutboundHttp for real delivery, and an in-memory one that
// every test (NODE_ENV=test) uses.
import { HttpRequestError, type OutboundHttp } from '../../../infra/http';
import { DeliveryError } from './delivery-error';

/** What the Telegram client needs from a way of reaching the Bot API. */
export interface TelegramDriver {
  /**
   * Sends a text message to a chat.
   *
   * @param chatId the Telegram chat id
   * @param text the message, plain text, at most 4096 characters
   * @throws {DeliveryError} when Telegram did not accept it
   */
  sendMessage(chatId: string, text: string): Promise<void>;
}

/** The explicit timeout of a Bot API call (decision 023). */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * Calls the Bot API: `https://api.telegram.org/bot<token>/sendMessage`.
 *
 * Why: decision 033: Telegram over `OutboundHttp` (target `telegram`, explicit timeout, no SDK). The token is in the URL path, which
 * `OutboundHttp` never logs (it logs the host only); no error text of this class holds the URL.
 *
 * Side effects: one HTTPS POST per message.
 */
export class HttpTelegramDriver implements TelegramDriver {
  constructor(
    private readonly http: OutboundHttp,
    private readonly botToken: string,
  ) {}

  /** @inheritdoc */
  async sendMessage(chatId: string, text: string): Promise<void> {
    let status: number;
    let body: { description?: unknown; parameters?: { retry_after?: unknown } };
    try {
      const result = await this.http.request({
        target: 'telegram',
        operation: 'telegram.sendMessage',
        method: 'POST',
        url: `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        timeoutMs: TELEGRAM_TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
      });
      status = result.status;
      try {
        body = result.json();
      } catch {
        body = {};
      }
    } catch (error) {
      // A timeout may mean the message arrived: the send is at least once (decision 033), so it is retried.
      const kind = error instanceof HttpRequestError ? error.kind : 'network';
      throw new DeliveryError(`Telegram could not be reached (${kind}).`, { cause: error });
    }
    if (status >= 200 && status < 300) return;
    const description = typeof body.description === 'string' ? body.description.slice(0, 200) : `HTTP ${status}`;
    if (status === 429) {
      const wait = Number(body.parameters?.retry_after);
      throw new DeliveryError(`Telegram asked to slow down: ${description}`, {
        ...(Number.isFinite(wait) && wait > 0 ? { retryAfterSeconds: Math.ceil(wait) } : {}),
      });
    }
    if (status === 401) throw new DeliveryError('Telegram refused the bot token.', { permanent: true });
    // 400 (chat not found), 403 (the bot was blocked) and 404 will not change on a retry; 5xx will.
    throw new DeliveryError(`Telegram refused the message: ${description}`, {
      permanent: status >= 400 && status < 500,
    });
  }
}

/** One message the in-memory driver was given. */
export interface SentTelegramMessage {
  readonly chatId: string;
  readonly text: string;
}

/**
 * Records the messages instead of sending them (tests).
 *
 * Why: decision 033 and the task: tests never call a real service. A test reads `sent` and scripts a refusal with `failNext`.
 */
export class InMemoryTelegramDriver implements TelegramDriver {
  readonly sent: SentTelegramMessage[] = [];
  private readonly failures: DeliveryError[] = [];

  /**
   * Makes the next `sendMessage` fail.
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
  }

  /** @inheritdoc */
  sendMessage(chatId: string, text: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push({ chatId, text });
    return Promise.resolve();
  }
}
