// Route contracts of the live event streams (decision 037; routes beyond the map, scripts/map-additions/27.mjs): one SSE route per
// signed-in surface. The events are documented in docs/contract/realtime-events.md.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

const zStreamQuery = z.object({
  cursor: z
    .string()
    .max(64)
    .optional()
    .describe('The last event id the page saw (`i9001`), for a new stream that should replay what it missed.'),
});
const zStreamHeaders = z.object({
  'last-event-id': z
    .string()
    .max(64)
    .optional()
    .describe('Sent by the browser on its own reconnect; it wins over `cursor`.'),
});

const DESCRIPTION =
  'A server-sent event stream (`text/event-stream`) of the signed-in person: `ready` first, `hb` every 15 seconds, ' +
  '`notification.created`, `notification.read`, `unread.changed`, `resync` and `bye`; the data of every event is one line of ' +
  'JSON (docs/contract/realtime-events.md). A reconnect sends the last event id back (`Last-Event-ID`, or `cursor`) and gets ' +
  'what it missed, at most 50 items, else `resync`. At most 3 streams per session and 30 per address (429 for the next one), ' +
  'ended after 15 minutes (`bye max_age`) and when the session ends (`bye session_ended`). Same-site requests only ' +
  '(`Sec-Fetch-Site`). A refusal is an ordinary problem+json answer before the stream starts. `503 UNAVAILABLE` when live updates ' +
  'are switched off or the server is full: keep polling.';

const STREAM = {
  query: zStreamQuery,
  headers: zStreamHeaders,
  originCheck: true,
  description: DESCRIPTION,
  success: { status: 200, contentType: 'text/event-stream' },
} as const;

/** `GET /admin/stream`: the live events of the signed-in staff member. */
export const adminStream = defineRoute({
  ...STREAM,
  key: 'GET /admin/stream',
  summary: 'My live event stream',
  tags: ['notifications'],
  surface: 'admin',
  access: 'staff-session',
  errors: ['UNAUTHORIZED', 'CSRF_FAILED', 'VALIDATION_FAILED', 'RATE_LIMITED', 'UNAVAILABLE'],
});

/** `GET /client/stream`: the live events of the signed-in merchant (also while still pending approval). */
export const clientStream = defineRoute({
  ...STREAM,
  key: 'GET /client/stream',
  summary: 'My live event stream',
  tags: ['notifications'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'VALIDATION_FAILED', 'RATE_LIMITED', 'UNAVAILABLE'],
});

/** `GET /store/v1/me/stream`: the live events of the signed-in customer. */
export const customerStream = defineRoute({
  ...STREAM,
  key: 'GET /store/v1/me/stream',
  summary: 'My live event stream',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  errors: [
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'IP_NOT_ALLOWED',
    'CSRF_FAILED',
    'VALIDATION_FAILED',
    'RATE_LIMITED',
    'UNAVAILABLE',
  ],
});
