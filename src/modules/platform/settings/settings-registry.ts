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

/**
 * The settings `PATCH /admin/settings` accepts. A later feature that needs another key editable here adds it with its
 * validator; the keys with their own guarded routes (`adminAllowlistOnly`, `maintenance`, the risk rules, the storefront
 * policies) are deliberately not here, so `settings:update` cannot bypass them (MISMATCHES B67).
 */
export const EDITABLE_SETTINGS: readonly EditableSetting[] = [
  { key: 'imeiRetentionDays', validate: imeiRetentionDaysProblem },
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
