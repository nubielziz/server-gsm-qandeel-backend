// Route contract of the marketing unsubscribe link (feature 23, plan sections 9.6 and 10.5; route beyond the map, scripts/map-additions/23.mjs).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/** `POST /store/v1/marketing/unsubscribe/:token`: stop marketing email with the link of an email. */
export const unsubscribeMarketing = defineRoute({
  key: 'POST /store/v1/marketing/unsubscribe/:token',
  summary: 'Stop marketing email',
  description:
    'The link at the bottom of a marketing email. Switches marketing off for the customer the token names: `marketing_opt_in` becomes ' +
    'false and a consent record (`granted: false`, the caller’s address and user agent) is added, so the next campaign and the sending of ' +
    'a message already queued leave the customer out. Repeating it changes nothing. Public by design: it has no session and no ' +
    'anti-bot token, because mailbox providers call it themselves (RFC 8058 one-click: a form body `List-Unsubscribe=One-Click`) and ' +
    'the site’s page calls it with no body. The token is a keyed MAC over the customer id: it can switch marketing off, never on. ' +
    'A customer who is unknown or erased answers `204` too (nothing to say, nothing to leak); a token that does not verify is `410`.',
  tags: ['account'],
  surface: 'store',
  access: 'public',
  csrf: false,
  params: z.object({ token: z.string().min(10).max(80) }),
  success: { status: 204 },
  errors: ['TOKEN_INVALID', 'VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
});
