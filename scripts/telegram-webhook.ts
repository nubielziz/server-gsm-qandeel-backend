// `bun scripts/telegram-webhook.ts --url <https base of API_HOST> [--dry-run]`: registers the bot's webhook with Telegram (decision 054): the
// address `<base>/webhooks/telegram/<path value>` and the header value, both derived from TELEGRAM_WEBHOOK_SECRET. Run it in the api container
// after setting or changing the secret, the bot token or the API host. Prints neither value nor the bot token.
import { loadConfigOrExit } from '../src/config';
import {
  type HttpRequestOptions,
  type HttpResult,
  HttpRequestError,
  httpRequest,
} from '../src/infra/http/http-request';
// The derivations' own file, not the identity index: the tool loads no Nest module.
import {
  telegramWebhookHeader,
  telegramWebhookPath,
} from '../src/modules/identity/application/telegram-webhook-secret';

/** What Telegram is told: the webhook address and the value of its `X-Telegram-Bot-Api-Secret-Token` header. */
export interface TelegramRegistration {
  readonly url: string;
  readonly secretToken: string;
}

/** The longest description the tool prints. */
const MAX_DESCRIPTION = 200;

/**
 * The address and header Telegram must use.
 *
 * Why: decision 054: the path segment and the header carry two different values derived from the configured secret; the secret itself
 * never travels.
 *
 * @param base an https origin without a path (`https://api.example.com`)
 * @param secret `TELEGRAM_WEBHOOK_SECRET`
 * @returns the webhook address and the header value
 */
export function telegramRegistration(base: string, secret: string): TelegramRegistration {
  const origin = base.replace(/\/+$/, '');
  return {
    url: `${origin}/webhooks/telegram/${telegramWebhookPath(secret)}`,
    secretToken: telegramWebhookHeader(secret),
  };
}

/**
 * Replaces every secret value in a text with `[secret]`.
 *
 * Why: Telegram's answer, or a message of ours, may quote the address with the bot token or the webhook values; nothing the tool prints
 * may carry them (decision 054).
 *
 * @param text any text
 * @param secrets the bot token, the secret, the path and header values
 * @returns the text with each of them replaced
 */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) if (secret !== '') clean = clean.split(secret).join('[secret]');
  return clean;
}

/**
 * Calls Telegram's `setWebhook` with the derived address and header value.
 *
 * Why: decision 054: a hand-typed HMAC and `curl` would leave the bot token and the values in the shell history, and one wrong byte fails
 * silently. Only `url` and `secret_token` are sent: Telegram keeps the other settings (`allowed_updates`) as they are.
 *
 * @param input the HTTP function, the bot token and the registration
 * @returns Telegram's verdict, the HTTP status and its description cleaned of every secret (at most 200 characters)
 * @throws {HttpRequestError} when Telegram could not be reached
 */
export async function registerTelegramWebhook(input: {
  readonly request: (options: HttpRequestOptions) => Promise<HttpResult>;
  readonly botToken: string;
  readonly registration: TelegramRegistration;
}): Promise<{ ok: boolean; status: number; description: string }> {
  const { registration, botToken } = input;
  const result = await input.request({
    url: `https://api.telegram.org/bot${botToken}/setWebhook`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: registration.url, secret_token: registration.secretToken }),
    timeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
    httpsOnly: true,
  });
  let ok = false;
  let description = '';
  try {
    const body = result.json<{ ok?: unknown; description?: unknown }>();
    ok = result.ok && body.ok === true;
    description = typeof body.description === 'string' ? body.description : '';
  } catch {
    // Not JSON: the status says enough.
  }
  const secrets = [botToken, registration.secretToken, registration.url.split('/').at(-1) ?? ''];
  return { ok, status: result.status, description: withoutSecrets(description, secrets).slice(0, MAX_DESCRIPTION) };
}

/** The https origin given with `--url`, or `undefined` when it is not one. */
function originOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      return undefined;
    }
    if (url.username !== '' || url.password !== '') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let base: string | undefined;
  let dryRun = false;
  let refused = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--url') {
      base = args[index + 1];
      index += 1;
    } else if (arg !== undefined && arg.startsWith('--url=')) base = arg.slice('--url='.length);
    else refused = true;
  }
  const origin = originOf(base);
  if (refused || origin === undefined) {
    console.error('Give the https address of API_HOST, for example --url https://api.example.com');
    process.exit(2);
  }
  const config = loadConfigOrExit();
  const { botToken, webhookSecret } = config.telegram;
  if (botToken === undefined || webhookSecret === undefined) {
    console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.production first.');
    process.exit(1);
  }
  const shown = `${origin}/webhooks/telegram/[secret]`;
  if (dryRun) {
    console.log(`Would register ${shown} with a header value (not shown).`);
    process.exit(0);
  }
  try {
    const outcome = await registerTelegramWebhook({
      request: (options) => httpRequest(options),
      botToken,
      registration: telegramRegistration(origin, webhookSecret),
    });
    if (outcome.ok) {
      console.log(`Telegram webhook registered for ${shown} (${outcome.description}).`);
    } else {
      console.error(`Telegram refused the webhook (HTTP ${outcome.status}): ${outcome.description}`);
      process.exitCode = 1;
    }
  } catch (error) {
    // Never print an error's message: it could carry the address with the bot token.
    const kind = error instanceof HttpRequestError ? error.kind : 'error';
    console.error(`Telegram could not be reached (${kind}).`);
    process.exitCode = 1;
  }
}
