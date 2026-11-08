// The error a channel driver throws when a message was not delivered (platform module, feature 12a): it says whether trying again can
// help, so the delivery job fails a permanent refusal at once and retries the rest with the queue's backoff (decision 020).

/**
 * A message that a channel did not accept.
 *
 * Why: decision 033: a send is at least once and a failure is retried with backoff, except where retrying cannot help (a mailbox that
 * does not exist, a chat that blocked the bot): those fail at once with the reason. The message is written for staff (it is stored on
 * the row and shown in the log), so it never holds an address, a token or a URL.
 */
export class DeliveryError extends Error {
  /** True when a retry cannot change the answer. */
  readonly permanent: boolean;
  /** How long the provider asked us to wait, in seconds, when it said so. */
  readonly retryAfterSeconds: number | undefined;

  /**
   * @param message the reason, safe to store and show
   * @param options `permanent` (default false) and the provider's `retryAfterSeconds`
   */
  constructor(
    message: string,
    options: { readonly permanent?: boolean; readonly retryAfterSeconds?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DeliveryError';
    this.permanent = options.permanent ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
