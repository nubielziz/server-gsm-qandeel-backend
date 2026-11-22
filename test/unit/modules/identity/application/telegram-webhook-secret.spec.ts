// Unit tests of the two values Telegram's webhook is registered with (decision 054): both derived from the configured secret.
import { describe, expect, it } from 'bun:test';
import {
  TELEGRAM_HEADER_LABEL,
  TELEGRAM_PATH_LABEL,
  telegramWebhookHeader,
  telegramWebhookPath,
} from '@src/modules/identity/application/telegram-webhook-secret';
import { hashToken } from '@src/infra/crypto';

const SECRET = 'tg-secret-0123456789-abcdefghij';

describe('the Telegram webhook values', () => {
  it('derives two different 64-hex values from the secret', () => {
    const path = telegramWebhookPath(SECRET);
    const header = telegramWebhookHeader(SECRET);
    expect(path).toMatch(/^[0-9a-f]{64}$/);
    expect(header).toMatch(/^[0-9a-f]{64}$/);
    expect(path).not.toBe(header);
    expect(path).not.toBe(SECRET);
    expect(header).not.toBe(SECRET);
  });

  it('is deterministic and follows the secret', () => {
    expect(telegramWebhookPath(SECRET)).toBe(telegramWebhookPath(SECRET));
    expect(telegramWebhookHeader(SECRET)).toBe(telegramWebhookHeader(SECRET));
    expect(telegramWebhookPath(`${SECRET}x`)).not.toBe(telegramWebhookPath(SECRET));
    expect(telegramWebhookHeader(`${SECRET}x`)).not.toBe(telegramWebhookHeader(SECRET));
  });

  it('keys each label with the secret', () => {
    expect(telegramWebhookPath(SECRET)).toBe(hashToken(SECRET, TELEGRAM_PATH_LABEL));
    expect(telegramWebhookHeader(SECRET)).toBe(hashToken(SECRET, TELEGRAM_HEADER_LABEL));
  });
});
