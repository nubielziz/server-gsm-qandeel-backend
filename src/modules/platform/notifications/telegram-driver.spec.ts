// Unit tests of the Telegram drivers and client (feature 12a, decision 033): how the Bot API's answers become delivered, retried or failed for good, with the
// token never in a reason; the in-memory driver; and the client's refusal when no bot token is configured.
import { describe, expect, it } from 'bun:test';
import { expectRejection } from '../../../../test/support/rejection';
import { parseEnv } from '../../../config';
import { HttpRequestError, type HttpResult, type OutboundHttp } from '../../../infra/http';
import { DeliveryError } from './delivery-error';
import { TELEGRAM_NOT_CONFIGURED, TelegramClient } from './telegram-client';
import { HttpTelegramDriver, InMemoryTelegramDriver, TELEGRAM_TIMEOUT_MS } from './telegram-driver';

const TOKEN = '1234567890:AAsecret-bot-token';

function answer(status: number, body: unknown): HttpResult {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
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

function driverWith(reply: () => HttpResult | Error) {
  const requests: Array<Record<string, unknown>> = [];
  const http = {
    request: (options: Record<string, unknown>) => {
      requests.push(options);
      const result = reply();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  } as unknown as OutboundHttp;
  return { driver: new HttpTelegramDriver(http, TOKEN), requests };
}

describe('HttpTelegramDriver', () => {
  it('posts sendMessage to the Bot API with an explicit timeout and the chat and text as JSON', async () => {
    const { driver, requests } = driverWith(() => answer(200, { ok: true, result: {} }));
    await driver.sendMessage('7001', 'Hello');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      target: 'telegram',
      method: 'POST',
      url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      chat_id: '7001',
      text: 'Hello',
      disable_web_page_preview: true,
    });
  });

  it('retries a 429 (with the wait Telegram asked for) and a 5xx, and fails 400, 403 and 404 for good', async () => {
    const run = (status: number, body: unknown) => driverWith(() => answer(status, body)).driver.sendMessage('1', 'x');
    const slow = await run(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }).catch(
      (e) => e,
    );
    expect(slow).toBeInstanceOf(DeliveryError);
    expect(slow).toMatchObject({ permanent: false, retryAfterSeconds: 7 });
    expect(await run(502, 'Bad gateway').catch((e) => e)).toMatchObject({ permanent: false });
    expect(await run(400, { description: 'Bad Request: chat not found' }).catch((e) => e)).toMatchObject({
      permanent: true,
      message: 'Telegram refused the message: Bad Request: chat not found',
    });
    expect(await run(403, { description: 'Forbidden: bot was blocked by the user' }).catch((e) => e)).toMatchObject({
      permanent: true,
    });
    expect(await run(404, '').catch((e) => e)).toMatchObject({
      permanent: true,
      message: 'Telegram refused the message: HTTP 404',
    });
    expect(await run(401, { description: 'Unauthorized' }).catch((e) => e)).toMatchObject({
      permanent: true,
      message: 'Telegram refused the bot token.',
    });
  });

  it('retries when Telegram cannot be reached, and never puts the token in a reason', async () => {
    for (const kind of ['timeout', 'network', 'too_large'] as const) {
      const { driver } = driverWith(
        () => new HttpRequestError(kind, `failed: https://api.telegram.org/bot${TOKEN}/sendMessage`),
      );
      const error = await driver.sendMessage('1', 'x').catch((e) => e);
      expect(error).toMatchObject({
        name: 'DeliveryError',
        permanent: false,
        message: `Telegram could not be reached (${kind}).`,
      });
      expect(error.message).not.toContain(TOKEN);
    }
    const { driver } = driverWith(() => answer(400, { description: 'chat not found' }));
    expect((await driver.sendMessage('1', 'x').catch((e) => e)).message).not.toContain(TOKEN);
  });
});

describe('InMemoryTelegramDriver', () => {
  it('records messages and fails on demand once', async () => {
    const driver = new InMemoryTelegramDriver();
    await driver.sendMessage('1', 'a');
    driver.failNext(new DeliveryError('busy'));
    await expectRejection(driver.sendMessage('1', 'b'), 'busy');
    await driver.sendMessage('2', 'c');
    expect(driver.sent).toEqual([
      { chatId: '1', text: 'a' },
      { chatId: '2', text: 'c' },
    ]);
    driver.reset();
    expect(driver.sent).toEqual([]);
  });
});

describe('TelegramClient', () => {
  const config = (extra: Record<string, string> = {}) => parseEnv({ NODE_ENV: 'test', ...extra });

  it('refuses every send with a clear, permanent reason when no bot token is configured, and calls nothing', async () => {
    const driver = new InMemoryTelegramDriver();
    const client = new TelegramClient(config(), driver);
    expect(client.configured).toBe(false);
    const error = await client.sendMessage('1', 'x').catch((e) => e);
    expect(error).toMatchObject({ name: 'DeliveryError', permanent: true, message: TELEGRAM_NOT_CONFIGURED });
    expect(TELEGRAM_NOT_CONFIGURED).toBe('Telegram is not configured.');
    expect(driver.sent).toEqual([]);
    expect(await new TelegramClient(config()).sendMessage('1', 'x').catch((e) => e.message)).toBe(
      TELEGRAM_NOT_CONFIGURED,
    );
  });

  it('hands the message to the driver when a token is configured', async () => {
    const driver = new InMemoryTelegramDriver();
    const client = new TelegramClient(config({ TELEGRAM_BOT_TOKEN: TOKEN }), driver);
    expect(client.configured).toBe(true);
    await client.sendMessage('7001', 'Hello');
    expect(driver.sent).toEqual([{ chatId: '7001', text: 'Hello' }]);
  });
});
