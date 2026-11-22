// Tests of the Telegram webhook registration tool (decision 054): what it sends to Telegram, that nothing it prints carries a secret, and its
// argument checks. No real Telegram call: the HTTP function is a fake, and the child runs only the refusals and the dry run.
import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequestOptions, HttpResult } from '@src/infra/http/http-request';
import { telegramWebhookHeader, telegramWebhookPath } from '@src/modules/identity';
import { registerTelegramWebhook, telegramRegistration, withoutSecrets } from '../../scripts/telegram-webhook';

const ROOT = join(import.meta.dir, '../..');
const SECRET = 'tg-webhook-secret-0123456789';
const BOT_TOKEN = '1234567890:AAbot-token-for-the-test';

function answer(status: number, body: unknown): HttpResult {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: new TextEncoder().encode(text),
    durationMs: 1,
    text: () => text,
    json: <T>() => JSON.parse(text) as T,
  };
}

async function run(args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, '--no-env-file', join('scripts', 'telegram-webhook.ts'), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

describe('telegramRegistration', () => {
  it('builds the webhook address from the path value and the header value, never the secret', () => {
    const registration = telegramRegistration('https://api.example.com/', SECRET);
    expect(registration).toEqual({
      url: `https://api.example.com/webhooks/telegram/${telegramWebhookPath(SECRET)}`,
      secretToken: telegramWebhookHeader(SECRET),
    });
    expect(JSON.stringify(registration)).not.toContain(SECRET);
  });
});

describe('registerTelegramWebhook', () => {
  it("posts { url, secret_token } to setWebhook and returns Telegram's description with every secret replaced", async () => {
    const registration = telegramRegistration('https://api.example.com', SECRET);
    const sent: HttpRequestOptions[] = [];
    const outcome = await registerTelegramWebhook({
      request: (options) => {
        sent.push(options);
        return Promise.resolve(answer(200, { ok: true, description: `Webhook was set to ${registration.url}` }));
      },
      botToken: BOT_TOKEN,
      registration,
    });
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.url)).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.httpsOnly).toBe(true);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({
      url: registration.url,
      secret_token: registration.secretToken,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.description).toBe('Webhook was set to https://api.example.com/webhooks/telegram/[secret]');
  });

  it("reports a refusal with Telegram's status and a cleaned description", async () => {
    const outcome = await registerTelegramWebhook({
      request: () => Promise.resolve(answer(401, { ok: false, description: `Unauthorized bot${BOT_TOKEN}` })),
      botToken: BOT_TOKEN,
      registration: telegramRegistration('https://api.example.com', SECRET),
    });
    expect(outcome).toEqual({ ok: false, status: 401, description: 'Unauthorized bot[secret]' });
  });

  it('replaces every secret it is given', () => {
    expect(withoutSecrets('a TOKEN b PATH c', ['TOKEN', 'PATH', ''])).toBe('a [secret] b [secret] c');
  });
});

describe('scripts/telegram-webhook.ts', () => {
  const env = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: 'imei_hub_test_bot',
    TELEGRAM_WEBHOOK_SECRET: SECRET,
  };

  // Each case is a child process; the bound is generous because other suites may share the machine.
  it('refuses an address that is not an https origin, before reading the configuration', async () => {
    const runs = await Promise.all(
      [['--url', 'http://api.example.com'], ['--url', 'https://api.example.com/x'], ['--other']].map((args) =>
        run(args, env),
      ),
    );
    for (const result of runs) {
      expect(result.code).toBe(2);
      expect(result.output).toContain('Give the https address of API_HOST');
    }
  }, 60_000);

  it('shows what a dry run would do without any secret value', async () => {
    const result = await run(['--url', 'https://api.example.com', '--dry-run'], env);
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      'Would register https://api.example.com/webhooks/telegram/[secret] with a header value (not shown).',
    );
    for (const secret of [SECRET, BOT_TOKEN, telegramWebhookPath(SECRET), telegramWebhookHeader(SECRET)]) {
      expect(result.output).not.toContain(secret);
    }
  }, 60_000);

  it('asks for the two Telegram settings when they are missing', async () => {
    const result = await run(['--url', 'https://api.example.com', '--dry-run'], { NODE_ENV: 'test' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.production first.');
  }, 60_000);
});
