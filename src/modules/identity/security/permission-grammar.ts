// The permission grammar of decision 018 (ALIGNMENT § 4): `area:action`, the wildcards `area:*` and `*`, and the rule that a
// required `area:*` needs `area:*` or `*`. Pure functions; the guards and the role routes share them.

/**
 * The wildcard that grants every permission (the Owner's).
 *
 * Why: an Owner is a staff member whose role contains `*` (decision 018, MISMATCHES B113).
 */
export const ALL_PERMISSIONS = '*';

/** `*:*` is accepted as a second spelling of `*` (ALIGNMENT § 4). */
const ALL_PERMISSIONS_LONG = '*:*';
const CONCRETE_OR_AREA_WILDCARD = /^[a-z][a-z0-9_]*:(?:\*|[a-z][a-z0-9_]*)$/;

/**
 * Tells whether a string is a well-formed permission: `*`, `*:*`, `area:*` or `area:action` (lower snake_case).
 *
 * Why: role routes (feature 2a) refuse malformed entries with `422`, and `defineRoute` shares the shape for the permission a
 * contract requires.
 *
 * @param value a permission string
 * @returns true when it is well formed
 */
export function isValidPermission(value: string): boolean {
  return value === ALL_PERMISSIONS || value === ALL_PERMISSIONS_LONG || CONCRETE_OR_AREA_WILDCARD.test(value);
}

/**
 * Tells whether a list of granted permissions includes the one that grants everything.
 *
 * Why: this is the Owner test; the guards of the last-Owner and Owner-target rules use it (decision 018).
 *
 * @param granted the permissions of a role
 * @returns true when the list holds `*` (or `*:*`)
 */
export function grantsEverything(granted: readonly string[]): boolean {
  return granted.includes(ALL_PERMISSIONS) || granted.includes(ALL_PERMISSIONS_LONG);
}

/**
 * Decides whether granted permissions cover a required one.
 *
 * Why: decision 018: a granted `area:*` covers every `area:` action, `*` covers everything, and a required `area:*` (the
 * literal permission of a route such as `PUT /admin/risk/rules`) needs `area:*` or `*`: a granted `risk:read` is not
 * enough. Checked on every request from the role's current permissions.
 *
 * @param granted the permissions of the caller's role
 * @param required the permission a route needs (`staff:read`, `risk:*`)
 * @returns true when the caller may proceed
 */
export function grants(granted: readonly string[], required: string): boolean {
  if (grantsEverything(granted)) return true;
  const colon = required.indexOf(':');
  const area = colon < 0 ? required : required.slice(0, colon);
  for (const permission of granted) {
    if (permission === required) return true;
    if (permission.endsWith(':*') && permission.slice(0, -2) === area) return true;
  }
  return false;
}
