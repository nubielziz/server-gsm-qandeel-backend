// Unit tests of how the bot reads a Telegram update (feature 12a, MISMATCHES B165): only `/start <token>` and `/stop` typed in a private chat count; the
// update comes from the network, so every field is checked.
import { describe, expect, it } from 'bun:test';
import { parseTelegramUpdate } from './telegram-linking.service';

const TOKEN = 'Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0';
const update = (
  text: unknown,
  chat: Record<string, unknown> = { id: 123456789, type: 'private' },
  updateId: unknown = 1042,
) => ({
  update_id: updateId,
  message: { chat, text },
});

describe('parseTelegramUpdate', () => {
  it('reads /start with a token and /stop, with the update id and the chat id as text', () => {
    expect(parseTelegramUpdate(update(`/start ${TOKEN}`))).toEqual({
      updateId: 1042,
      chatId: '123456789',
      command: { kind: 'start', token: TOKEN },
    });
    expect(parseTelegramUpdate(update('/stop'))).toEqual({
      updateId: 1042,
      chatId: '123456789',
      command: { kind: 'stop' },
    });
  });

  it('accepts the bot name Telegram adds in a shared chat, extra spaces, and a negative or string chat id', () => {
    expect(parseTelegramUpdate(update(`/start@gsm_supply_bot   ${TOKEN}  `))?.command).toEqual({
      kind: 'start',
      token: TOKEN,
    });
    expect(parseTelegramUpdate(update('/stop@gsm_supply_bot'))?.command).toEqual({ kind: 'stop' });
    expect(parseTelegramUpdate(update('/stop', { id: '-42', type: 'private' }))?.chatId).toBe('-42');
  });

  it('keeps an update without a numeric id (the answer is then not deduplicated)', () => {
    expect(parseTelegramUpdate(update('/stop', undefined, 'x'))?.updateId).toBeUndefined();
    expect(parseTelegramUpdate(update('/stop', undefined, 1.5))?.updateId).toBeUndefined();
  });

  it('ignores groups, channels, other text, short or odd tokens, a bad chat id and anything that is not a text message', () => {
    for (const ignored of [
      update(`/start ${TOKEN}`, { id: 1, type: 'group' }),
      update(`/start ${TOKEN}`, { id: 1, type: 'channel' }),
      update('/start'),
      update('/start short'),
      update(`/start ${TOKEN} extra`),
      update(`/start ${'A'.repeat(129)}`),
      update('/start has space-in-it-but-long-enough-0123456789'),
      update('/stopnow'),
      update('hello'),
      update(42),
      update(undefined),
      update('/stop', { id: 1.5, type: 'private' }),
      update('/stop', { id: 'abc', type: 'private' }),
      update('/stop', { id: '1'.repeat(25), type: 'private' }),
      update('/stop', { type: 'private' }),
      { update_id: 1, message: { text: '/stop' } },
      { update_id: 1, message: 'text' },
      { update_id: 1, edited_message: { chat: { id: 1, type: 'private' }, text: '/stop' } },
      { update_id: 1 },
      [],
      'string',
      null,
      undefined,
    ]) {
      expect(parseTelegramUpdate(ignored), JSON.stringify(ignored)).toBeUndefined();
    }
  });
});
