// PermissionsCatalog: every concrete permission the server checks, built from the route contracts so it never drifts.
// `GET /admin/permissions` (feature 2a) answers it and the role routes validate role permissions against it.
import { Injectable } from '@nestjs/common';
import { contractRegistry } from '../../../common/contract';

/**
 * The concrete permissions the registered routes require.
 *
 * Why: ALIGNMENT § 4: `GET /admin/permissions` answers the whole catalog as `string[]` of every concrete permission
 * the server checks, without wildcards (the role summary computes area levels from it), generated from the contract
 * registry. A permission nobody checks cannot be granted by mistake, and one that a route checks cannot be missing from
 * the role editor.
 */
@Injectable()
export class PermissionsCatalog {
  /**
   * Lists the concrete permissions.
   *
   * A route may require the literal area wildcard (`PUT /admin/risk/rules` needs `risk:*`). That string is a grant,
   * not a concrete permission, so the list leaves it out. A role still receives `risk:*` through the role editor's
   * area wildcard.
   *
   * @returns every distinct `area:action` permission of the registered contracts, sorted, without any `area:*`
   */
  list(): readonly string[] {
    const permissions = new Set<string>();
    for (const contract of contractRegistry.all()) {
      // `defineRoute` only accepts `area:action` and `area:*`, so a `:*` ending is the one wildcard shape to skip.
      if (contract.permission !== null && !contract.permission.endsWith(':*')) permissions.add(contract.permission);
    }
    return [...permissions].sort();
  }
}
