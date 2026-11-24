// Route contracts of the merchant portal's notification settings (map domain G, stage 12, MISMATCHES B165): `/client/notification-preferences`.
// No console screen calls them: the portal is another frontend, so the specs are B165 and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute, zMoney } from '../../../common/contract';

const PORTAL_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED'] as const;

/** What the preferences screen shows. */
const Preferences = z.object({
  email: z.object({ address: z.string().describe("The merchant's own email address; read only.") }),
  lowBalanceThreshold: zMoney
    .nullable()
    .describe('The available balance under which `wallet.low_balance` fires; `null` means no alert.'),
  events: z
    .array(
      z.object({
        event: z.string(),
        label: z.string(),
        email: z.boolean(),
      }),
    )
    .describe(
      'Every merchant event that can be switched on or off. The mails that sign you in (verification, reset, invitation) are always sent and not listed.',
    ),
});

const PREFERENCES_EXAMPLE = {
  email: { address: 'ops@zainmobilehub.example' },
  lowBalanceThreshold: '50.0000',
  events: [
    { event: 'wallet.low_balance', label: 'Low wallet balance', email: true },
    { event: 'order.completed', label: 'Order completed', email: false },
  ],
} as const;

/** `GET /client/notification-preferences`. */
export const merchantGetNotificationPreferences = defineRoute({
  key: 'GET /client/notification-preferences',
  summary: 'My notification preferences',
  description:
    'What the merchant is told about, by email. An event never saved is `email: true`, except the order results ' +
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
    'alert, a missing key keeps it). `422` on `events.<n>.event` for an unknown or always-sent event, and on `lowBalanceThreshold` for a ' +
    'negative or malformed amount. A `telegram` field in a row, which an older portal still sends, is ignored. Answers the same body as the GET. ' +
    'The merchant portal writes no audit rows (B121).',
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({
    lowBalanceThreshold: z.string().trim().nullable().optional(),
    events: z.array(z.object({ event: z.string().trim(), email: z.boolean() })).default([]),
  }),
  success: { status: 200, schema: Preferences },
  errors: ['VALIDATION_FAILED', ...PORTAL_ERRORS, 'CSRF_FAILED'],
  examples: {
    request: {
      lowBalanceThreshold: '50',
      events: [{ event: 'wallet.low_balance', email: true }],
    },
    response: PREFERENCES_EXAMPLE,
  },
});
