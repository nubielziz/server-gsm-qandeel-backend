// Route contracts of the merchant portal's notification settings and of Telegram's update webhook (map domain G, stage 12, MISMATCHES
// B165): `/client/notification-preferences`, `/client/telegram/link` and `/webhooks/telegram/:secret`. No console screen calls them: the
// portal is another frontend, so the specs are B165 and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute, zIsoDateTime, zJsonObject, zMoney } from '../../../common/contract';

const PORTAL_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED'] as const;

/** What the preferences screen shows. */
const Preferences = z.object({
  email: z.object({ address: z.string().describe("The merchant's own email address; read only.") }),
  telegram: z.object({ linked: z.boolean().describe('True while a Telegram chat is linked.') }),
  lowBalanceThreshold: zMoney
    .nullable()
    .describe('The available balance under which `wallet.low_balance` fires; `null` means no alert.'),
  events: z
    .array(
      z.object({
        event: z.string(),
        label: z.string(),
        email: z.boolean(),
        telegram: z.boolean(),
      }),
    )
    .describe(
      'Every merchant event that can be switched on or off. The mails that sign you in (verification, reset, invitation) are always sent and not listed.',
    ),
});

const PREFERENCES_EXAMPLE = {
  email: { address: 'ops@zainmobilehub.example' },
  telegram: { linked: true },
  lowBalanceThreshold: '50.0000',
  events: [
    { event: 'wallet.low_balance', label: 'Low wallet balance', email: true, telegram: true },
    { event: 'order.completed', label: 'Order completed', email: false, telegram: false },
  ],
} as const;

/** `GET /client/notification-preferences`. */
export const merchantGetNotificationPreferences = defineRoute({
  key: 'GET /client/notification-preferences',
  summary: 'My notification preferences',
  description:
    'What the merchant is told about and how. An event never saved is `email: true, telegram: false`, except the order results ' +
    '(`order.completed`, `order.failed`), which stay off until the merchant chooses them. A merchant waiting for approval is refused (`403 ACCOUNT_PENDING_APPROVAL`).',
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Preferences },
  errors: [...PORTAL_ERRORS],
  examples: { response: PREFERENCES_EXAMPLE },
});

/** `PUT /client/notification-preferences`. */
export const merchantPutNotificationPreferences = defineRoute({
  key: 'PUT /client/notification-preferences',
  summary: 'Save my notification preferences',
  description:
    'Replaces the listed events; the events left out keep their value. `lowBalanceThreshold` is an amount of zero or more (`null` removes the ' +
    'alert, a missing key keeps it). `422` on `events.<n>.event` for an unknown or always-sent event, on `events.<n>.telegram` when Telegram is switched on ' +
    'while no chat is linked ("Link Telegram first."), and on `lowBalanceThreshold` for a negative or malformed amount. Answers the same body as the GET. ' +
    'The merchant portal writes no audit rows (B121).',
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({
    lowBalanceThreshold: z.string().trim().nullable().optional(),
    events: z.array(z.object({ event: z.string().trim(), email: z.boolean(), telegram: z.boolean() })).default([]),
  }),
  success: { status: 200, schema: Preferences },
  errors: ['VALIDATION_FAILED', ...PORTAL_ERRORS, 'CSRF_FAILED'],
  examples: {
    request: {
      lowBalanceThreshold: '50',
      events: [{ event: 'wallet.low_balance', email: true, telegram: true }],
    },
    response: PREFERENCES_EXAMPLE,
  },
});

/** `POST /client/telegram/link`. */
export const merchantCreateTelegramLink = defineRoute({
  key: 'POST /client/telegram/link',
  summary: 'A one-time link to connect Telegram',
  description:
    'Answers `https://t.me/<bot>?start=<token>`: opening it starts the bot with `/start <token>`, which links the chat. The token is single-use, ' +
    'valid for 15 minutes and stored only as a hash; a new call revokes the previous link. `503 UNAVAILABLE` when the bot is not configured. The answer says `Cache-Control: no-store`.',
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  success: {
    status: 201,
    schema: z.object({ url: z.string(), expiresAt: zIsoDateTime }),
  },
  errors: [...PORTAL_ERRORS, 'CSRF_FAILED', 'UNAVAILABLE'],
  examples: {
    response: {
      url: 'https://t.me/gsm_supply_bot?start=Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0',
      expiresAt: '2026-11-01T10:15:00.000Z',
    },
  },
});

/** `POST /webhooks/telegram/:secret`. */
export const telegramWebhook = defineRoute({
  key: 'POST /webhooks/telegram/:secret',
  summary: 'Telegram bot updates: linking a chat and /stop',
  description:
    "Telegram's update webhook. The path secret and the `X-Telegram-Bot-Api-Secret-Token` header must both equal the configured webhook secret " +
    '(constant-time comparison; otherwise `404 NOT_FOUND`). Always `200 {}` after the database write. A private-chat message `/start <token>` with a live ' +
    '`telegram_link` token links that chat to the merchant (a chat that another merchant had moves) and the bot answers "Linked to <merchant name>."; ' +
    '`/stop` unlinks the chat and turns the merchant’s Telegram events off; anything else is ignored. A repeated `update_id` is processed once.',
  tags: ['notifications'],
  surface: 'hooks',
  access: 'url-secret',
  params: z.object({ secret: z.string() }),
  body: zJsonObject.default({}),
  success: { status: 200, schema: z.object({}) },
  errors: ['NOT_FOUND'],
  examples: {
    request: {
      update_id: 1042,
      message: { chat: { id: 123456789, type: 'private' }, text: '/start Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0' },
    },
    response: {},
  },
});
