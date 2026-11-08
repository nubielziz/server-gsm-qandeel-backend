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
  /** What the limiter protects and who calls it, for the people who change these numbers. */
  readonly description: string;
}

/**
 * Every limiter, by name.
 *
 * Why: decision 021. The keys of the callers: `ip` the client IP; `api-key` the API key id (the points come from
 * `api_keys.rate_limit_per_min` through the `limit` option, this is the default); `sign-in` email + IP (build the key
 * with `RateLimitService.compositeKey`), counted per attempt and reset on success; `token` the client IP; `supplier` the
 * supplier id (the points come from `suppliers.rate_limit_per_min`); `webhook-retry` the delivery id; `upload` the client IP; `ticket-email`
 * the hashed email address of a public ticket form (`RateLimitService.compositeKey`).
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
    description: 'Dhru and REST v1: requests per API key; the key own limit (rate_limit_per_min) replaces the points.',
  },
  'sign-in': {
    points: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    description:
      'Staff, merchant and customer sign-in: attempts per email + IP; the sixth locks that pair for 15 minutes; a success resets it.',
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
      'Large bodies read before the credentials are known (multipart or over 1 MiB on Dhru, REST v1 and the portal upload): requests per client IP.',
  },
  'webhook-retry': {
    points: 1,
    windowSeconds: 60,
    description:
      'Manual retries of one webhook delivery by staff: one a minute per delivery (POST /admin/webhook-deliveries/:id/retry).',
  },
  'ticket-email': {
    points: 3,
    windowSeconds: 60 * 60,
    description:
      'The public ticket form (POST /store/v1/tickets): new tickets per email address per hour, so the receipt email cannot relay spam to a stranger.',
  },
} as const satisfies Record<string, LimiterConfig>;

/**
 * The name of a limiter.
 *
 * Why: a typo in a limiter name is a compile error, not a request that is silently not limited.
 */
export type LimiterName = keyof typeof RATE_LIMITERS;
