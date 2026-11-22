// The registry of settings that `PATCH /admin/settings` may write (RESOLUTIONS identity-platform-13): an allow-list, each key
// with its validator. Pure, so it is unit-tested; the route and `PATCH /admin/storefront/settings` share the validators.

/** One setting the generic settings route may change. */
export interface EditableSetting {
  /** The camelCase key as the console sends it. */
  readonly key: string;
  /** Checks a value; returns the sentence for the field, or `undefined` when the value is acceptable. */
  validate(value: unknown): string | undefined;
  /** Only an Owner may change it (decisions 051 and 049): `PATCH /admin/settings` answers 403 to any other caller. */
  readonly ownerOnly?: boolean;
}

/** The longest retention the console offers: ten years. */
export const IMEI_RETENTION_MAX_DAYS = 3650;

/**
 * Checks the value of `imeiRetentionDays`: a JSON integer from 0 to 3650.
 *
 * Why: the privacy panel of the console edits how long IMEI numbers are kept (RULES settings); `0` means "do not keep". The
 * storefront settings route (feature 16) uses the same check.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function imeiRetentionDaysProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of days.';
  if (value < 0 || value > IMEI_RETENTION_MAX_DAYS) return `Use a number from 0 to ${IMEI_RETENTION_MAX_DAYS}.`;
  return undefined;
}

/** The key of the price-change tolerance (user rule 9, MISMATCHES B117); the catalog module reads it under the same name. */
export const PRICE_CHANGE_TOLERANCE_KEY = 'pricing.price_change_tolerance_percent';

/**
 * Checks the value of `pricing.price_change_tolerance_percent`: a JSON integer from 0 to 100.
 *
 * Why: user rule 9: an order that costs more than this many percent above the price the merchant was last listed is refused
 * with `409 PRICE_CHANGED`; `0` refuses every rise, the default (setting never saved) is 10. The catalog module's price
 * guard reads it.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function priceChangeTolerancePercentProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of percent.';
  if (value < 0 || value > 100) return 'Use a number from 0 to 100.';
  return undefined;
}

/** The key of the SLA an imported service gets when the supplier's time text cannot be read (RESOLUTIONS orders-suppliers-10). */
export const IMPORT_DEFAULT_SLA_KEY = 'catalog.importDefaultSlaMinutes';

/**
 * Checks the value of `catalog.importDefaultSlaMinutes`: a JSON integer from 1 to 525600 (one year of minutes).
 *
 * Why: orders-suppliers-10: a supplier's delivery text that cannot be read gives the imported service this SLA (default 1440), a long
 * one on purpose so that a guess does not make the service past its SLA at once. The supplier import reads it.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function importDefaultSlaMinutesProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of minutes.';
  if (value < 1 || value > 525_600) return 'Use a number from 1 to 525600.';
  return undefined;
}

/** The key of the hour from which supplier status polls slow down to every 30 minutes (decision 025). */
export const POLL_SLOW_AFTER_HOURS_KEY = 'orders.poll_slow_after_hours';

/**
 * Checks the value of `orders.poll_slow_after_hours`: a JSON integer from 1 to 8760.
 *
 * Why: decision 025: a sent order is polled every minute for an hour, every 5 minutes after, and every 30 minutes once it is older
 * than this many hours (default 24). The supplier poll tick reads it.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function pollSlowAfterHoursProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of hours.';
  if (value < 1 || value > 8760) return 'Use a number from 1 to 8760.';
  return undefined;
}

/** The key of the opt-out that lets suppliers be called over plain `http` in production (decision 023). */
export const SUPPLIERS_ALLOW_PLAIN_HTTP_KEY = 'suppliers.allowPlainHttp';

/**
 * Checks the value of `suppliers.allowPlainHttp`: a JSON boolean.
 *
 * Why: decision 023 and the infra notes: a supplier call needs `https` in production; a supplier that only speaks plain `http` needs an
 * admin-visible opt-out, and this setting is it (it applies to every supplier; the host still has to be a public address).
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function allowPlainHttpProblem(value: unknown): string | undefined {
  return typeof value === 'boolean' ? undefined : 'Use true or false.';
}

/** The key of the system-wide budget of campaign emails per second (feature 23). */
export const BROADCAST_EMAIL_PER_SECOND_KEY = 'notifications.broadcast_email_per_second';
/** The key of the system-wide budget of campaign Telegram messages per second (feature 23). */
export const BROADCAST_TELEGRAM_PER_SECOND_KEY = 'notifications.broadcast_telegram_per_second';
/** The default and the bounds of the two broadcast rates. */
export const BROADCAST_RATE_BOUNDS = { min: 1, max: 30 } as const;

/**
 * Checks the value of a broadcast rate (`notifications.broadcast_email_per_second`, `notifications.broadcast_telegram_per_second`): a
 * JSON integer from 1 to 30.
 *
 * Why: O8 (feature 23): campaign mail and Telegram leave at the rate the owner's providers allow (defaults 5 and 20 a second); the
 * ceiling is the bulk queue's limiter of 30 jobs a second, so a higher number would have no effect.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function broadcastRateProblem(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of messages per second.';
  if (value < BROADCAST_RATE_BOUNDS.min || value > BROADCAST_RATE_BOUNDS.max) return 'Use a number from 1 to 30.';
  return undefined;
}

/** The key of how long a read inbox item is kept (feature 23). */
export const INBOX_READ_RETENTION_DAYS_KEY = 'notifications.inbox_read_retention_days';
/** The key of how long any inbox item is kept (feature 23). */
export const INBOX_RETENTION_DAYS_KEY = 'notifications.inbox_retention_days';
/** The key of how long a `sent` or `failed` row of the notification log is kept (feature 23). */
export const LOG_RETENTION_DAYS_KEY = 'notifications.log_retention_days';

/** The default and the bounds of each notification retention setting (days): O6 of feature 23. */
export const NOTIFICATION_RETENTION = {
  inboxRead: { fallback: 90, min: 7, max: 3650 },
  inbox: { fallback: 365, min: 30, max: 3650 },
  // 30 days at least: the template list's "sent in the last 30 days" counts the log (`sentLast30Days`).
  log: { fallback: 180, min: 30, max: 3650 },
} as const;

const wholeDaysProblem = (value: unknown, min: number, max: number): string | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Use a whole number of days.';
  if (value < min || value > max) return `Use a number from ${min} to ${max}.`;
  return undefined;
};

/**
 * Checks `notifications.inbox_read_retention_days`: a JSON integer from 7 to 3650.
 *
 * Why: O6 (feature 23): a notification the person read is deleted after this many days (default 90) by the daily retention job.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function inboxReadRetentionDaysProblem(value: unknown): string | undefined {
  return wholeDaysProblem(value, NOTIFICATION_RETENTION.inboxRead.min, NOTIFICATION_RETENTION.inboxRead.max);
}

/**
 * Checks `notifications.inbox_retention_days`: a JSON integer from 30 to 3650.
 *
 * Why: O6 (feature 23): every inbox item, read or not, is deleted after this many days (default 365).
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function inboxRetentionDaysProblem(value: unknown): string | undefined {
  return wholeDaysProblem(value, NOTIFICATION_RETENTION.inbox.min, NOTIFICATION_RETENTION.inbox.max);
}

/**
 * Checks `notifications.log_retention_days`: a JSON integer from 30 to 3650.
 *
 * Why: O6 (feature 23): a sent or failed row of the notification log is deleted after this many days (default 180); the minimum of 30
 * keeps the template list's "sent in the last 30 days" whole.
 *
 * @param value the value as sent
 * @returns the problem, or `undefined` when the value is acceptable
 */
export function logRetentionDaysProblem(value: unknown): string | undefined {
  return wholeDaysProblem(value, NOTIFICATION_RETENTION.log.min, NOTIFICATION_RETENTION.log.max);
}

/**
 * The support chat settings (feature 28) with their defaults and accepted ranges: how many minutes an unseen email reply waits before it is
 * mailed (`0` mails at once) and how many days the attachments of a resolved ticket are kept (`0` keeps them).
 *
 * Why: rules 9 and 10 of plan 28; the owner kept the defaults (5 minutes, 180 days). The support module reads the same keys with
 * `SettingsReader.integer` and falls back to the default outside these ranges.
 */
export const SUPPORT_SETTINGS = {
  replyEmailDelayMinutes: { key: 'support.replyEmailDelayMinutes', fallback: 5, min: 0, max: 1440 },
  attachmentRetentionDays: { key: 'support.attachmentRetentionDays', fallback: 180, min: 0, max: 3650 },
} as const;

/**
 * The customer wallet settings (feature 21, plan § 5.8): two switches and six whole USD numbers, with their accepted ranges.
 *
 * Why: the owner's defaults (lead rule L5) are settings so they can change without a release; the money module's
 * `customerWalletPolicy` reads the same keys and falls back to its defaults outside these ranges. Every change is audited by the route.
 */
export const CUSTOMER_WALLET_SETTINGS = {
  enabled: 'wallet.customer.enabled',
  cardTopUps: 'wallet.customer.card_topups',
  minTopUp: 'wallet.customer.min_topup',
  maxTopUp: 'wallet.customer.max_topup',
  maxBalance: 'wallet.customer.max_balance',
  topUpsPerDay: 'wallet.customer.topups_per_day',
  topUpAmountPerDay: 'wallet.customer.topup_amount_per_day',
  adjustApprovalLimit: 'wallet.customer.adjust_approval_limit',
} as const;

/**
 * The accepted range of each whole-number customer wallet setting.
 *
 * Why: plan 21 § 5.8; the approval limit is capped at $10,000 (risk K7: who adjusts can also raise it).
 */
export const CUSTOMER_WALLET_SETTING_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  [CUSTOMER_WALLET_SETTINGS.minTopUp]: { min: 1, max: 10_000 },
  [CUSTOMER_WALLET_SETTINGS.maxTopUp]: { min: 1, max: 100_000 },
  [CUSTOMER_WALLET_SETTINGS.maxBalance]: { min: 1, max: 1_000_000 },
  [CUSTOMER_WALLET_SETTINGS.topUpsPerDay]: { min: 1, max: 100 },
  [CUSTOMER_WALLET_SETTINGS.topUpAmountPerDay]: { min: 1, max: 1_000_000 },
  [CUSTOMER_WALLET_SETTINGS.adjustApprovalLimit]: { min: 0, max: 10_000 },
};

/**
 * The exchange-rate guards (decision 049) with their defaults and accepted ranges: how far a refreshed rate may move from the stored one
 * before it is held for staff (whole percent), and how old a rate may be for the shop to charge in its currency (whole hours).
 *
 * Why: the owner tunes them without a release; the money module reads the same keys with `SettingsReader.integer` and falls back to the
 * default outside these ranges, so both guards can be loosened but never switched off.
 */
export const FX_GUARD_SETTINGS = {
  maxRefreshMovePercent: { key: 'fx.max_refresh_move_percent', fallback: 20, min: 1, max: 100 },
  maxRateAgeHours: { key: 'fx.max_rate_age_hours', fallback: 48, min: 1, max: 720 },
} as const;

/**
 * Builds the validator of a whole-number setting.
 *
 * @param min the smallest accepted value
 * @param max the largest accepted value
 * @param unit the word of the message (`dollars`, `top-ups`)
 * @returns a validator that accepts JSON integers from `min` to `max`
 */
export function wholeNumberProblem(min: number, max: number, unit: string): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `Use a whole number of ${unit}.`;
    if (value < min || value > max) return `Use a number from ${min} to ${max}.`;
    return undefined;
  };
}

const booleanProblem = (value: unknown): string | undefined =>
  typeof value === 'boolean' ? undefined : 'Use true or false.';

const walletRange = (key: string, unit: string): EditableSetting => {
  const range = CUSTOMER_WALLET_SETTING_RANGES[key]!;
  return { key, validate: wholeNumberProblem(range.min, range.max, unit) };
};

/**
 * The settings `PATCH /admin/settings` accepts. A later feature that needs another key editable here adds it with its
 * validator; the keys with their own guarded routes (`adminAllowlistOnly`, `maintenance`, the risk rules, the storefront
 * policies) are deliberately not here, so `settings:update` cannot bypass them (MISMATCHES B67).
 */
export const EDITABLE_SETTINGS: readonly EditableSetting[] = [
  { key: 'imeiRetentionDays', validate: imeiRetentionDaysProblem },
  { key: PRICE_CHANGE_TOLERANCE_KEY, validate: priceChangeTolerancePercentProblem },
  { key: IMPORT_DEFAULT_SLA_KEY, validate: importDefaultSlaMinutesProblem },
  { key: POLL_SLOW_AFTER_HOURS_KEY, validate: pollSlowAfterHoursProblem },
  // Decision 051: it lowers the protection of supplier calls, so only an Owner changes it.
  { key: SUPPLIERS_ALLOW_PLAIN_HTTP_KEY, validate: allowPlainHttpProblem, ownerOnly: true },
  { key: BROADCAST_EMAIL_PER_SECOND_KEY, validate: broadcastRateProblem },
  { key: BROADCAST_TELEGRAM_PER_SECOND_KEY, validate: broadcastRateProblem },
  { key: INBOX_READ_RETENTION_DAYS_KEY, validate: inboxReadRetentionDaysProblem },
  { key: INBOX_RETENTION_DAYS_KEY, validate: inboxRetentionDaysProblem },
  { key: LOG_RETENTION_DAYS_KEY, validate: logRetentionDaysProblem },
  { key: CUSTOMER_WALLET_SETTINGS.enabled, validate: booleanProblem },
  { key: CUSTOMER_WALLET_SETTINGS.cardTopUps, validate: booleanProblem },
  walletRange(CUSTOMER_WALLET_SETTINGS.minTopUp, 'dollars'),
  walletRange(CUSTOMER_WALLET_SETTINGS.maxTopUp, 'dollars'),
  walletRange(CUSTOMER_WALLET_SETTINGS.maxBalance, 'dollars'),
  walletRange(CUSTOMER_WALLET_SETTINGS.topUpsPerDay, 'top-ups'),
  walletRange(CUSTOMER_WALLET_SETTINGS.topUpAmountPerDay, 'dollars'),
  // Decision 049: it sets how much one staff member may credit to customers without a second person, so an Owner changes it.
  { ...walletRange(CUSTOMER_WALLET_SETTINGS.adjustApprovalLimit, 'dollars'), ownerOnly: true },
  {
    key: SUPPORT_SETTINGS.replyEmailDelayMinutes.key,
    validate: wholeNumberProblem(
      SUPPORT_SETTINGS.replyEmailDelayMinutes.min,
      SUPPORT_SETTINGS.replyEmailDelayMinutes.max,
      'minutes',
    ),
  },
  {
    key: SUPPORT_SETTINGS.attachmentRetentionDays.key,
    validate: wholeNumberProblem(
      SUPPORT_SETTINGS.attachmentRetentionDays.min,
      SUPPORT_SETTINGS.attachmentRetentionDays.max,
      'days',
    ),
  },
  // Decision 049: the two exchange-rate guards decide which rates the shop charges at, so an Owner changes them.
  {
    key: FX_GUARD_SETTINGS.maxRefreshMovePercent.key,
    validate: wholeNumberProblem(
      FX_GUARD_SETTINGS.maxRefreshMovePercent.min,
      FX_GUARD_SETTINGS.maxRefreshMovePercent.max,
      'percent',
    ),
    ownerOnly: true,
  },
  {
    key: FX_GUARD_SETTINGS.maxRateAgeHours.key,
    validate: wholeNumberProblem(FX_GUARD_SETTINGS.maxRateAgeHours.min, FX_GUARD_SETTINGS.maxRateAgeHours.max, 'hours'),
    ownerOnly: true,
  },
];

/** A refused key of a settings patch. */
export interface SettingProblem {
  readonly key: string;
  readonly message: string;
}

/**
 * Judges a settings patch against the registry.
 *
 * @param patch the flat object the client sent
 * @returns one problem per key that is not in the registry or whose value its validator refuses (empty when the patch is fine)
 */
export function settingsPatchProblems(patch: Readonly<Record<string, unknown>>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const setting = EDITABLE_SETTINGS.find((candidate) => candidate.key === key);
    if (!setting) {
      problems.push({ key, message: 'This setting cannot be changed here.' });
      continue;
    }
    const message = setting.validate(value);
    if (message) problems.push({ key, message });
  }
  return problems;
}

/**
 * The keys of a settings patch that only an Owner may change.
 *
 * Why: decisions 051 and 049: a setting that lowers the protection of supplier calls (`suppliers.allowPlainHttp`) or sets a limit on money
 * (`fx.max_refresh_move_percent`, `fx.max_rate_age_hours`, `wallet.customer.adjust_approval_limit`) is an Owner's decision, while the
 * route itself keeps `settings:update` (the console reads that permission).
 *
 * @param patch the flat object the client sent
 * @returns the patch's keys, in patch order, whose registry entry is marked `ownerOnly`
 */
export function ownerOnlySettingKeys(patch: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(patch).filter((key) =>
    EDITABLE_SETTINGS.some((setting) => setting.key === key && setting.ownerOnly === true),
  );
}
