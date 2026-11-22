// The second permissions of the publish routes (feature 31, plan 31 section 5.1): the guard checks the route's one permission, and the
// controller or the use case checks the other with `grants` (the three precedents of fact 16). Decision 046 keeps the words in identity.

/**
 * What a retail price needs: the permission of the group price page, which `PATCH /admin/service-listings/:id` asks for too
 * (decision 046), so the row's price keys do as well.
 */
export const PRICE_PERMISSION = 'pricing:update';

/** What a publishing decision needs: apply, the run switch, and stopping a run that is publishing. */
export const PUBLISH_PERMISSION = 'storefront:publish';

/**
 * The refusal of a caller who lacks a permission, in the guard's words (one wording, written in identity: decision 046).
 *
 * Why: plan 31 section 5.1: `403 FORBIDDEN` names the missing permission, which the console shows; it never signs anyone out.
 */
export { missingPermission } from '../../../identity';
