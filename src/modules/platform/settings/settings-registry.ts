// The registry of settings that `PATCH /admin/settings` may write (RESOLUTIONS identity-platform-13): an allow-list, each key
// with its validator. Pure, so it is unit-tested; the route and `PATCH /admin/storefront/settings` share the validators.

/** One setting the generic settings route may change. */
export interface EditableSetting {
  /** The camelCase key as the console sends it. */
  readonly key: string;
  /** Checks a value; returns the sentence for the field, or `undefined` when the value is acceptable. */
  validate(value: unknown): string | undefined;
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
  { key: SUPPLIERS_ALLOW_PLAIN_HTTP_KEY, validate: allowPlainHttpProblem },
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
