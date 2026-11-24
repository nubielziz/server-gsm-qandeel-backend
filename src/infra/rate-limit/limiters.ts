// The named rate limiters of the backend (decision 021), configured in one place. Change a limit here, nowhere else.

/**
 * One named limiter.
 *
 * Why: decision 021 gives each kind of traffic its own budget, so a noisy store crawler cannot use up a merchant's API
 * budget and a sign-in attacker cannot lock out other people.
 */
export interface LimiterConfig {
  /** How many points (requests, or attempts) fit in one window. */
  readonly points: number;
  /** Length of the window in seconds; the counter resets when it ends. */
  readonly windowSeconds: number;
  /** After the points are used up, keep refusing for this many seconds (a lock-out); leave out for no lock-out. */
  readonly blockSeconds?: number;
  /**
   * Refuse instead of counting in process memory while the cache Redis cannot be reached; for budgets that guard a short secret
   * (decision 052).
   */
  readonly failClosed?: true;
  /** What the limiter protects and who calls it, for the people who change these numbers. */
  readonly description: string;
}

/**
 * Every limiter, by name.
 *
 * Why: decision 021. The keys of the callers: `ip` the client IP; `api-key` the API key id (the points come from
 * `api_keys.rate_limit_per_min` through the `limit` option, this is the default); `sign-in` email + network (the IPv4 address or
 * the IPv6 /64, `RequestMeta.limitKey`; build the key with `RateLimitService.compositeKey`), counted per attempt and reset on
 * success; `sign-in-code` the account (the authenticator code steps, never counted in process memory, decision 052); `sign-in-familiar` scope + email + network, hashed (the attempts a familiar network is still allowed while an email is locked, decision 052); `token` the client IP; `supplier` the
 * supplier id (the points come from `suppliers.rate_limit_per_min`); `webhook-intake` the client address key of an incoming webhook (decision 053); `upload` the client IP; `ticket-email`
 * the hashed email address of a public ticket form, the typed one or the order's customer's (`RateLimitService.compositeKey`);
 * `wallet-topup` the account (`a:<accountId>`); `help-vote` the client address key (IPv4, or the IPv6 /64) + help article id (`RateLimitService.compositeKey`); `media` the client IP; `account-mail` an account and a kind of
 * mail (`accountMailKey`); `broadcast-email` the constant `all` (one budget for the whole system,
 * feature 23); `stream-connect` the first cap key of a live stream (`session:<id>`, decision 037); `ticket-chat` the client IP;
 * `ticket-message` the ticket id; `ticket-open` the account (`account:<id>`) (feature 28); `search-suggest` the client IP (feature 29).
 *
 * @see docs/decisions/021-rate-limiting.md
 */
export const RATE_LIMITERS = {
  ip: {
    points: 300,
    windowSeconds: 60,
    description: 'Public store routes and everything before authentication: requests per client IP.',
  },
  'api-key': {
    points: 60,
    windowSeconds: 60,
    description: 'Dhru: requests per API key; the key own limit (rate_limit_per_min) replaces the points.',
  },
  'sign-in': {
    points: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    description:
      'Staff and account sign-in (every rank), forgot password and sign-in link: attempts per email and network (the IPv4 address or the IPv6 /64); the sixth locks that pair for 15 minutes; a success resets it.',
  },
  'sign-in-code': {
    points: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    failClosed: true,
    description:
      'Authenticator codes of the staff and account sign-in and of the account 2FA enable and disable: attempts per account; the sixth locks the code step of that account for 15 minutes; a success resets it. Never counted in process memory: while the cache Redis cannot be reached the code is refused (decision 052).',
  },
  'sign-in-familiar': {
    points: 5,
    windowSeconds: 15 * 60,
    description:
      'Password sign-in attempts that are let through only because their network is one the account signed in from, while its email is locked after repeated failures: attempts per scope (console or shop), email and network (the IPv4 /24 or the IPv6 /64), hashed; the sixth in 15 minutes is refused like any other attempt on a locked email. Not used while no lock runs (decision 052).',
  },
  token: {
    points: 30,
    windowSeconds: 60,
    description: 'Token lookups without a session (order tracking, checkout, tickets): requests per client IP.',
  },
  supplier: {
    points: 60,
    windowSeconds: 60,
    description: 'Outbound calls to one supplier: requests per supplier; the supplier own limit replaces the points.',
  },
  upload: {
    points: 20,
    windowSeconds: 60,
    description:
      'Large bodies read before the credentials are known (multipart or over 1 MiB on Dhru, the portal upload and the admin console, whose service picture upload is multipart): requests per client IP.',
  },
  'webhook-intake': {
    points: 600,
    windowSeconds: 60,
    description:
      'Incoming webhooks (POST /webhooks/*: payment and dispute events): requests per client address, counted before the route reads anything; generous, and a refused sender retries (decision 053).',
  },
  'ticket-email': {
    points: 3,
    windowSeconds: 60 * 60,
    description:
      "New tickets of the public form (POST /store/v1/tickets) per email address per hour: the typed address, or with an order link the address of the order's customer, so the receipt email cannot be sent to one address without bound (decision 053).",
  },
  'broadcast-email': {
    points: 5,
    windowSeconds: 1,
    description:
      'Emails of notification campaigns, for the whole system (key `all`): per second; the setting notifications.broadcast_email_per_second replaces the points (feature 23).',
  },
  'account-mail': {
    points: 5,
    windowSeconds: 60 * 60,
    description:
      'Account emails that staff or the account itself ask for (password link, verification, email change): five an hour per account and kind, so nobody can mail-bomb an inbox or use up the mail quota. Also the mails a visitor can ask for (the sign-in link, forgot password: kinds sign_in_link and forgot_password), per account: a request beyond the budget sends nothing and answers as usual (decision 052).',
  },
  'wallet-topup': {
    points: 10,
    windowSeconds: 10 * 60,
    description:
      'New store balance top-ups (POST /store/v1/me/wallet/top-ups): attempts per account (`a:<accountId>`); a hint only, the daily limits are SQL (feature 21).',
  },
  'help-vote': {
    points: 1,
    windowSeconds: 24 * 60 * 60,
    description:
      'The "was this helpful?" vote of a help article (POST /store/v1/help/:slug/vote): one counted vote per client address key (IPv4, or the IPv6 /64) and article per day; repeats are accepted and ignored.',
  },
  'stream-connect': {
    points: 20,
    windowSeconds: 60,
    description:
      'Opening a live event stream (GET /admin/stream, /client/stream, /store/v1/me/stream): attempts per session (the first cap key, `session:<id>`), so a reconnect loop cannot hammer the API (decision 037).',
  },
  'ticket-chat': {
    points: 120,
    windowSeconds: 60,
    description:
      'The read marks of a ticket page (POST /store/v1/tickets/:token/read), instead of `token`: requests per client IP, so a read mark every few seconds never uses up the 30 token lookups a minute (feature 28).',
  },
  'ticket-message': {
    points: 20,
    windowSeconds: 60,
    description:
      'Messages a requester writes on one ticket (the ticket page and the merchant portal): per ticket id, so one open page cannot flood the support inbox (feature 28).',
  },
  'ticket-open': {
    points: 5,
    windowSeconds: 60 * 60,
    description:
      'Tickets a signed-in account opens without Turnstile (POST /store/v1/me/tickets, POST /client/tickets): per account (`account:<id>`) an hour (feature 28).',
  },
  'search-suggest': {
    points: 1200,
    windowSeconds: 60,
    description:
      'The search-as-you-type route (GET /store/v1/search/suggest), instead of `ip`: a visitor typing sends a request every 150 ms, so two typing visitors behind one carrier NAT must fit; the results page keeps `ip` (feature 29).',
  },
  media: {
    points: 1200,
    windowSeconds: 60,
    description:
      'The public service pictures (GET /store/v1/media/:name), instead of `ip`: a first catalog view fetches up to 100 pictures, which must not use up the 300 a minute of the API; answers are cached for a year.',
  },
} as const satisfies Record<string, LimiterConfig>;

/**
 * The name of a limiter.
 *
 * Why: a typo in a limiter name is a compile error, not a request that is silently not limited.
 */
export type LimiterName = keyof typeof RATE_LIMITERS;
