// Pure rules of roles and the permission catalog: which entries a role may hold, and how the role editor labels them.
// No I/O, so the rules are unit-tested.
import { ALL_PERMISSIONS, isValidPermission } from '../security/permission-grammar';

/**
 * Cleans the permission list a client sent: trims, writes `*:*` as `*` and drops repeats, keeping the first order.
 *
 * Why: roles are "stored as given" (docs/contract/endpoints/identity.md), but two spellings of the same grant or a repeated
 * entry would only make the role editor and the Owner test harder to read.
 *
 * @param entries the permissions as sent
 * @returns the cleaned list
 */
export function cleanPermissions(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of entries) {
    const permission = entry.trim() === '*:*' ? ALL_PERMISSIONS : entry.trim();
    if (!seen.has(permission)) {
      seen.add(permission);
      cleaned.push(permission);
    }
  }
  return cleaned;
}

/**
 * Finds the entries a role may not hold.
 *
 * Why: `POST` and `PATCH /admin/roles` reject unknown keys or prefixes with `422` on `permissions` (identity.md). The catalog
 * lists concrete permissions only, so an area wildcard `area:*` is accepted when some catalog permission has that area, and `*`
 * is always accepted (the "Everything" switch of the role dialog).
 *
 * @param entries the cleaned permission list
 * @param catalog every concrete permission the registered routes require
 * @returns the entries that are malformed, not in the catalog, or a wildcard of an area nothing checks
 */
export function unknownPermissions(entries: readonly string[], catalog: readonly string[]): string[] {
  const known = new Set(catalog);
  const areas = new Set(catalog.map(areaOf));
  return entries.filter((entry) => {
    if (!isValidPermission(entry)) return true;
    if (entry === ALL_PERMISSIONS) return false;
    return entry.endsWith(':*') ? !areas.has(areaOf(entry)) : !known.has(entry);
  });
}

/**
 * The part of a permission before the colon (`staff` for `staff:read`).
 *
 * Why: a role may hold `x:*` for an area, so validation and labels group permissions by this prefix.
 *
 * @param permission a permission or an `area:*` wildcard
 * @returns the area, or the whole text when it has no colon
 */
export function areaOf(permission: string): string {
  const colon = permission.indexOf(':');
  return colon < 0 ? permission : permission.slice(0, colon);
}

/**
 * Words a permission for the role editor: the group is the area, the label the humanised action.
 *
 * Why: ANSWERS access Q4: `GET /admin/permissions` sends `{key, label, group}`; the console would derive the same values
 * when they are missing (`credit_limit` becomes `Credit limit`).
 *
 * @param key a concrete permission such as `wallet:credit_limit`
 * @returns the key, its group and its label
 */
export function describePermission(key: string): { key: string; label: string; group: string } {
  const colon = key.indexOf(':');
  const action = colon < 0 ? key : key.slice(colon + 1);
  const spaced = action.replace(/_/g, ' ').trim();
  return { key, label: spaced.charAt(0).toUpperCase() + spaced.slice(1), group: areaOf(key) };
}
