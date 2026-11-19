// The second permissions of the publish routes (feature 31, plan 31 section 5.1): the guard checks the route's one permission, and the
// controller or the use case checks the other with `grants` (the three precedents of fact 16).
import { AppError } from '../../../../common/errors';

/** What a retail price needs: today's `PATCH /admin/service-listings/:id` asks for it, so the row's price keys do too. */
export const PRICE_PERMISSION = 'storefront:update';

/** What a publishing decision needs: apply, the run switch, and stopping a run that is publishing. */
export const PUBLISH_PERMISSION = 'storefront:publish';

/**
 * The refusal of a caller who lacks a permission, in the guard's words.
 *
 * Why: plan 31 section 5.1: `403 FORBIDDEN` names the missing permission, which the console shows; it never signs anyone out.
 *
 * @param permission the permission the caller needs
 * @returns the error to throw
 */
export function missingPermission(permission: string): AppError {
  return new AppError('FORBIDDEN', { detail: `You need the ${permission} permission to do this.` });
}
